/**
 * The one door into `occupancies`.
 *
 * Nothing in Bookrail writes a row of `occupancies` except {@link takeOccupancy}. That is not
 * tidiness, it is the whole safety argument. The capacity of a resource with capacity N is not
 * protected by a database constraint (the exclusion constraint `occ_no_overlap_cap1` only
 * covers capacity 1), so it is protected by a discipline: **take the advisory lock on every
 * resource you are about to touch, then verify, then insert, in that order, inside one
 * transaction**. A discipline that lives in a comment is a discipline that gets broken; the
 * booking transaction was written that way and `POST /v1/resources/{id}/block`,
 * three packages away, quietly wrote a block that pushed a resource of capacity three to four
 * units taken. Putting the discipline in a function makes hand
 * rolling an `INSERT INTO occupancies` something a reader can see is wrong.
 *
 * The function does, in order:
 *
 * 1. `pg_advisory_xact_lock` on every resource of `resourceIds`, ascending by id (the same
 *    order everywhere, which is why nothing deadlocks);
 * 2. the expired holds on those resources are swept, with their `hold.expired` events;
 * 3. the peak of `capacity_used` over the footprint is measured **after** the lock, which is
 *    authoritative under `read committed` and only there: a stricter isolation level would
 *    answer from the snapshot taken when the transaction opened, which predates the commit the
 *    lock was waiting for;
 * 4. the rows are written: inserted, or, for the conversion of a hold, rewritten in place.
 */
import { sql, type Transaction } from '@bookrail/db';
import { uuidv7, type Environment } from '@bookrail/shared';

import type { OccupancyKind } from '../availability/index.js';
import {
  expireStaleHolds,
  insertHoldExpiredEvent,
  lockResources,
  peakUsage,
  resourceCapacities,
} from './queries.js';
import { slotUnavailable } from './types.js';

/** One row to write: which resource, and how many of its units the caller takes. */
export interface OccupancyAllocation {
  readonly resourceId: string;
  readonly capacityUsed: number;
}

export interface TakeOccupancyRequest {
  readonly projectId: string;
  readonly environment: Environment;
  /**
   * Every resource the operation may touch. All of them are locked, so a caller that has
   * already narrowed its allocation may still pass the wider candidate set, which is exactly
   * what the booking transaction does, because it has to read under those locks.
   */
  readonly resourceIds: readonly string[];
  /** The rows to write. Every `resourceId` here must appear in {@link resourceIds}. */
  readonly allocations: readonly OccupancyAllocation[];
  /** The **core** period, without buffers: epoch milliseconds, half open. */
  readonly start: number;
  readonly end: number;
  readonly kind: OccupancyKind;
  /** The booking, hold or block the rows belong to. */
  readonly refId: string;
  /** Holds only. */
  readonly expiresAt?: number | null;
  /** Buffers the rows carry, in milliseconds. A block carries none. */
  readonly bufferBeforeMs?: number;
  readonly bufferAfterMs?: number;
  /** Read from the querying service; see `occupancyFootprint`. */
  readonly bufferSharing?: boolean;
  /**
   * Capacities the caller has already read in this transaction. Anything missing is read here,
   * so a caller that has no `AvailabilityData` (the block route) can simply omit it.
   */
  readonly capacities?: ReadonlyMap<string, number>;
  /**
   * Convert the occupancies of this reference instead of inserting new ones.
   *
   * A hold already owns its capacity: its rows are active and counted by every other
   * transaction, so verifying again would compare the hold with itself. The lock, the sweep
   * and the single door still apply; only the measurement is skipped, and only here.
   */
  readonly convertFrom?: string | null;
}

export interface TakenOccupancy {
  readonly id: string;
  readonly resourceId: string;
  readonly capacityUsed: number;
}

