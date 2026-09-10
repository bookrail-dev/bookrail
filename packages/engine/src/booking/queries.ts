/**
 * Every statement the booking transaction sends, in one place.
 *
 * They all run inside `withProjectContext`, so Row Level Security is between this module and
 * the data exactly as it is in production: a bug here cannot reach another project's rows.
 * {@link assertApplicationRole} makes sure of the other half: that the connection is not a
 * superuser, which would make the policies decorative.
 */
import { sql, type Transaction } from '@bookrail/db';
import { encodeId, errors, BookrailError, uuidv7 } from '@bookrail/shared';

/**
 * Padding applied to the window the capacity query looks at.
 *
 * An occupancy whose core period sits outside the footprint can still reach into it with its
 * buffers, and migration 0009 caps those at 24 hours; 25 hours of slack therefore brackets
 * every row that could matter, and keeps the query on the GiST index of
 * `(resource_id, period)` instead of scanning the resource's whole history.
 */
const BUFFER_PAD_MS = 25 * 60 * 60 * 1000;

function iso(at: number): string {
  return new Date(at).toISOString();
}

/**
 * Connections whose role has already been checked and found to be the application one.
 *
 * A `WeakSet` and not a counter: the key is the pooled `pg` client object itself, so an entry
 * disappears exactly when the connection does, and a pool that opens a new connection gets a
 * new check. The role of a live connection cannot change (nothing in the system issues
 * `SET ROLE`), so one answer per connection is the whole truth, and the round trip per
 * *transaction* the check used to cost was paid for a fact that never moves. The memoization
 * depends on the driver exposing that client: when it does not, {@link connectionKey} returns
 * `null`, and the check falls back to one round trip per transaction.
 *
 * A connection that fails the check is never added, so a superuser connection is refused every
 * single time, not just the first.
 */
const verifiedConnections = new WeakSet<object>();

/** Test-only: how many times the check actually reached the database. */
let roleChecksRun = 0;

/** Test-only. Lets the memoization be asserted instead of assumed. */
export function applicationRoleChecksRun(): number {
  return roleChecksRun;
}

/**
 * The `pg` client the transaction is running on, when Drizzle is willing to say.
 *
 * Reaching into `session.client` is reaching into somebody's implementation, so the result is
 * treated as a hint: `null` means "no key", which means the check runs, which is the behaviour
 * this function has always had. Memoization that silently stops memoizing is a slower system;
 * memoization that silently stops checking would be a hole.
 */
function connectionKey(tx: Transaction): object | null {
  const session = (tx as unknown as { session?: { client?: unknown } }).session;
  const client = session?.client;
  return typeof client === 'object' && client !== null ? client : null;
}

/**
 * Refuses to run as a role that Row Level Security does not apply to.
 *
 * The booking transaction is the one place where a mistake writes rather than reads, and the
 * migrations create `bookrail_app` NOSUPERUSER NOBYPASSRLS precisely so that the database,
 * and not this code, decides which project a statement can touch. A superuser connection,
 * the one that runs the migrations and `POST /internal/bootstrap`, would bypass all of it
 * silently. `pg_roles` is world readable, so this costs one round trip and no privilege, and
 * it costs it once per connection rather than once per transaction.
 */
export async function assertApplicationRole(tx: Transaction): Promise<void> {
  const key = connectionKey(tx);
  if (key !== null && verifiedConnections.has(key)) return;
  roleChecksRun += 1;
  const { rows } = await tx.execute<{
    role: string;
    is_super: boolean;
    bypasses_rls: boolean;
  }>(sql`
    SELECT current_user AS role, r.rolsuper AS is_super, r.rolbypassrls AS bypasses_rls
      FROM pg_roles r
     WHERE r.rolname = current_user
  `);
  const row = rows[0];
  if (row === undefined) {
    throw errors.internal('Could not determine the database role of the booking transaction.');
  }
  if (row.is_super || row.bypasses_rls) {
    throw new BookrailError(
      'internal',
      'privileged_connection',
      `The booking transaction must run as the application role, not as ${row.role}, which bypasses row level security.`,
    );
  }
  if (key !== null) verifiedConnections.add(key);
}

