/**
 * The booking transaction: the section of the system where the capacity of a resource is
 * actually taken, and the one place the invariant "a resource with capacity N never has more
 * than N units taken at any instant" is enforced for N > 1.
 *
 * It is the whole write flow of a creation except taking the payment, which does not exist
 * yet, in a single function that hold and booking share, because they differ only in the row
 * they write at the end.
 *
 * The shape of the critical section, in order:
 *
 * 1. one transaction, with the RLS context pinned to it, retried on `40001` / `40P01`;
 * 2. the connection is checked not to bypass Row Level Security;
 * 3. the **candidate** resources of the service are read from the catalogue alone;
 * 4. `pg_advisory_xact_lock` on every one of them, in ascending order of id, **before** a
 *    single occupancy is read;
 * 5. `loadAvailabilityData` reads the service, the requirements and the occupancies,
 *    **without the cache**, because a cache is a photograph and this is the one place that
 *    needs the negative;
 * 6. the request is revalidated against the calendar, the booking window and the customer
 *    limit: availability was computed at some earlier instant and is only ever a promise;
 *    in the live environment of a plan that blocks at its limit, the account is locked and the
 *    month's usage checked as well (`plan/usage.ts`), always after the resource and customer
 *    locks;
 * 7. the resources are assigned exactly (`allocate.ts`), following the group's strategy;
 * 8. the capacity is verified in SQL against the peak usage over the footprint;
 * 9. the occupancies, the hold or the booking, the allocations and the event are written, and
 *    a booking born `confirmed` in the live environment is counted against the plan;
 * 10. after the commit, the caller drops `avail:occ:{resource}:{day}` for every
 *     {@link CreateBookingResult.touchedDays} entry.
 *
 * **Why the lock comes before the read, and why the default isolation is `read committed`.**
 * A `SERIALIZABLE` (or `REPEATABLE READ`) transaction takes its snapshot at its **first**
 * statement, and a transaction that then *waits* on the advisory lock keeps reading the state
 * from before the lock holder committed. Verified directly, not deduced: two serializable
 * transactions, the second waiting on the lock, the first inserting and committing, and the
 * second does not see the row once it is let through. A capacity check run after the lock
 * would therefore not be authoritative under `SERIALIZABLE`: correctness would come from SSI
 * spotting the conflict and aborting with `40001` at COMMIT, not from the lock. Measured with
 * the original ordering (read before lock), two hundred requests on a slot of capacity
 * fifteen left about a sixth of them failing with a serialization error instead of a clean
 * `slot_unavailable`, even with three retries each.
 *
 * Under `read committed` every statement takes a fresh snapshot, so the check that runs
 * **after** the lock sees everything that has committed, which is precisely what the lock was
 * taken for. The requirement was always a serializable transaction **or** an explicit lock:
 * this is the explicit lock, and {@link CreateBookingInput.isolationLevel} still lets a
 * deployment ask for `serializable`.
 *
 * The exclusion constraint `occ_no_overlap_cap1` sits under all of it: for a resource of
 * capacity 1 the database refuses the second overlapping occupancy whatever this code does.
 */
import {
  sql,
  withProjectContext,
  type Database,
  type Transaction,
  type ProjectContext,
} from '@bookrail/db';
import { encodeId, errors, uuidv7, type PriceRuleRef } from '@bookrail/shared';

import {
  candidateGrid,
  gridIntervalMs,
  loadAvailabilityData,
  minCapacityOver,
  priceForSlot,
  priceRuleOf,
  resourceOpenTimelines,
  resourceTimelines,
  type AvailabilityData,
  type RequirementData,
  type ResourceData,
  type ResourceTimelines,
  type ServiceData,
} from '../availability/index.js';
import { localDayRange, localDaysBetween } from '../schedule/index.js';
import {
  orderCandidates,
  planAllocation,
  type AllocationCandidate,
  type PlannedAllocation,
  type RequirementPlan,
} from './allocate.js';
import {
  assertPlanVolume,
  chainAlreadyConfirmed,
  lockPlanForBooking,
  recordPlanUsage,
  type PlanUsageWarning,
} from '../plan/usage.js';
import { releaseOccupancies, takeOccupancy } from './occupancy.js';
import { depositRule, paymentAmountFor } from './payment.js';
import { nextTransitionFor, type AutomaticTransition } from './policy.js';
import { bookingEventObject } from './snapshot.js';
import { resourceZones, touchedDaysOf } from './touched.js';
import {
  activeBookingCount,
  assertApplicationRole,
  lockCustomer,
  candidateResourceIds,
  dayUsage,
  insertEvent,
  liveResourceIds,
  loadGroupCursors,
  loadHold,
  loadHoldOccupancies,
  loadPolicy,
  lockResources,
  setRoundRobinCursor,
  type PolicyRow,
} from './queries.js';
import {
  actorRecord,
  customerLimitReached,
  depositNotConfigured,
  paymentAmountInvalid,
  priceMissing,
  holdExpired,
  holdNotActive,
  minNoticeViolated,
  outsideBookingWindow,
  resourceNotEligible,
  serializationFailure,
  slotUnavailable,
  startNotOnGrid,
  type AllocatedResource,
  type CreateBookingInput,
  type CreateBookingResult,
  type CreatedPayment,
  type InitialBookingStatus,
  type RescheduleOrigin,
  type ReleaseHoldInput,
  type ReleaseHoldResult,
} from './types.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A serialization failure or a deadlock is retried up to three times, then given up on. */
export const DEFAULT_MAX_RETRIES = 3;

/** See the note at the top of this file for why this is not `serializable`. */
export const DEFAULT_ISOLATION_LEVEL = 'read committed' as const;

/** Postgres classes that mean "try again", not "you are wrong". */
const RETRYABLE = new Set(['40001', '40P01']);

const DEFAULT_HOLD_TTL_SECONDS = 600;
/** `policies.hold_duration_seconds` is capped at a day; a hold never lives past 30 minutes. */
const MAX_HOLD_TTL_SECONDS = 1800;