export interface TakeOccupancyResult {
  readonly occupancies: readonly TakenOccupancy[];
  /** Holds this call found expired and swept, with the `hold.expired` events it wrote. */
  readonly expiredHoldIds: readonly string[];
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export async function takeOccupancy(
  tx: Transaction,
  request: TakeOccupancyRequest,
): Promise<TakeOccupancyResult> {
  const locked = [...new Set(request.resourceIds)];
  await lockResources(tx, locked);

  const expired = await expireStaleHolds(tx, locked);
  for (const stale of expired) {
    await insertHoldExpiredEvent(tx, request.projectId, request.environment, stale);
  }

  const wanted = new Set(request.allocations.map((allocation) => allocation.resourceId));
  for (const id of wanted) {
    if (!locked.includes(id)) {
      throw new Error(
        `takeOccupancy would write resource ${id} without holding its lock; pass it in resourceIds.`,
      );
    }
  }

  const bufferBeforeMs = request.bufferBeforeMs ?? 0;
  const bufferAfterMs = request.bufferAfterMs ?? 0;

  if (request.convertFrom == null) {
    await assertCapacity(tx, request, [...wanted], bufferBeforeMs, bufferAfterMs);
  }

  const occupancies: TakenOccupancy[] = [];
  if (request.convertFrom != null) {
    const { rows } = await tx.execute<{
      id: string;
      resource_id: string;
      capacity_used: number;
    }>(sql`
      UPDATE occupancies
         SET kind = ${request.kind}, ref_id = ${request.refId},
             expires_at = ${request.expiresAt == null ? null : iso(request.expiresAt)}
       WHERE ref_id = ${request.convertFrom} AND active
      RETURNING id, resource_id, capacity_used
    `);
    for (const row of rows) {
      occupancies.push({
        id: row.id,
        resourceId: row.resource_id,
        capacityUsed: row.capacity_used,
      });
    }
    return { occupancies, expiredHoldIds: expired.map((hold) => hold.id) };
  }

  for (const allocation of request.allocations) {
    const id = uuidv7();
    await tx.execute(sql`
      INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                               kind, ref_id, expires_at, buffer_before_ms, buffer_after_ms)
      VALUES (${id}, ${request.projectId}, ${request.environment}, ${allocation.resourceId},
              tstzrange(${iso(request.start)}, ${iso(request.end)}, '[)'),
              ${allocation.capacityUsed}, ${request.kind}, ${request.refId},
              ${request.expiresAt == null ? null : iso(request.expiresAt)},
              ${bufferBeforeMs}, ${bufferAfterMs})
    `);
    occupancies.push({
      id,
      resourceId: allocation.resourceId,
      capacityUsed: allocation.capacityUsed,
    });
  }
  return { occupancies, expiredHoldIds: expired.map((hold) => hold.id) };
}

export interface ReleaseOccupancyRequest {
  /**
   * The booking, hold or block whose rows go inactive.
   */
  readonly refId: string;
  /** Restricts the release to one kind; omit to release whatever the reference owns. */
  readonly kind?: OccupancyKind;
}

/** One row this release deactivated, with the period it used to hold. */
export interface ReleasedOccupancy {
  readonly id: string;
  readonly resourceId: string;
  readonly capacityUsed: number;
  /** The **core** period the row held, epoch milliseconds. Names the days the cache loses. */
  readonly start: number;
  readonly end: number;
}

/**
 * The other door: giving capacity back.
 *
 * `takeOccupancy` is the only way a row of `occupancies` is written; this is the only way one
 * stops holding capacity. The two are in the same module for the same reason: a release that
 * did not take the advisory lock first could interleave with a capacity check that had already
 * measured the peak, and the booking that check let through would be measured against a state
 * that no longer existed by the time it wrote.
 *
 * The rows are read **after** the lock and before the update: once `active` is false the
 * period is no longer selectable, and the period is what names the local days whose
 * availability cache the caller has to drop.
 *
 * Nothing is deleted. An occupancy is a fact about a period of time, and `active = false` is
 * how it stops counting; the row stays as the record that it once did.
 */
export async function releaseOccupancies(
  tx: Transaction,
  request: ReleaseOccupancyRequest,
): Promise<readonly ReleasedOccupancy[]> {
  const { rows: held } = await tx.execute<{ resource_id: string }>(sql`
    SELECT DISTINCT resource_id FROM occupancies
     WHERE ref_id = ${request.refId} AND active
       AND (${request.kind ?? null}::text IS NULL OR kind = ${request.kind ?? null})
  `);
  if (held.length === 0) return [];
  await lockResources(
    tx,
    held.map((row) => row.resource_id),
  );

  const { rows } = await tx.execute<{
    id: string;
    resource_id: string;
    capacity_used: number;
    starts_ms: string;
    ends_ms: string;
  }>(sql`
    UPDATE occupancies SET active = false
     WHERE ref_id = ${request.refId} AND active
       AND (${request.kind ?? null}::text IS NULL OR kind = ${request.kind ?? null})
    RETURNING id, resource_id, capacity_used,
              (extract(epoch FROM lower(period)) * 1000)::bigint AS starts_ms,
              (extract(epoch FROM upper(period)) * 1000)::bigint AS ends_ms
  `);
  return rows.map((row) => ({
    id: row.id,
    resourceId: row.resource_id,
    capacityUsed: row.capacity_used,
    start: Number(row.starts_ms),
    end: Number(row.ends_ms),
  }));
}

/**
 * `usata + richiesta <= capacity`, per resource, on the peak over the footprint.
 *
 * The footprint is the core period widened by the caller's own buffers; what each existing
 * occupancy takes away from it is decided by *its* buffers and by `buffer_sharing`, in SQL,
 * exactly as `occupancyFootprint` decides it in memory.
 */
async function assertCapacity(
  tx: Transaction,
  request: TakeOccupancyRequest,
  resourceIds: readonly string[],
  bufferBeforeMs: number,
  bufferAfterMs: number,
): Promise<void> {
  const capacities = request.capacities ?? (await resourceCapacities(tx, resourceIds));
  const usage = await peakUsage(tx, {
    resourceIds,
    from: request.start - bufferBeforeMs,
    to: request.end + bufferAfterMs,
    bufferBeforeMs,
    bufferAfterMs,
    bufferSharing: request.bufferSharing ?? false,
  });
  for (const allocation of request.allocations) {
    const capacity = capacities.get(allocation.resourceId);
    if (capacity === undefined) {
      throw new Error(
        `takeOccupancy does not know the capacity of resource ${allocation.resourceId}.`,
      );
    }
    const used = usage.get(allocation.resourceId) ?? 0;
    if (used + allocation.capacityUsed > capacity) {
      throw slotUnavailable(
        allocation.capacityUsed,
        Math.max(0, capacity - used),
        `Resource ${allocation.resourceId} has ${String(used)} of ${String(capacity)} units taken.`,
      );
    }
  }
}