/**
 * Takes one transaction-scoped advisory lock per resource, in ascending order of id.
 *
 * One statement per resource, on purpose: the order in which Postgres evaluates several
 * function calls of one target list is not defined, and the whole point of this loop is that
 * every transaction of the system takes the same locks in the same order and therefore never
 * deadlocks, however many resources a service composes.
 *
 * The key is a 64 bit hash of the resource UUID. UUIDs are globally unique, so the lock space
 * needs no project prefix; a hash collision between two resources would only make two
 * unrelated bookings wait for each other, never let them through.
 */
export async function lockResources(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<void> {
  for (const id of [...resourceIds].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 0))`);
  }
}

/**
 * The transaction-scoped advisory lock that serialises one customer's bookings.
 *
 * `max_active_bookings_per_customer` was read inside the transaction and compared with the
 * limit, with nothing holding the answer still: two bookings of the same customer on
 * **disjoint** resources share no resource lock, so both could count two, both could decide two
 * was under three, and the customer could end up with four. The policy states a limit, not an
 * approximation, so under contention it has to be one.
 *
 * Same family as {@link lockResources} (`pg_advisory_xact_lock` on a 64 bit hash of a UUID,
 * released by COMMIT or ROLLBACK), with **seed 1** instead of 0, so a customer id and a resource
 * id are hashed by two different functions and do not systematically collide. Two different
 * seeds are not two disjoint spaces: a chance collision between a customer key and a resource
 * key remains possible at about 2⁻⁶⁴, and its only effect would be two unrelated transactions
 * waiting on each other, exactly as {@link lockResources} says of two resources.
 *
 * The order is always resources first, customer second (see `create.ts`), so two transactions
 * that need both can queue but cannot deadlock. It is taken only when the policy actually
 * defines a limit: a project without one pays nothing.
 */
export async function lockCustomer(tx: Transaction, customerId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${customerId}::text, 1))`);
}

/**
 * How many bookings of this customer are still counting against the policy limit.
 *
 * The same predicate `loadAvailabilityData` uses for `customerActiveBookings`, deliberately:
 * "active" is `pending` or `confirmed` **and not over yet**, so a confirmed booking from 2020
 * that no job ever completed does not block the customer for the rest of time. The read side and
 * the write side answering the same question differently would be worse than either answer
 * being wrong.
 *
 * Read **after** {@link lockCustomer}, never before: the count the decision rests on has to be
 * the one the lock protects.
 */
export async function activeBookingCount(tx: Transaction, customerId: string): Promise<number> {
  const { rows } = await tx.execute<{ active: string }>(sql`
    SELECT count(*)::text AS active
      FROM bookings
     WHERE customer_id = ${customerId}
       AND status IN ('pending', 'confirmed')
       AND ends_at > now()
  `);
  return Number(rows[0]?.active ?? 0);
}

/**
 * The resources the service could possibly allocate, before anything else is read.
 *
 * The advisory locks have to be taken **before** the occupancies are read, and that needs the
 * candidate set: this is the cheapest query that produces it. It reads the catalogue only
 * (requirements, group members, resources), which the booking path never writes, so it costs
 * one round trip and contends with nothing.
 */