function iso(at: number): string {
  return new Date(at).toISOString();
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` in one transaction with the RLS context set, retrying serialization failures and
 * deadlocks with a jittered backoff.
 *
 * The isolation level travels on the `BEGIN` itself (see `withProjectContext`): a
 * `SET TRANSACTION ISOLATION LEVEL` afterwards would be refused, because the transaction has
 * already run its first statement: the `set_config` that pins the project.
 */
export async function runBookingTransaction<T>(
  db: Database,
  ctx: ProjectContext,
  options: { maxRetries: number; isolationLevel: 'read committed' | 'serializable' },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const attempts = Math.max(0, options.maxRetries) + 1;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withProjectContext(db, ctx, fn, { isolationLevel: options.isolationLevel });
    } catch (error) {
      if (!isRetryable(error)) throw error;
      last = error;
      await sleep(5 * (attempt + 1) + Math.floor(Math.random() * 10));
    }
  }
  const failure = serializationFailure(attempts);
  failure.cause = last;
  throw failure;
}

function transactionOptions(input: {
  maxRetries?: number;
  isolationLevel?: 'read committed' | 'serializable';
}): { maxRetries: number; isolationLevel: 'read committed' | 'serializable' } {
  return {
    maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    isolationLevel: input.isolationLevel ?? DEFAULT_ISOLATION_LEVEL,
  };
}

// --- Public entry points -------------------------------------------------------------------

/** `POST /v1/holds` without the HTTP. Writes a `holds` row and its occupancies. */
export async function createHold(
  db: Database,
  input: Omit<CreateBookingInput, 'kind' | 'holdId'>,
): Promise<CreateBookingResult> {
  return createBooking(db, { ...input, kind: 'hold' });
}

/**
 * `POST /v1/bookings` and `POST /v1/holds` without the HTTP.
 *
 * With `holdId` the call converts an existing hold instead of taking new capacity: the hold
 * already holds it, and asking a second time would be both wasteful and wrong (between the
 * hold and the conversion someone else may legitimately have filled the rest of the slot).
 */
export async function createBooking(
  db: Database,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const ctx: ProjectContext = { projectId: input.projectId, environment: input.environment };
  return runBookingTransaction(db, ctx, transactionOptions(input), async (tx) => {
    await assertApplicationRole(tx);
    return input.kind === 'booking' && input.holdId != null
      ? convert(tx, input, input.holdId)
      : take(tx, input);
  });
}

/** `DELETE /v1/holds/{id}`: the occupancies go inactive and the hold is marked released. */
export async function releaseHold(
  db: Database,
  input: ReleaseHoldInput,
): Promise<ReleaseHoldResult> {
  const ctx: ProjectContext = { projectId: input.projectId, environment: input.environment };
  return runBookingTransaction(db, ctx, transactionOptions(input), async (tx) => {
    await assertApplicationRole(tx);
    const first = await loadHold(tx, input.holdId);
    if (first === null) throw errors.notFound('hold', input.holdId);
    // Lock, then read again: everything decided below has to be decided on the state the lock
    // protects, not on the one that happened to be visible before it was taken.
    await lockResources(
      tx,
      (await loadHoldOccupancies(tx, input.holdId)).map((occupancy) => occupancy.resourceId),
    );
    const hold = (await loadHold(tx, input.holdId)) ?? first;
    if (hold.status === 'converted') {
      throw holdNotActive(`Hold ${input.holdId} has already been converted into a booking.`);
    }
    const occupancies = await loadHoldOccupancies(tx, input.holdId);
    if (hold.status === 'released' || hold.status === 'expired') {
      // Releasing twice is not an error: the caller wanted the slot free, and it is.
      return { holdId: hold.id, released: false, eventId: null, touchedDays: [] };
    }
    // A hold whose time is up is **expired**, not released, even if the caller asked to release
    // it and nobody has swept it yet: the event has to record the transition that happened, and a
    // webhook consumer must not see a release where there was an expiry.
    const expired = hold.expiresAt <= input.now;
    await releaseOccupancies(tx, { refId: input.holdId, kind: 'hold' });
    await tx.execute(sql`
      UPDATE holds SET status = ${expired ? 'expired' : 'released'} WHERE id = ${input.holdId}
    `);
    const eventId = await insertEvent(
      tx,
      input.projectId,
      input.environment,
      expired ? 'hold.expired' : 'hold.released',
      {
        id: encodeId('hold', hold.id),
        object: 'hold',
        service_id: encodeId('service', hold.serviceId),
        status: expired ? 'expired' : 'released',
        start: iso(hold.startsAt),
        end: iso(hold.endsAt),
        quantity: hold.quantity,
        resources: occupancies.map((occupancy) => encodeId('resource', occupancy.resourceId)),
      },
      { actor: actorRecord(input.actor) },
    );
    const zones = await resourceZones(
      tx,
      occupancies.map((occupancy) => occupancy.resourceId),
    );
    return {
      holdId: hold.id,
      released: true,
      eventId,
      touchedDays: touchedDaysOf(
        occupancies.map((occupancy) => ({ resourceId: occupancy.resourceId })),
        zones,
        hold.startsAt,
        hold.endsAt,
      ),
    };
  });
}

// --- Taking capacity ------------------------------------------------------------------------

/**
 * The creation itself, without the transaction around it.
 *
 * Exported because the reschedule of `lifecycle.ts` has to create the new booking **inside**
 * the transaction that closes the old one: two transactions would leave a window in which the
 * customer has neither booking, or both. Everything this function does (the candidate set,
 * the advisory locks, the revalidation, the grid, the assignment, `takeOccupancy`, the
 * `booking.created` event) is what `POST /v1/bookings` does, and a reschedule that
 * reimplemented any of it would be a second definition of what a booking is.
 */
export async function take(
  tx: Transaction,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  // Step 3 and 4: the candidate set from the catalogue, then the locks, before any
  // occupancy is read, so that what is read is what the lock protects. `takeOccupancy` takes
  // them again at the end (advisory locks are re-entrant inside a transaction); they are taken
  // here as well because everything below reads under their protection.
  const candidates = await candidateResourceIds(tx, input.serviceId);
  const allowed = restrictTo(
    candidates,
    input.resourceIds ?? null,
    input.serviceId,
    input.resourceIds == null || input.resourceIds.length === 0
      ? new Set<string>()
      : await liveResourceIds(tx, input.resourceIds),
  );
  await lockResources(tx, allowed);

  const data = await loadAvailabilityData(tx, {
    serviceId: input.serviceId,
    from: input.start,
    to: input.start + 1,
    customerId: input.customerId ?? null,
  });
  const service = data.service;
  const quantity = resolveQuantity(service, input.quantity);
  const durationMinutes = resolveDuration(service, input.durationMinutes);
  const start = input.start;
  const end = start + durationMinutes * MINUTE_MS;
  const beforeMs = service.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = service.bufferAfterMinutes * MINUTE_MS;
  const footStart = start - beforeMs;
  const footEnd = end + afterMs;

  assertBookingWindow(service, start, input.now);
  await assertCustomerLimit(tx, data, input.customerId ?? null);
  // The plan, third and last of the locks (resources, customer, account). A hold is a quote and
  // takes nothing from the plan; a reschedule is a change to a booking that already exists.
  const gate =
    input.kind === 'booking' && input.reschedule == null
      ? await lockPlanForBooking(tx, planScope(input))
      : null;
  const policy = await policyOf(tx, data);

  const byId = timelinesOf(data, service, start, end);
  assertOnGrid(data, service, start, durationMinutes * MINUTE_MS);
  const plans = await requirementPlans(tx, data, byId, {
    quantity,
    forced: new Set(allowed),
    footStart,
    footEnd,
  });

  const planned = planAllocation(plans, { allowSplit: service.allowSplit, quantity });
  if (planned === null) throw noAssignment(data, byId, plans, quantity, footStart, footEnd);

  await advanceRoundRobin(tx, data, planned);

  const kind = input.kind;
  const id = uuidv7();
  const expiresAt =
    kind === 'hold' ? input.now + holdTtlSeconds(policy, input.ttlSeconds) * 1000 : null;

  // The single door: lock, sweep, verify, insert. Nothing in this file writes `occupancies`.
  const taken = await takeOccupancy(tx, {
    projectId: input.projectId,
    environment: input.environment,
    resourceIds: allowed,
    allocations: planned.map((allocation) => ({
      resourceId: allocation.resourceId,
      capacityUsed: allocation.capacityUsed,
    })),
    start,
    end,
    kind,
    refId: id,
    expiresAt,
    bufferBeforeMs: beforeMs,
    bufferAfterMs: afterMs,
    bufferSharing: service.bufferSharing,
    capacities: new Map(data.resources.map((resource) => [resource.id, resource.capacity])),
  });
  const roleOf = new Map(planned.map((allocation) => [allocation.resourceId, allocation.role]));
  const allocations: AllocatedResource[] = taken.occupancies.map((occupancy) => ({
    resourceId: occupancy.resourceId,
    role: roleOf.get(occupancy.resourceId) ?? null,
    capacityUsed: occupancy.capacityUsed,
    occupancyId: occupancy.id,
  }));

  // A booking that is waiting for money is `pending` whatever the policy says about
  // confirmations: `confirmed` would mean the slot is the customer's, and it is not until the
  // money arrives. The policy's own confirmation is applied again by the webhook receiver,
  // which is what decides whether a paid booking becomes `confirmed` or stays `pending`.
  const status: InitialBookingStatus =
    input.payment != null || (policy !== null && policy.requiresConfirmation)
      ? 'pending'
      : 'confirmed';
  // The price is computed **here**, from the resources this booking actually got, and frozen.
  // Availability quoted a price for the assignment it preferred; this is the assignment that
  // exists, and a booking carries the price of the moment it is made, never a price recomputed
  // later. Everything downstream (refund, reschedule fee, no-show charge) reads the frozen
  // number, never the rules again.
  const priced = priceForSlot(
    service,
    {
      startUtc: start,
      durationMinutes,
      resourceIds: allocations.map((allocation) => allocation.resourceId),
    },
    data.timezone,
  );
  const price = priced?.price ?? null;
  const priceRule = priceRuleOf(priced);

  // The payment, from the price that has just been frozen. A hold takes no money: a hold is a
  // quote, and the price is recomputed at the conversion.
  const payment =
    kind === 'hold'
      ? null
      : resolvePayment(input, { id: uuidv7(), price, policy, serviceId: service.id });
  if (payment !== null) assertPlanVolume(gate, payment.amount);

  let scheduled: { action: AutomaticTransition; at: number } | null = null;
  let planWarnings: PlanUsageWarning[] = [];
  if (kind === 'hold') {
    await tx.execute(sql`
      INSERT INTO holds (id, project_id, environment, service_id, customer_id, starts_at,
                         ends_at, quantity, expires_at, status, metadata)
      VALUES (${id}, ${input.projectId}, ${input.environment}, ${service.id},
              ${input.customerId ?? null}, ${iso(start)}, ${iso(end)}, ${quantity},
              ${iso(expiresAt ?? input.now)}, 'active',
              ${JSON.stringify(input.metadata ?? {})}::jsonb)
    `);
  } else {
    scheduled = await insertBooking(tx, input, {
      id,
      service,
      status,
      quantity,
      start,
      end,
      timezone: data.timezone,
      price,
      priceRule,
      policy,
      holdId: null,
      allocations,
      payment,
    });
    if (payment !== null) await insertPayment(tx, input, id, payment);
    if (status === 'confirmed') {
      planWarnings = await countConfirmed(tx, input, input.reschedule?.fromBookingId ?? null);
    }
  }

  const eventId = await insertEvent(
    tx,
    input.projectId,
    input.environment,
    kind === 'hold' ? 'hold.created' : 'booking.created',
    kind === 'hold'
      ? holdEventPayload({
          id,
          service,
          customerId: input.customerId ?? null,
          status: 'active',
          start,
          end,
          timezone: data.timezone,
          quantity,
          price,
          priceRule,
          allocations,
          expiresAt,
        })
      : createdBookingObject({
          id,
          service,
          customerId: input.customerId ?? null,
          status,
          start,
          end,
          timezone: data.timezone,
          quantity,
          price,
          priceRule,
          allocations,
          holdId: null,
          source: input.source ?? 'api',
          notes: input.notes ?? null,
          now: input.now,
          scheduled,
          reschedule: input.reschedule ?? null,
          payment,
        }),
    { occurredAt: input.now, actor: actorRecord(input.actor) },
  );

  return {
    kind,
    id,
    serviceId: service.id,
    customerId: input.customerId ?? null,
    holdId: null,
    start,
    end,
    durationMinutes,
    quantity,
    timezone: data.timezone,
    status: kind === 'hold' ? 'active' : status,
    expiresAt,
    price,
    priceRule,
    policySnapshot: policy?.snapshot ?? null,
    payment,
    allocations,
    eventId,
    touchedDays: touchedDaysOf(allocations, zonesOf(data), start, end),
    planWarnings,
  };
}

// --- Converting a hold ----------------------------------------------------------------------

/**
 * Turns a hold into a booking without asking for the capacity again.
 *
 * The hold already owns it: its occupancies are active and counted by every other
 * transaction, so re-running the capacity check would compare the hold against itself. What
 * has to be checked is that the hold is still the thing the caller thinks it is (alive, not
 * expired, for the same service, instant and quantity), and that its resources are locked
 * before the rows are rewritten, so that a concurrent release or expiry cannot interleave.
 */
async function convert(
  tx: Transaction,
  input: CreateBookingInput,
  holdId: string,
): Promise<CreateBookingResult> {
  const before = await loadHold(tx, holdId);
  if (before === null) throw errors.notFound('hold', holdId);
  // Lock first, then read what the lock protects: a release or an expiry racing this
  // conversion has to be either wholly before it or wholly after it.
  await lockResources(
    tx,
    (await loadHoldOccupancies(tx, holdId)).map((occupancy) => occupancy.resourceId),
  );
  const hold = (await loadHold(tx, holdId)) ?? before;
  if (hold.status === 'expired' || hold.expiresAt <= input.now) {
    throw holdExpired(
      `Hold ${holdId} expired at ${iso(hold.expiresAt)}; ask for availability again.`,
    );
  }
  if (hold.status !== 'active') {
    throw holdNotActive(`Hold ${holdId} is ${hold.status}.`);
  }
  if (hold.serviceId !== input.serviceId) {
    throw errors.invalidRequest(
      `Hold ${holdId} is for another service.`,
      'hold_id',
      'hold_mismatch',
    );
  }
  if (hold.startsAt !== input.start) {
    throw errors.invalidRequest(
      `Hold ${holdId} starts at ${iso(hold.startsAt)}, not at ${iso(input.start)}.`,
      'start',
      'hold_mismatch',
    );
  }
  if (input.quantity != null && input.quantity !== hold.quantity) {
    throw errors.invalidRequest(
      `Hold ${holdId} is for ${String(hold.quantity)} units, not ${String(input.quantity)}.`,
      'quantity',
      'hold_mismatch',
    );
  }

  const data = await loadAvailabilityData(tx, {
    serviceId: input.serviceId,
    from: hold.startsAt,
    to: hold.startsAt + 1,
    customerId: input.customerId ?? hold.customerId ?? null,
  });
  const service = data.service;
  const durationMinutes = Math.round((hold.endsAt - hold.startsAt) / MINUTE_MS);
  if (input.durationMinutes != null && input.durationMinutes !== durationMinutes) {
    throw errors.invalidRequest(
      `Hold ${holdId} lasts ${String(durationMinutes)} minutes, not ${String(input.durationMinutes)}.`,
      'duration_minutes',
      'hold_mismatch',
    );
  }

  const held = await loadHoldOccupancies(tx, holdId);
  if (held.length === 0) {
    throw holdExpired(`Hold ${holdId} no longer holds any resource.`);
  }

  // The hold took no plan and was not counted: the conversion is the booking, so this is where
  // the free plan's check runs, after the resource locks and before the capacity changes hands.
  const gate = await lockPlanForBooking(tx, planScope(input));

  const bookingId = uuidv7();
  // The same door as a fresh booking, in its conversion mode: the lock and the sweep still
  // apply, only the measurement is skipped, because the hold already owns this capacity and
  // measuring would compare it with itself.
  const taken = await takeOccupancy(tx, {
    projectId: input.projectId,
    environment: input.environment,
    resourceIds: held.map((occupancy) => occupancy.resourceId),
    allocations: held.map((occupancy) => ({
      resourceId: occupancy.resourceId,
      capacityUsed: occupancy.capacityUsed,
    })),
    start: hold.startsAt,
    end: hold.endsAt,
    kind: 'booking',
    refId: bookingId,
    expiresAt: null,
    convertFrom: holdId,
  });
  await tx.execute(sql`UPDATE holds SET status = 'converted' WHERE id = ${holdId}`);

  const roles = rolesFor(
    data,
    held.map((occupancy) => occupancy.resourceId),
    hold.quantity,
  );
  const allocations: AllocatedResource[] = taken.occupancies.map((occupancy) => ({
    resourceId: occupancy.resourceId,
    role: roles.get(occupancy.resourceId) ?? null,
    capacityUsed: occupancy.capacityUsed,
    occupancyId: occupancy.id,
  }));

  const policy = await policyOf(tx, data);
  const status: InitialBookingStatus =
    input.payment != null || (policy !== null && policy.requiresConfirmation)
      ? 'pending'
      : 'confirmed';
  // A hold has no price: `holds` has no price column, and the price a customer pays is the one
  // of the **conversion**, not of the hold. So the rules are evaluated again here, against the
  // resources the hold is holding.
  const priced = priceForSlot(
    service,
    {
      startUtc: hold.startsAt,
      durationMinutes,
      resourceIds: allocations.map((allocation) => allocation.resourceId),
    },
    data.timezone,
  );
  const price = priced?.price ?? null;
  const priceRule = priceRuleOf(priced);
  const customerId = input.customerId ?? hold.customerId ?? null;
  const payment = resolvePayment(input, {
    id: uuidv7(),
    price,
    policy,
    serviceId: service.id,
  });
  if (payment !== null) assertPlanVolume(gate, payment.amount);

  const scheduled = await insertBooking(tx, input, {
    id: bookingId,
    service,
    status,
    quantity: hold.quantity,
    start: hold.startsAt,
    end: hold.endsAt,
    timezone: data.timezone,
    price,
    priceRule,
    policy,
    holdId,
    allocations,
    payment,
  });
  if (payment !== null) await insertPayment(tx, input, bookingId, payment);
  const planWarnings =
    status === 'confirmed' ? await countConfirmed(tx, input, null) : ([] as PlanUsageWarning[]);

  const eventId = await insertEvent(
    tx,
    input.projectId,
    input.environment,
    'booking.created',
    createdBookingObject({
      id: bookingId,
      service,
      customerId,
      status,
      start: hold.startsAt,
      end: hold.endsAt,
      timezone: data.timezone,
      quantity: hold.quantity,
      price,
      priceRule,
      allocations,
      holdId,
      source: input.source ?? 'api',
      notes: input.notes ?? null,
      now: input.now,
      scheduled,
      reschedule: input.reschedule ?? null,
      payment,
    }),
    { occurredAt: input.now, actor: actorRecord(input.actor) },
  );

  return {
    kind: 'booking',
    id: bookingId,
    serviceId: service.id,
    customerId,
    holdId,
    start: hold.startsAt,
    end: hold.endsAt,
    durationMinutes,
    quantity: hold.quantity,
    timezone: data.timezone,
    status,
    expiresAt: null,
    price,
    priceRule,
    policySnapshot: policy?.snapshot ?? null,
    payment,
    allocations,
    eventId,
    touchedDays: touchedDaysOf(allocations, zonesOf(data), hold.startsAt, hold.endsAt),
    planWarnings,
  };
}

// --- The plan ---------------------------------------------------------------------------------

function planScope(input: CreateBookingInput): {
  projectId: string;
  environment: CreateBookingInput['environment'];
  now: number;
  plans?: CreateBookingInput['plans'];
} {
  return {
    projectId: input.projectId,
    environment: input.environment,
    now: input.now,
    ...(input.plans === undefined ? {} : { plans: input.plans }),
  };
}

/**
 * One confirmed booking against the plan, unless its reschedule chain was already counted.
 *
 * A booking born `confirmed` from a reschedule of a booking that had been confirmed is the same
 * booking moved, and moving is not booking again. A reschedule of a booking that was still
 * `pending` has never been counted, and the first `confirmed` of the chain is the one that
 * counts, wherever it happens.
 */
async function countConfirmed(
  tx: Transaction,
  input: CreateBookingInput,
  rescheduledFrom: string | null,
): Promise<PlanUsageWarning[]> {
  if (input.environment !== 'live') return [];
  if (await chainAlreadyConfirmed(tx, rescheduledFrom)) return [];
  return recordPlanUsage(tx, {
    projectId: input.projectId,
    environment: input.environment,
    now: input.now,
    bookings: 1,
    ...(input.plans === undefined ? {} : { plans: input.plans }),
  });
}

/**
 * Recovers the `role` of each held resource by re-running the assignment on the held set.
 *
 * `occupancies` does not carry the role (it is a property of the requirement, not of the
 * occupation), so a conversion has to work it out again. If the service changed in the
 * meantime and no assignment of exactly these resources exists any more, the roles are simply
 * left null: the booking is still the one the customer held, and inventing a role would be
 * worse than admitting there is none.
 */
function rolesFor(
  data: AvailabilityData,
  resourceIds: readonly string[],
  quantity: number,
): Map<string, string | null> {
  const roles = new Map<string, string | null>();
  const held = new Set(resourceIds);
  const plans: RequirementPlan[] = data.requirements.map((requirement) => ({
    requirement,
    candidates: requirement.resourceIds
      .filter((id) => held.has(id))
      .map((id) => ({ resourceId: id, capacity: Number.MAX_SAFE_INTEGER, need: 0 })),
  }));
  const planned = planAllocation(plans, { allowSplit: data.service.allowSplit, quantity });
  if (planned === null) return roles;
  for (const allocation of planned) roles.set(allocation.resourceId, allocation.role);
  return roles;
}

// --- Validation -----------------------------------------------------------------------------

function resolveQuantity(service: ServiceData, requested: number | null | undefined): number {
  const quantity = requested ?? service.capacityPerBooking;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw errors.invalidRequest(
      `quantity must be a positive integer, received ${String(quantity)}.`,
      'quantity',
      'parameter_invalid',
    );
  }
  return quantity;
}

/**
 * The duration the booking will have. A service states its duration in exactly one of three
 * ways (a fixed duration, a list of options, or a range), and each admits a different set of
 * answers.
 */
function resolveDuration(service: ServiceData, requested: number | null | undefined): number {
  const options = service.durationOptions;
  if (requested == null) {
    if (service.durationMinutes !== null) return service.durationMinutes;
    if (options !== null && options.length > 0) return Math.min(...options);
    if (service.durationMinMinutes !== null) return service.durationMinMinutes;
    throw errors.invalidRequest(
      `Service ${service.id} states no duration; one of duration, duration_options or duration_range is required.`,
      'service_id',
      'service_without_duration',
    );
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw errors.invalidRequest(
      `duration_minutes must be a positive integer, received ${String(requested)}.`,
      'duration_minutes',
      'parameter_invalid',
    );
  }
  const offered =
    service.durationMinutes !== null
      ? requested === service.durationMinutes
      : options !== null && options.length > 0
        ? options.includes(requested)
        : service.durationMinMinutes !== null &&
          service.durationMaxMinutes !== null &&
          requested >= service.durationMinMinutes &&
          requested <= service.durationMaxMinutes;
  if (!offered) {
    throw errors.invalidRequest(
      `Service ${service.id} does not offer a duration of ${String(requested)} minutes.`,
      'duration_minutes',
      'duration_not_offered',
    );
  }
  return requested;
}

function assertBookingWindow(service: ServiceData, start: number, now: number): void {
  if (start < now) {
    throw outsideBookingWindow(
      `The requested start ${iso(start)} is in the past; backdating is not supported.`,
    );
  }
  const minNoticeMs = (service.bookingWindow?.minNoticeMinutes ?? 0) * MINUTE_MS;
  if (minNoticeMs > 0 && start < now + minNoticeMs) {
    throw minNoticeViolated(
      `The service requires ${String(minNoticeMs / MINUTE_MS)} minutes of notice; the earliest start is ${iso(now + minNoticeMs)}.`,
    );
  }
  const maxAdvanceDays = service.bookingWindow?.maxAdvanceDays ?? null;
  if (maxAdvanceDays !== null && start > now + maxAdvanceDays * DAY_MS) {
    throw outsideBookingWindow(
      `The service accepts bookings up to ${String(maxAdvanceDays)} days ahead; the horizon ends at ${iso(now + maxAdvanceDays * DAY_MS)}.`,
    );
  }
}

/**
 * Slack around the local day the grid is built over: an opening band that starts the previous
 * evening anchors the grid of this day, so it has to be materialized whole. No local day is
 * longer than 25 hours and no zone is further than 14 from UTC.
 */
const GRID_PAD_MS = 26 * 60 * 60 * 1000;

/** Ceiling on the instants one day's grid may hold; a minute-by-minute day is 1 440. */
const GRID_MAX_INSTANTS = 5_000;

/**
 * Refuses a start the offer would never have shown.
 *
 * `POST /v1/availability` anchors its slots to the opening bands and steps them by
 * `slot_interval`, aligned by `align_to`. The write path used to check only that
 * the instant was inside the schedule, so a booking at 09:07 on an hourly grid was accepted
 * and then took 09:00 and 10:00 away from everyone. The grid is
 * rebuilt here with the **same function** the offer uses, over the local day the start falls
 * in, because two implementations of one grid is how they come to disagree.
 *
 * A service that defines no grid (no `slot_interval_minutes`, no `align_to`: a rental, a
 * duration range) has nothing to be off, and any instant inside the schedule is legitimate.
 * An empty grid means nothing is open at all, which is the allocation's story to tell with a
 * truer error.
 */
function assertOnGrid(
  data: AvailabilityData,
  service: ServiceData,
  start: number,
  durationMs: number,
): void {
  if (service.slotIntervalMinutes === null && service.alignTo === null) return;
  const timezone = data.timezone;
  const day = localDaysBetween(timezone, start, start + 1)[0];
  if (day === undefined) return;
  const range = localDayRange(timezone, day);
  const layers = data.resources.map((resource) =>
    resourceOpenTimelines(resource, range.start - GRID_PAD_MS, range.end + GRID_PAD_MS),
  );
  const grid = candidateGrid(layers, {
    service,
    timezone,
    durationMs,
    intervalMs: gridIntervalMs(service),
    from: range.start,
    to: range.end,
    maxInstants: GRID_MAX_INSTANTS,
  });
  if (grid.length === 0 || grid.includes(start)) return;
  throw startNotOnGrid(
    `${iso(start)} is not on the slot grid of service ${service.id}; the offer never shows it.`,
  );
}

/**
 * `max_active_bookings_per_customer`, under a lock.
 *
 * The count `loadAvailabilityData` put in `data.customerActiveBookings` is the one the
 * *availability* answer was computed from, and it is the right number to show a caller. It is
 * the wrong number to decide on: nothing was holding it still, and two bookings of the same
 * customer on disjoint resources share no resource lock, so both could read two, both could
 * find two under three, and the customer would end up with four.
 *
 * So the decision is taken again here, on a count read **after** an advisory lock on the
 * customer. The lock is taken only when the policy defines a limit, which is what keeps the
 * common case free: no limit, no lock, no second query. An anonymous booking has no customer to
 * count and is not covered by a per-customer limit in the first place.
 */
async function assertCustomerLimit(
  tx: Transaction,
  data: AvailabilityData,
  customerId: string | null,
): Promise<void> {
  const limit = data.policy?.maxActiveBookingsPerCustomer ?? null;
  if (limit === null || customerId === null) return;
  await lockCustomer(tx, customerId);
  const active = await activeBookingCount(tx, customerId);
  if (active >= limit) {
    throw customerLimitReached(
      `The customer already has ${String(active)} active bookings and the policy allows ${String(limit)}.`,
    );
  }
}

async function policyOf(tx: Transaction, data: AvailabilityData): Promise<PolicyRow | null> {
  const policyId = data.policy?.id ?? null;
  return policyId === null ? null : loadPolicy(tx, policyId);
}

function holdTtlSeconds(policy: PolicyRow | null, requested: number | null | undefined): number {
  const fallback = policy?.holdDurationSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
  const ttl = requested ?? fallback;
  if (!Number.isSafeInteger(ttl) || ttl < 1) {
    throw errors.invalidRequest(
      `ttl_seconds must be a positive integer, received ${String(ttl)}.`,
      'ttl_seconds',
      'parameter_invalid',
    );
  }
  return Math.min(ttl, MAX_HOLD_TTL_SECONDS);
}

// --- Planning --------------------------------------------------------------------------------

function timelinesOf(
  data: AvailabilityData,
  service: ServiceData,
  start: number,
  end: number,
): Map<string, ResourceTimelines> {
  // The materialization window of one instant is the footprint itself, not the one
  // `materializationWindow` sizes for a whole request: the transaction asks about a single
  // start, and a service whose maximum duration is thirty days would otherwise materialize a
  // month of calendar to answer a question about one hour.
  const from = start - service.bufferBeforeMinutes * MINUTE_MS;
  const to = end + service.bufferAfterMinutes * MINUTE_MS;
  const byId = new Map<string, ResourceTimelines>();
  for (const resource of data.resources) {
    const layers = resourceOpenTimelines(resource, from, to);
    byId.set(resource.id, resourceTimelines(resource, layers, service, { withCore: true }));
  }
  return byId;
}

/**
 * The resources this request may allocate: the service's candidates, narrowed by `resource_ids`.
 *
 * A `resource_ids` naming something the service never asks for is a mistake in the request,
 * not a slot that happens to be busy: it gets `resource_not_eligible`, a 400, and not the
 * 409 a genuinely full slot gets.
 *
 * The result is also the set that gets locked, so the allocation can never reach a resource
 * no lock protects, not even if a group gained a member between this query and the next.
 */
function restrictTo(
  candidates: readonly string[],
  requested: readonly string[] | null,
  serviceId: string,
  exists: ReadonlySet<string>,
): string[] {
  if (requested === null || requested.length === 0) return [...candidates];
  const known = new Set(candidates);
  for (const id of requested) {
    if (!known.has(id)) {
      // A resource that does not exist, or belongs to another project, is invisible through
      // RLS and reaches here indistinguishable from one the service simply never uses. The
      // other two identifiers of this call (`service_id`, `hold_id`) answer 404 in that
      // situation, so this one does too. Neither confirms the
      // existence of anything: they are the same answer for "not yours" and "not there".
      if (!exists.has(id)) throw errors.notFound('resource', id);
      throw resourceNotEligible(
        `Resource ${id} is not a candidate of any requirement of service ${serviceId}.`,
      );
    }
  }
  return [...new Set(requested)];
}

async function requirementPlans(
  tx: Transaction,
  data: AvailabilityData,
  byId: ReadonlyMap<string, ResourceTimelines>,
  options: {
    quantity: number;
    forced: Set<string> | null;
    footStart: number;
    footEnd: number;
  },
): Promise<RequirementPlan[]> {
  const raw = data.requirements.map((requirement) => ({
    requirement,
    candidates: candidatesFor(requirement, byId, options),
  }));

  const needsUsage = raw.some((plan) => plan.requirement.allocationStrategy === 'least_busy');
  const usage = needsUsage
    ? await dayUsage(tx, localDayWindows(raw, data, options.footStart))
    : new Map<string, number>();
  const groupIds = [
    ...new Set(
      raw
        .filter((plan) => plan.requirement.allocationStrategy === 'round_robin')
        .map((plan) => plan.requirement.resourceGroupId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const cursors = await loadGroupCursors(tx, groupIds);

  return raw.map((plan) => ({
    requirement: plan.requirement,
    candidates: orderCandidates(plan.candidates, plan.requirement.allocationStrategy, {
      cursor: cursors.get(plan.requirement.resourceGroupId ?? '') ?? null,
      dayUsage: usage,
    }),
  }));
}

function candidatesFor(
  requirement: RequirementData,
  byId: ReadonlyMap<string, ResourceTimelines>,
  options: { quantity: number; forced: Set<string> | null; footStart: number; footEnd: number },
): AllocationCandidate[] {
  const out: AllocationCandidate[] = [];
  for (const id of requirement.resourceIds) {
    if (options.forced !== null && !options.forced.has(id)) continue;
    const entry = byId.get(id);
    if (entry === undefined) continue;
    const capacity = minCapacityOver(entry.residual, options.footStart, options.footEnd);
    if (capacity <= 0) continue;
    out.push({
      resourceId: id,
      capacity,
      need: requirement.consumes === 'whole' ? entry.resource.capacity : options.quantity,
    });
  }
  return out;
}

function localDayWindows(
  plans: readonly { requirement: RequirementData; candidates: readonly AllocationCandidate[] }[],
  data: AvailabilityData,
  at: number,
): { resourceId: string; from: number; to: number }[] {
  const zones = zonesOf(data);
  const seen = new Set<string>();
  const out: { resourceId: string; from: number; to: number }[] = [];
  for (const plan of plans) {
    if (plan.requirement.allocationStrategy !== 'least_busy') continue;
    for (const candidate of plan.candidates) {
      if (seen.has(candidate.resourceId)) continue;
      seen.add(candidate.resourceId);
      const zone = zones.get(candidate.resourceId);
      if (zone === undefined) continue;
      const days = localDaysBetween(zone, at, at + 1);
      const day = days[0];
      if (day === undefined) continue;
      const range = localDayRange(zone, day);
      out.push({ resourceId: candidate.resourceId, from: range.start, to: range.end });
    }
  }
  return out;
}

// --- Failure explanation -----------------------------------------------------------------------

/**
 * The `slot_unavailable` a failed assignment deserves.
 *
 * The transaction knows more than "no", and the client is about to show a human why the slot
 * it was offered a moment ago is gone: the message names the first requirement that could not
 * be served and how much of it was left.
 */
function noAssignment(
  data: AvailabilityData,
  byId: ReadonlyMap<string, ResourceTimelines>,
  plans: readonly RequirementPlan[],
  quantity: number,
  footStart: number,
  footEnd: number,
): Error {
  for (const plan of plans) {
    if (plan.candidates.length >= plan.requirement.quantity) {
      const enough = plan.candidates.filter(
        (candidate) => candidate.capacity >= candidate.need,
      ).length;
      if (enough >= plan.requirement.quantity) continue;
    }
    let best = 0;
    let name = 'the requested resources';
    for (const id of plan.requirement.resourceIds) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      const left = minCapacityOver(entry.residual, footStart, footEnd);
      if (left > best) {
        best = left;
        name = entry.resource.name;
      }
      if (best === 0) name = entry.resource.name;
    }
    return slotUnavailable(
      quantity,
      best,
      `No resource can serve requirement ${plan.requirement.id} (${name}).`,
    );
  }
  // Every requirement can be served on its own, so the clash is between them: two
  // requirements are fighting over the same resource, so no assignment of distinct resources
  // satisfies all of them at this instant.
  return slotUnavailable(
    quantity,
    0,
    `Service ${data.service.id} has no assignment of distinct resources satisfying every requirement at this instant.`,
  );
}

// --- The payment a creation takes -----------------------------------------------------------

/**
 * Turns `payment.mode` into the `payments` row this booking will be waiting on.
 *
 * Called **inside** the transaction, after the price has been frozen and the policy snapshot
 * taken, because both are inputs: the amount of a `percent` deposit is a fraction of the price
 * this assignment produced, and the deposit rule is the one the customer is agreeing to now,
 * which is the one about to be written into `policy_snapshot`.
 *
 * The three refusals are all `400`s with a `fix`, and they all happen before a single row is
 * written: the transaction rolls back, no capacity is taken, and the caller is told which of
 * the three things to change. `routes/bookings.ts` checks the same three before the transaction
 * as well, on the live rows, so that the common mistake costs no advisory lock at all; this is
 * the check that is authoritative, because it is the one that sees the frozen numbers.
 */
function resolvePayment(
  input: CreateBookingInput,
  args: {
    id: string;
    price: { amount: number; currency: string } | null;
    policy: PolicyRow | null;
    serviceId: string;
  },
): CreatedPayment | null {
  const request = input.payment ?? null;
  if (request === null) return null;
  if (args.price === null) {
    throw priceMissing(
      `Service ${args.serviceId} has no price, so there is nothing to charge for payment.mode "${request.mode}".`,
    );
  }
  const rule = depositRule(args.policy?.snapshot ?? null);
  const computed = paymentAmountFor({
    mode: request.mode,
    priceAmount: args.price.amount,
    depositRule: rule,
  });
  if (!computed.ok) {
    if (computed.reason === 'price_missing') {
      throw priceMissing(`Service ${args.serviceId} has no price.`);
    }
    if (computed.reason === 'deposit_missing') {
      throw depositNotConfigured(
        `payment.mode "deposit" needs a deposit on the policy of service ${args.serviceId}, and it has none.`,
      );
    }
    throw paymentAmountInvalid(
      `The rules of this booking produce an amount of 0 for payment.mode "${request.mode}".`,
    );
  }
  return {
    id: args.id,
    type: request.mode,
    amount: computed.amount,
    currency: args.price.currency,
    providerAccountId: request.providerAccountId,
    expiresAt: input.now + request.timeoutMs,
  };
}

/** The `payments` row, written in the same transaction as the booking it belongs to. */
async function insertPayment(
  tx: Transaction,
  input: CreateBookingInput,
  bookingId: string,
  payment: CreatedPayment,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO payments (id, project_id, environment, booking_id, provider, provider_account_id,
                          provider_payment_id, type, amount, currency, status, metadata)
    VALUES (${payment.id}, ${input.projectId}, ${input.environment}, ${bookingId}, 'stripe',
            ${payment.providerAccountId}, NULL, ${payment.type}, ${payment.amount},
            ${payment.currency}, 'pending', '{}'::jsonb)
  `);
}

