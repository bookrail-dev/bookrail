/**
 * The periodic sweep of expired holds, run by the background scheduler.
 *
 * **Correctness does not depend on this running.** Every capacity query already ignores an
 * occupancy whose `expires_at` has passed, and `takeOccupancy` sweeps the expired holds of
 * the resources it locks before it writes anything. What the sweep buys is the three things
 * a lazy cleanup cannot give:
 *
 * 1. `occ_no_overlap_cap1` looks at `active` and not at `expires_at`, so on a resource of
 *    capacity 1 an expired hold that nobody has swept still refuses the next booking (the
 *    database contradicting the engine) until some other transaction happens to lock that
 *    resource;
 * 2. `hold.expired` reaches the webhook consumer near the moment it happened, not the next
 *    time somebody books that room, and an expiry is a state change like any other, so it owes
 *    exactly one event;
 * 3. the availability cache is dropped for the days the hold occupied, so the slot comes back
 *    on the next request instead of after the entry's TTL.
 *
 * It runs inside the same discipline as every other writer: the resources are locked in
 * ascending order of id **before** anything about them is read, and only then are their rows
 * touched. The transaction is scoped to one project and environment and runs as the
 * application role, so Row Level Security is between this code and the data exactly as it is
 * on the request path: the job has no privilege the API does not have. Finding *which*
 * projects have work to do is a cross-project question and therefore not asked here; the
 * caller answers it (see `packages/api/src/jobs/`).
 */
import type { Database } from '@bookrail/db';
import { sql, type Transaction } from '@bookrail/db';
import type { Environment } from '@bookrail/shared';

import { runBookingTransaction } from './create.js';
import {
  assertApplicationRole,
  expireStaleHolds,
  insertHoldExpiredEvent,
  lockResources,
  type ExpiredHold,
} from './queries.js';
import { resourceZones, touchedDaysOf } from './touched.js';
import type { TouchedDay } from './types.js';

/** How many holds one call sweeps. Keeps the lock set, and the transaction, bounded. */
export const DEFAULT_EXPIRY_BATCH = 100;

export interface ExpireHoldsInput {
  readonly projectId: string;
  readonly environment: Environment;
  /** Ceiling on the holds one call takes on. Defaults to {@link DEFAULT_EXPIRY_BATCH}. */
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly isolationLevel?: 'read committed' | 'serializable';
}

export interface ExpiredHoldResult extends ExpiredHold {
  /** The `hold.expired` row written in the same transaction. */
  readonly eventId: string;
}

export interface ExpireHoldsResult {
  readonly expired: readonly ExpiredHoldResult[];
  /** For the caller's `invalidateResourceDay`, after the commit. */
  readonly touchedDays: readonly TouchedDay[];
  /**
   * True when the batch was full, so there is probably more to do straight away. The caller
   * may loop instead of waiting for the next tick.
   */
  readonly more: boolean;
}

interface DueOccupancy {
  readonly refId: string;
  readonly resourceId: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

export async function expireHolds(
  db: Database,
  input: ExpireHoldsInput,
): Promise<ExpireHoldsResult> {
  const batchSize = input.batchSize ?? DEFAULT_EXPIRY_BATCH;
  return runBookingTransaction(
    db,
    { projectId: input.projectId, environment: input.environment },
    {
      maxRetries: input.maxRetries ?? 3,
      isolationLevel: input.isolationLevel ?? 'read committed',
    },
    async (tx) => {
      await assertApplicationRole(tx);

      // The holds to work on are named by their **occupancies**, not by `holds.status`: an
      // occupancy that is still active is the only thing that actually holds capacity, and a
      // hold left `active` by a partial sweep (see `expireStaleHolds`) is found this way too.
      const due = await dueHoldIds(tx, batchSize);
      if (due.length === 0) return { expired: [], touchedDays: [], more: false };

      const resources = await resourcesOf(tx, due);
      // Lock, then read what the lock protects. `expireStaleHolds` widens the work to every
      // expired hold on these resources, which is safe precisely because they are all locked.
      await lockResources(tx, resources);
      const occupancies = await dueOccupanciesOn(tx, resources);

      const expired = await expireStaleHolds(tx, resources);
      const results: ExpiredHoldResult[] = [];
      for (const hold of expired) {
        const eventId = await insertHoldExpiredEvent(tx, input.projectId, input.environment, hold);
        results.push({ ...hold, eventId });
      }

      const zones = await resourceZones(tx, resources);
      const touchedDays: TouchedDay[] = [];
      for (const occupancy of occupancies) {
        touchedDays.push(
          ...touchedDaysOf(
            [{ resourceId: occupancy.resourceId }],
            zones,
            occupancy.startsAt,
            occupancy.endsAt,
          ),
        );
      }

      return { expired: results, touchedDays, more: due.length >= batchSize };
    },
  );
}

/** The holds whose occupancies are still active although their time is up. */
async function dueHoldIds(tx: Transaction, batchSize: number): Promise<string[]> {
  const { rows } = await tx.execute<{ ref_id: string }>(sql`
    SELECT DISTINCT ref_id
      FROM occupancies
     WHERE kind = 'hold' AND active AND expires_at <= now()
     ORDER BY ref_id
     LIMIT ${batchSize}
  `);
  return rows.map((row) => row.ref_id);
}

async function resourcesOf(tx: Transaction, holdIds: readonly string[]): Promise<string[]> {
  const { rows } = await tx.execute<{ resource_id: string }>(sql`
    SELECT DISTINCT resource_id
      FROM occupancies
     WHERE ref_id = ANY(${sql.param([...holdIds])}::uuid[]) AND kind = 'hold' AND active
     ORDER BY resource_id
  `);
  return rows.map((row) => row.resource_id);
}

/**
 * Every expired hold occupancy on the locked resources, read **after** the lock and before
 * the sweep deactivates them: once `active` is false the period is no longer selectable, and
 * the period is what names the local days the cache has to lose.
 */
async function dueOccupanciesOn(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<DueOccupancy[]> {
  if (resourceIds.length === 0) return [];
  const { rows } = await tx.execute<{
    ref_id: string;
    resource_id: string;
    starts_ms: string;
    ends_ms: string;
  }>(sql`
    SELECT ref_id, resource_id,
           (extract(epoch FROM lower(period)) * 1000)::bigint AS starts_ms,
           (extract(epoch FROM upper(period)) * 1000)::bigint AS ends_ms
      FROM occupancies
     WHERE resource_id = ANY(${sql.param([...resourceIds])}::uuid[])
       AND kind = 'hold' AND active AND expires_at <= now()
  `);
  return rows.map((row) => ({
    refId: row.ref_id,
    resourceId: row.resource_id,
    startsAt: Number(row.starts_ms),
    endsAt: Number(row.ends_ms),
  }));
}