export async function candidateResourceIds(tx: Transaction, serviceId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT r.id
      FROM service_requirements sr
      LEFT JOIN resource_group_members m ON m.resource_group_id = sr.resource_group_id
      JOIN resources r ON r.id = COALESCE(sr.resource_id, m.resource_id)
     WHERE sr.service_id = ${serviceId}
       AND r.status = 'active'
       AND r.deleted_at IS NULL
     ORDER BY r.id
  `);
  return rows.map((row) => row.id);
}

/**
 * Deactivates the occupancies of every hold **on these resources** that has already expired.
 *
 * An expired hold occupies nothing the instant it expires, and the capacity query honours that
 * with `expires_at > now()`. The exclusion constraint `occ_no_overlap_cap1` does **not**: it
 * looks at `active` alone, so on a resource of capacity 1 a hold that expired a second ago would
 * keep refusing every new booking until the sweeper got round to it: the database would be
 * contradicting the engine.
 *
 * **This is not an optimisation, it is what makes the two clocks safe.** `expires_at` is
 * compared with Postgres's `now()` here and in every capacity query, while the caller's
 * `input.now` is a JavaScript instant; the two can disagree by the usual skew. Because the
 * sweep runs under the same advisory lock as the insert that follows, an expired hold is
 * always out of the way of the row about to be written, whichever clock said so first.
 *
 * The `UPDATE` is restricted to the locked resources: the engine
 * writes only what it has locked, with no exception. A hold spanning a resource this
 * transaction never locked therefore keeps that occupancy active (harmless, because
 * `expires_at` already excludes it from every capacity computation), and the hold is left
 * `active` for the periodic sweeper to finish. It is marked `expired` here only
 * when nothing of it is left active, so the job can still find the ones this call could not
 * complete.
 *
 * Returns the holds that were expired, so the caller can write their `hold.expired` events in
 * the same transaction: one event per state change, and no state change without its event.
 */
export async function expireStaleHolds(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<ExpiredHold[]> {
  if (resourceIds.length === 0) return [];
  const ids = sql.param([...resourceIds]);
  const { rows } = await tx.execute<{ ref_id: string }>(sql`
    SELECT DISTINCT ref_id
      FROM occupancies
     WHERE resource_id = ANY(${ids}::uuid[])
       AND kind = 'hold' AND active AND expires_at <= now()
  `);
  const holdIds = rows.map((row) => row.ref_id);
  if (holdIds.length === 0) return [];
  const held = sql.param(holdIds);
  await tx.execute(sql`
    UPDATE occupancies SET active = false
     WHERE ref_id = ANY(${held}::uuid[]) AND kind = 'hold' AND active
       AND resource_id = ANY(${ids}::uuid[])
  `);
  const { rows: expired } = await tx.execute<{
    id: string;
    service_id: string;
    starts_ms: string;
    ends_ms: string;
  }>(sql`
    UPDATE holds h SET status = 'expired'
     WHERE h.id = ANY(${held}::uuid[]) AND h.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM occupancies o
                        WHERE o.ref_id = h.id AND o.kind = 'hold' AND o.active)
    RETURNING h.id, h.service_id,
              (extract(epoch FROM h.starts_at) * 1000)::bigint AS starts_ms,
              (extract(epoch FROM h.ends_at) * 1000)::bigint AS ends_ms
  `);
  return expired.map((row) => ({
    id: row.id,
    serviceId: row.service_id,
    startsAt: Number(row.starts_ms),
    endsAt: Number(row.ends_ms),
  }));
}

/**
 * Which of these resource ids the current project can see at all.
 *
 * Row Level Security makes a resource of another project indistinguishable from one that
 * never existed, which is exactly the point: this tells "not there" from "there but not a
 * candidate of this service", and nothing else.
 */
export async function liveResourceIds(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (resourceIds.length === 0) return found;
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM resources WHERE id = ANY(${sql.param([...resourceIds])}::uuid[])
  `);
  for (const row of rows) found.add(row.id);
  return found;
}