// --- Writing ------------------------------------------------------------------------------------

async function insertBooking(
  tx: Transaction,
  input: CreateBookingInput,
  args: {
    id: string;
    service: ServiceData;
    status: InitialBookingStatus;
    quantity: number;
    start: number;
    end: number;
    timezone: string;
    price: { amount: number; currency: string } | null;
    priceRule: PriceRuleRef | null;
    policy: PolicyRow | null;
    holdId: string | null;
    allocations: readonly AllocatedResource[];
    payment: CreatedPayment | null;
  },
): Promise<{ action: AutomaticTransition; at: number } | null> {
  // The automatic clock is set at birth, not by the first transition: a booking created with
  // `auto_complete` and never touched again still has to complete by itself, and the scheduler
  // finds it by `next_transition_at` on this very row. `nextTransitionFor` is the same function
  // every transition uses.
  const scheduled = nextTransitionFor(
    {
      status: args.status,
      startsAt: args.start,
      endsAt: args.end,
      checkedInAt: null,
      // A booking waiting for money has exactly one automatic transition, and it is this
      // deadline. `nextTransitionFor` returns `expire_payment` for it and nothing else.
      paymentExpiresAt: args.payment?.expiresAt ?? null,
    },
    args.policy?.snapshot ?? null,
  );
  // The reschedule origin is part of **this** INSERT, not of an UPDATE afterwards: the
  // `booking.created` event is written a few lines below and would otherwise announce a
  // booking with no link to the one it replaces, no counter and no fee. Permanently, because
  // `events` is append-only.
  const origin = input.reschedule ?? null;
  await tx.execute(sql`
    INSERT INTO bookings (id, project_id, environment, status, service_id, customer_id, hold_id,
                          starts_at, ends_at, timezone, quantity, price_amount, currency,
                          price_rule, policy_snapshot, source, notes, metadata, confirmed_at,
                          next_transition, next_transition_at, amount_due, payment_expires_at,
                          rescheduled_from_booking_id, reschedule_count, reschedule_fee_expected)
    VALUES (${args.id}, ${input.projectId}, ${input.environment}, ${args.status},
            ${args.service.id}, ${input.customerId ?? null}, ${args.holdId},
            ${iso(args.start)}, ${iso(args.end)}, ${args.timezone}, ${args.quantity},
            ${args.price?.amount ?? null}, ${args.price?.currency ?? null},
            ${args.priceRule === null ? null : JSON.stringify(args.priceRule)}::jsonb,
            ${args.policy === null ? null : JSON.stringify(args.policy.snapshot)}::jsonb,
            ${input.source ?? 'api'}, ${input.notes ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb,
            ${args.status === 'confirmed' ? iso(input.now) : null},
            ${scheduled?.action ?? null},
            ${scheduled === null ? null : iso(scheduled.at)}::timestamptz,
            ${args.payment?.amount ?? 0},
            ${args.payment === null ? null : iso(args.payment.expiresAt)}::timestamptz,
            ${origin?.fromBookingId ?? null}, ${origin?.count ?? 0},
            ${origin?.feeExpected ?? null})
  `);
  for (const allocation of args.allocations) {
    await tx.execute(sql`
      INSERT INTO booking_allocations (id, project_id, environment, booking_id, resource_id,
                                       role, capacity_used)
      VALUES (${uuidv7()}, ${input.projectId}, ${input.environment}, ${args.id},
              ${allocation.resourceId}, ${allocation.role}, ${allocation.capacityUsed})
    `);
  }
  return scheduled;
}

/**
 * The payload of `hold.created`.
 *
 * A **booking** does not come through here: it goes through `bookingEventObject`, the one
 * shape a booking takes wherever it appears in an event, so that `booking.created` and every
 * transition of `lifecycle.ts` carry the same fields. A hold is a different object with a
 * different life, and it keeps its own smaller payload.
 */
function holdEventPayload(args: {
  id: string;
  service: ServiceData;
  customerId: string | null;
  status: string;
  start: number;
  end: number;
  timezone: string;
  quantity: number;
  price: { amount: number; currency: string } | null;
  priceRule: PriceRuleRef | null;
  allocations: readonly AllocatedResource[];
  expiresAt: number | null;
}): Record<string, unknown> {
  return {
    id: encodeId('hold', args.id),
    object: 'hold',
    service_id: encodeId('service', args.service.id),
    customer_id: args.customerId === null ? null : encodeId('customer', args.customerId),
    hold_id: null,
    status: args.status,
    start: iso(args.start),
    end: iso(args.end),
    timezone: args.timezone,
    quantity: args.quantity,
    price: args.price,
    price_rule: args.priceRule,
    expires_at: args.expiresAt === null ? null : iso(args.expiresAt),
    allocations: args.allocations.map((allocation) => ({
      resource_id: encodeId('resource', allocation.resourceId),
      role: allocation.role,
      capacity_used: allocation.capacityUsed,
    })),
  };
}