/** `resources.capacity`, for a caller that has not already read it. */
export async function resourceCapacities(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<Map<string, number>> {
  const capacities = new Map<string, number>();
  if (resourceIds.length === 0) return capacities;
  const { rows } = await tx.execute<{ id: string; capacity: number }>(sql`
    SELECT id, capacity FROM resources WHERE id = ANY(${sql.param([...resourceIds])}::uuid[])
  `);
  for (const row of rows) capacities.set(row.id, row.capacity);
  return capacities;
}

/**
 * The write half of the transactional outbox.
 *
 * The event is written by the same transaction that writes the row it describes, so there is
 * no state in which one exists without the other: a rollback takes the event with it, and every
 * state change owes exactly one event. Delivery is somebody else's problem.
 */
export async function insertEvent(
  tx: Transaction,
  projectId: string,
  environment: string,
  type: string,
  data: Record<string, unknown>,
  options: EventOptions = {},
): Promise<string> {
  const id = uuidv7();
  const previous = options.previous ?? null;
  const actor = options.actor ?? null;
  await tx.execute(sql`
    INSERT INTO events (id, project_id, environment, type, data, previous, actor, occurred_at)
    VALUES (${id}, ${projectId}, ${environment}, ${type}, ${JSON.stringify(data)}::jsonb,
            ${previous === null ? null : JSON.stringify(previous)}::jsonb,
            ${actor === null ? null : JSON.stringify(actor)}::jsonb,
            COALESCE(${options.occurredAt === undefined ? null : iso(options.occurredAt)}::timestamptz,
                     now()))
  `);
  return id;
}

/**
 * Who did it, and what the object looked like before.
 *
 * `occurredAt` exists so that a transition driven by an injected clock (every automatic
 * transition, and every test of one) records the instant it was evaluated at rather than the
 * instant the row happened to be written. `null` falls back to the column's `now()`.
 */
export interface EventOptions {
  readonly previous?: Record<string, unknown> | null;
  readonly actor?: Record<string, unknown> | null;
  readonly occurredAt?: number;
}

/** One expired hold, as {@link expireStaleHolds} and the expiry job report it. */
export interface ExpiredHold {
  readonly id: string;
  readonly serviceId: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * The `hold.expired` event, written by the two places that can notice an expiry: the sweep
 * inside `takeOccupancy` and the periodic job. One function so the payload of an event that
 * lands in an append-only table cannot come out in two shapes.
 */
export async function insertHoldExpiredEvent(
  tx: Transaction,
  projectId: string,
  environment: string,
  hold: ExpiredHold,
): Promise<string> {
  return insertEvent(tx, projectId, environment, 'hold.expired', {
    id: encodeId('hold', hold.id),
    object: 'hold',
    service_id: encodeId('service', hold.serviceId),
    status: 'expired',
    start: iso(hold.startsAt),
    end: iso(hold.endsAt),
  });
}

export interface FootprintQuery {
  readonly resourceIds: readonly string[];
  /** The new booking's footprint: core period widened by its own buffers. */
  readonly from: number;
  readonly to: number;
  /** Buffers of the service now asking, in milliseconds. */
  readonly bufferBeforeMs: number;
  readonly bufferAfterMs: number;
  readonly bufferSharing: boolean;
}

/**
 * The largest number of units taken at **any single instant** of the footprint, per resource.
 *
 * The obvious query is a `SUM(capacity_used)` over the footprint. A plain sum
 * over the whole interval is an over-approximation, and a wrong one where it matters: a two
 * hour booking on a resource of capacity two, with one occupancy in the first hour and
 * another in the second, sums to two and is refused, while at no instant is more than one
 * unit taken. That is a slot the availability engine offers (its residual timeline is
 * pointwise), so a sum would make the read and the write disagree, which is worse than either
 * being wrong on its own. The query therefore walks the boundaries of the footprints and
 * takes the running maximum, which is the same number `minCapacityOver` subtracts from the
 * capacity on the read side.
 *
 * The footprint of an existing occupancy is its own period widened by its **own** buffers
 * (migration 0009), reduced by the querying service's buffers when `buffer_sharing` is on. That
 * arithmetic used to be written out here, a third time; since migration 0014 it is the SQL
 * function `occupancy_footprint`, which is also what `peakUsagePerPeriod` and the capacity
 * trigger call, and which a property test holds against `occupancyFootprint` in TypeScript on
 * random inputs. Three copies of the rule that decides whether a booking is accepted was two
 * too many.
 */
export async function peakUsage(
  tx: Transaction,
  query: FootprintQuery,
): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  if (query.resourceIds.length === 0) return used;
  const shareLeft = query.bufferSharing ? query.bufferAfterMs : 0;
  const shareRight = query.bufferSharing ? query.bufferBeforeMs : 0;
  const { rows } = await tx.execute<{ resource_id: string; used: number }>(sql`
    WITH win AS (
      SELECT ${iso(query.from)}::timestamptz AS f, ${iso(query.to)}::timestamptz AS t
    ), fp AS (
      SELECT o.resource_id,
             o.capacity_used,
             lower(occupancy_footprint(o.period, o.kind, o.buffer_before_ms, o.buffer_after_ms,
                                       ${shareLeft}::int, ${shareRight}::int)) AS s,
             upper(occupancy_footprint(o.period, o.kind, o.buffer_before_ms, o.buffer_after_ms,
                                       ${shareLeft}::int, ${shareRight}::int)) AS e
        FROM occupancies o
       WHERE o.resource_id = ANY(${sql.param(query.resourceIds)}::uuid[])
         AND o.active
         AND (o.expires_at IS NULL OR o.expires_at > now())
         AND o.period && tstzrange(${iso(query.from - BUFFER_PAD_MS)},
                                   ${iso(query.to + BUFFER_PAD_MS)}, '[)')
    ), ev AS (
      SELECT fp.resource_id, GREATEST(fp.s, win.f) AS at, fp.capacity_used AS delta
        FROM fp CROSS JOIN win WHERE fp.s < win.t AND fp.e > win.f
      UNION ALL
      SELECT fp.resource_id, LEAST(fp.e, win.t), -fp.capacity_used
        FROM fp CROSS JOIN win WHERE fp.s < win.t AND fp.e > win.f
    ), run AS (
      -- ORDER BY at, delta is load bearing, not cosmetic: at one instant the closes (delta
      -- negative) have to be applied before the opens, which is exactly what a half open
      -- [start, end) period means. Reversing it would count two occupancies that merely
      -- touch (one ending at ten, the next starting at ten) as overlapping.
      SELECT resource_id,
             SUM(delta) OVER (PARTITION BY resource_id ORDER BY at, delta
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
        FROM ev
    )
    SELECT resource_id, MAX(running)::int AS used FROM run GROUP BY resource_id
  `);
  for (const row of rows) used.set(row.resource_id, row.used);
  return used;
}

/**
 * `SUM(capacity_used)` over each resource's **local day**, for `least_busy`.
 *
 * "Busy" is a property of the day, not of the slot, so this is a sum and not a peak: a
 * resource with three one hour bookings is busier than one with a single one, whatever the
 * overlaps. Every resource gets its own day range because a group may span zones.
 */
export async function dayUsage(
  tx: Transaction,
  days: readonly { resourceId: string; from: number; to: number }[],
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  if (days.length === 0) return usage;
  const { rows } = await tx.execute<{ resource_id: string; used: number }>(sql`
    SELECT t.rid AS resource_id, COALESCE(SUM(o.capacity_used), 0)::int AS used
      FROM unnest(${sql.param(days.map((d) => d.resourceId))}::uuid[],
                  ${sql.param(days.map((d) => iso(d.from)))}::timestamptz[],
                  ${sql.param(days.map((d) => iso(d.to)))}::timestamptz[]) AS t(rid, dfrom, dto)
      LEFT JOIN occupancies o
             ON o.resource_id = t.rid
            AND o.active
            AND (o.expires_at IS NULL OR o.expires_at > now())
            AND o.period && tstzrange(t.dfrom, t.dto, '[)')
     GROUP BY t.rid
  `);
  for (const row of rows) usage.set(row.resource_id, row.used);
  return usage;
}

export interface PolicyRow {
  readonly id: string;
  readonly holdDurationSeconds: number;
  readonly requiresConfirmation: boolean;
  readonly snapshot: Record<string, unknown>;
}

/**
 * The policy of the service, with the frozen copy that goes into `bookings.policy_snapshot`.
 *
 * The snapshot is the whole row minus the scoping and bookkeeping columns: a booking keeps the
 * policy it was made under, and the safest way to keep it is not to choose which fields will
 * matter in two years.
 */
export async function loadPolicy(tx: Transaction, policyId: string): Promise<PolicyRow | null> {
  const { rows } = await tx.execute<{
    id: string;
    hold_duration_seconds: number;
    requires_confirmation: boolean;
    snapshot: Record<string, unknown>;
  }>(sql`
    SELECT p.id,
           p.hold_duration_seconds,
           (p.require_customer_confirmation OR p.require_provider_confirmation)
             AS requires_confirmation,
           (to_jsonb(p) - 'project_id' - 'environment' - 'created_at' - 'updated_at') AS snapshot
      FROM policies p
     WHERE p.id = ${policyId}
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    holdDurationSeconds: row.hold_duration_seconds,
    requiresConfirmation: row.requires_confirmation,
    snapshot: row.snapshot,
  };
}

/** `resource_groups.round_robin_cursor` for the groups a request may allocate from. */
export async function loadGroupCursors(
  tx: Transaction,
  groupIds: readonly string[],
): Promise<Map<string, string | null>> {
  const cursors = new Map<string, string | null>();
  if (groupIds.length === 0) return cursors;
  const { rows } = await tx.execute<{ id: string; round_robin_cursor: string | null }>(sql`
    SELECT id, round_robin_cursor
      FROM resource_groups
     WHERE id = ANY(${sql.param(groupIds)}::uuid[])
  `);
  for (const row of rows) cursors.set(row.id, row.round_robin_cursor);
  return cursors;
}

export async function setRoundRobinCursor(
  tx: Transaction,
  groupId: string,
  resourceId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE resource_groups SET round_robin_cursor = ${resourceId} WHERE id = ${groupId}
  `);
}

export interface HoldRow {
  readonly id: string;
  readonly serviceId: string;
  readonly customerId: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly quantity: number;
  readonly expiresAt: number;
  readonly status: 'active' | 'converted' | 'expired' | 'released';
}

export async function loadHold(tx: Transaction, holdId: string): Promise<HoldRow | null> {
  const { rows } = await tx.execute<{
    id: string;
    service_id: string;
    customer_id: string | null;
    starts_ms: string;
    ends_ms: string;
    quantity: number;
    expires_ms: string;
    status: HoldRow['status'];
  }>(sql`
    SELECT id, service_id, customer_id, quantity, status,
           (extract(epoch FROM starts_at) * 1000)::bigint AS starts_ms,
           (extract(epoch FROM ends_at) * 1000)::bigint AS ends_ms,
           (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms
      FROM holds
     WHERE id = ${holdId}
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    serviceId: row.service_id,
    customerId: row.customer_id,
    startsAt: Number(row.starts_ms),
    endsAt: Number(row.ends_ms),
    quantity: row.quantity,
    expiresAt: Number(row.expires_ms),
    status: row.status,
  };
}

export interface HeldOccupancy {
  readonly id: string;
  readonly resourceId: string;
  readonly capacityUsed: number;
}

/** The active occupancies a hold holds, in ascending order of resource id (the lock order). */
export async function loadHoldOccupancies(
  tx: Transaction,
  holdId: string,
): Promise<HeldOccupancy[]> {
  const { rows } = await tx.execute<{
    id: string;
    resource_id: string;
    capacity_used: number;
  }>(sql`
    SELECT id, resource_id, capacity_used
      FROM occupancies
     WHERE ref_id = ${holdId} AND kind = 'hold' AND active
     ORDER BY resource_id
  `);
  return rows.map((row) => ({
    id: row.id,
    resourceId: row.resource_id,
    capacityUsed: row.capacity_used,
  }));
}