/** The `booking.created` payload: the shared snapshot, at the values a new booking has. */
function createdBookingObject(args: {
  id: string;
  service: ServiceData;
  customerId: string | null;
  status: string;
  start: number;
  end: number;
  timezone: string;
  quantity: number;
  price: { amount: number; currency: string } | null;
  priceRule: PriceRuleRef | null;
  allocations: readonly AllocatedResource[];
  holdId: string | null;
  source: string;
  notes: string | null;
  now: number;
  scheduled: { action: AutomaticTransition; at: number } | null;
  reschedule: RescheduleOrigin | null;
  payment: CreatedPayment | null;
}): Record<string, unknown> {
  return bookingEventObject({
    id: args.id,
    status: args.status,
    serviceId: args.service.id,
    customerId: args.customerId,
    holdId: args.holdId,
    start: args.start,
    end: args.end,
    timezone: args.timezone,
    quantity: args.quantity,
    price: args.price,
    priceRule: args.priceRule,
    amountPaid: 0,
    // The one number a creation writes: what this booking is waiting to be paid. Zero for
    // `mode: "none"`, which is every booking that takes no money.
    amountDue: args.payment?.amount ?? 0,
    amountRefunded: 0,
    source: args.source,
    notes: args.notes,
    tenantId: null,
    cancelledBy: null,
    cancellationReason: null,
    refundPercent: null,
    refundAmountExpected: null,
    noShowChargeExpected: null,
    rescheduleFeeExpected: args.reschedule?.feeExpected ?? null,
    rescheduleCount: args.reschedule?.count ?? 0,
    rescheduledFromBookingId: args.reschedule?.fromBookingId ?? null,
    rescheduledToBookingId: null,
    confirmedAt: args.status === 'confirmed' ? args.now : null,
    checkedInAt: null,
    cancelledAt: null,
    completedAt: null,
    noShowAt: null,
    rescheduledAt: null,
    nextTransition: args.scheduled?.action ?? null,
    nextTransitionAt: args.scheduled?.at ?? null,
    paymentExpiresAt: args.payment?.expiresAt ?? null,
    allocations: args.allocations,
  });
}

async function advanceRoundRobin(
  tx: Transaction,
  data: AvailabilityData,
  planned: readonly PlannedAllocation[],
): Promise<void> {
  const byRequirement = new Map(data.requirements.map((r) => [r.id, r]));
  const lastByGroup = new Map<string, string>();
  for (const allocation of planned) {
    const requirement = byRequirement.get(allocation.requirementId);
    if (requirement === undefined) continue;
    if (requirement.allocationStrategy !== 'round_robin') continue;
    if (requirement.resourceGroupId === null) continue;
    lastByGroup.set(requirement.resourceGroupId, allocation.resourceId);
  }
  for (const [groupId, resourceId] of lastByGroup) {
    await setRoundRobinCursor(tx, groupId, resourceId);
  }
}

// --- Cache coordinates ---------------------------------------------------------------------------

function zonesOf(data: AvailabilityData): Map<string, string> {
  return new Map(data.resources.map((resource: ResourceData) => [resource.id, resource.timezone]));
}
