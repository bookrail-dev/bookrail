/**
 * The state machine of a booking: every transition, what each one computes from the frozen
 * `policy_snapshot`, and the single event each one writes.
 *
 * The matrix below is the whole life cycle. There is no other place in the system that decides
 * whether a booking may move from one state to another, and it is written as data rather than
 * as a chain of `if`s, so that the set of legal transitions can be read, tested and documented
 * as one thing.
 *
 * ```
 *              ┌── confirm ──┐
 *   pending ───┤             ├──> confirmed ──┬── check_in ──> in_progress ──┬── complete ──> completed
 *              │             │                │  start                       │
 *              ├── cancel ───┼──> cancelled   ├── complete ────────────────> completed
 *              └── resched. ─┼──> rescheduled ├── cancel ────────────────> cancelled
 *                            │                ├── reschedule ────────────> rescheduled
 *                            │                └── no_show ───────────────> no_show
 *                            │                                              ▲
 *                            └──────────────────────  in_progress ──────────┘
 * ```
 *
 * `held`, `completed`, `cancelled`, `no_show` and `rescheduled` are terminal: nothing leaves
 * them. (`held` is the status a booking never actually takes today: a hold is a `holds` row,
 * not a booking. It is in the CHECK constraint for the shape of the model, not for a state
 * the code produces.)
 *
 * ## Three rules the whole file obeys
 *
 * 1. **The row is locked before anything is decided.** `SELECT … FOR UPDATE` on the booking,
 *    then every check. Two requests cancelling the same booking, or a worker and a customer
 *    racing over an automatic no-show, serialize on that lock and the loser finds a status
 *    that no longer admits its action.
 * 2. **Capacity is given back through `occupancy.ts` and nowhere else.** `releaseOccupancies`
 *    takes the advisory locks first, exactly as `takeOccupancy` does; the discipline that
 *    protects capacity for N > 1 is only a discipline if it has no exceptions.
 * 3. **The event is written by the same transaction as the change.** Every state transition
 *    owes exactly one event, a rollback takes that event with it, and there is no state of
 *    the database in which a booking has moved and nobody was told.
 *
 * ## Money
 *
 * Everything computed here is an **expectation**: `refund_amount_expected`,
 * `no_show_charge_expected`, `reschedule_fee_expected`. The frozen policy states the rules and
 * this file applies them; executing a refund or a charge belongs to the payments work that does
 * not exist yet, and nothing here touches `amount_paid` or `amount_refunded`.
 */
import { sql, type Database, type Transaction, type ProjectContext } from '@bookrail/db';
import {
  encodeId,
  errors,
  priceRuleOfRow,
  BookrailError,
  type Environment,
  type PriceRuleRef,
} from '@bookrail/shared';

import { runBookingTransaction, take, DEFAULT_MAX_RETRIES } from './create.js';
import {
  graceMinutes,
  maxReschedules,
  nextTransitionFor,
  noShowChargePercent,
  policyTiers,
  tierFor,
  type AutomaticTransition,
  type BookingStatus,
} from './policy.js';
import { releaseOccupancies } from './occupancy.js';
import {
  assertApplicationRole,
  candidateResourceIds,
  insertEvent,
  lockResources,
} from './queries.js';
import { bookingEventObject, previousOf, type BookingSnapshot } from './snapshot.js';
import { actorRecord, type TransitionActor } from './types.js';
import { resourceZones, touchedDaysOf } from './touched.js';
import type { TouchedDay } from './types.js';

const MINUTE_MS = 60_000;

/**
 * Every action a booking accepts.
 *
 * `start` is the odd one out: it has no endpoint. It is what `auto_start` fires, and it moves
 * a booking to `in_progress` **without** setting `checked_in_at`, because nobody checked in.
 * Conflating it with `check_in` would silently disable `no_show.auto_mark` for every policy
 * that also asks for `auto_start`.
 */
export type TransitionAction =
  'confirm' | 'cancel' | 'reschedule' | 'no_show' | 'check_in' | 'complete' | 'start';

/**
 * The actions exposed over HTTP. `start` is deliberately not among them: only the scheduler
 * fires it, from the policy's `auto_start`.
 *
 * This is the source the routes are **generated** from, not a parallel list that happens to
 * agree with them: `packages/api/src/routes/bookings.ts` iterates it, and a test asserts that
 * the set of mounted actions equals it exactly. A constant that documents a guarantee without
 * enforcing it is worse than no constant, because it invites the reader to stop checking.
 */
export const HTTP_TRANSITION_ACTIONS = [
  'confirm',
  'cancel',
  'reschedule',
  'no_show',
  'check_in',
  'complete',
] as const;

/** The two of {@link HTTP_TRANSITION_ACTIONS} that take parameters. The rest take none. */
export const PARAMETERISED_TRANSITION_ACTIONS = ['cancel', 'reschedule'] as const;

/**
 * The matrix, as data. Read it as "from this status, this action yields that status".
 *
 * A status absent from the map, or an action absent from its entry, is not a legal
 * transition and produces `409 invalid_transition` naming what *is* legal from here.
 */
export const TRANSITIONS: Readonly<
  Partial<Record<BookingStatus, Readonly<Partial<Record<TransitionAction, BookingStatus>>>>>
> = {
  pending: {
    confirm: 'confirmed',
    cancel: 'cancelled',
    reschedule: 'rescheduled',
  },
  confirmed: {
    cancel: 'cancelled',
    reschedule: 'rescheduled',
    check_in: 'in_progress',
    start: 'in_progress',
    complete: 'completed',
    no_show: 'no_show',
  },
  in_progress: {
    // A service that has begun and has to be broken off is a cancellation, not a completion:
    // the refund is whatever the policy says at that distance from the start, or 100% with
    // `by: provider`. Without it the only way out of `in_progress` would be `complete`,
    // which charges in full.
    cancel: 'cancelled',
    complete: 'completed',
    no_show: 'no_show',
  },
};

/**
 * The statuses whose occupancies still take capacity away. A resource of capacity N never has
 * more than N units taken at any instant, and these are the statuses that count towards it.
 */
const OCCUPYING: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'pending',
  'confirmed',
  'in_progress',
  // `completed` keeps its occupancy: the service happened, and the period is in the past, so
  // the row costs nothing and is the record that the resource was used.
  'completed',
]);

export type { TransitionActor } from './types.js';

export interface TransitionInput {
  readonly projectId: string;
  readonly environment: Environment;
  /** Bare UUID of the booking. */
  readonly bookingId: string;
  readonly action: TransitionAction;
  readonly actor: TransitionActor;
  /** The instant the request is evaluated at. Explicit: the engine never reads the clock. */
  readonly now: number;

  // --- cancel ---
  readonly reason?: string | null;
  readonly by?: 'customer' | 'provider' | 'system';
  /** Overrides every tier, for any `by`. 0 to 100. */
  readonly overrideRefundPercent?: number | null;

  // --- reschedule ---
  /** New start, epoch milliseconds. */
  readonly start?: number;
  /** Forces the resources of the new booking; defaults to a free assignment. */
  readonly resourceIds?: readonly string[] | null;

  /**
   * Guard for the scheduler: apply only if the booking still has exactly this transition
   * pending. Two workers reaching the same booking produce one application and one
   * `applied: false`, without either of them having to interpret an error.
   */
  readonly expectedNextTransition?: AutomaticTransition;

  readonly maxRetries?: number;
  readonly isolationLevel?: 'read committed' | 'serializable';
}

export interface TransitionResult {
  /** The booking the action was applied to. For a reschedule, the **old** one. */
  readonly bookingId: string;
  readonly action: TransitionAction;
  readonly previousStatus: BookingStatus;
  readonly status: BookingStatus;
  /** `reschedule` only: the booking that now holds the slot. */
  readonly newBookingId: string | null;
  /**
   * False only when {@link TransitionInput.expectedNextTransition} no longer matched: the
   * booking had already been moved by somebody else. Nothing was written and no event exists.
   */
  readonly applied: boolean;
  readonly refundPercent: number | null;
  readonly refundAmountExpected: number | null;
  readonly noShowChargeExpected: number | null;
  readonly rescheduleFeeExpected: number | null;
  /**
   * The events written, in the order they were written.
   *
   * One for every action but `reschedule`, which writes two: `booking.created` for the
   * booking that came into existence and `booking.rescheduled` for the one that closed. Two
   * objects changed state, and every state change owes exactly one event. See the note on
   * {@link rescheduleBooking}.
   */
  readonly eventIds: readonly string[];
  readonly touchedDays: readonly TouchedDay[];
  readonly nextTransition: { readonly action: AutomaticTransition; readonly at: number } | null;
}

// --- Errors ---------------------------------------------------------------------------------

/** 409. The action is not one this status admits; the message names the ones that are. */
const PAST_PARTICIPLE: Record<TransitionAction, string> = {
  confirm: 'confirmed',
  cancel: 'cancelled',
  reschedule: 'rescheduled',
  no_show: 'marked as a no-show',
  check_in: 'checked in',
  complete: 'completed',
  start: 'started',
};

export function invalidTransition(
  status: BookingStatus,
  action: TransitionAction,
  allowed: readonly TransitionAction[],
): BookrailError {
  // The message ends up in a customer's logs and dashboards, so it is written out rather than
  // assembled from the action name: `action.replace('_', ' ')` produced "cannot be cancel".
  const tail =
    allowed.length === 0
      ? 'This is a terminal state: no action leaves it.'
      : `Allowed from here: ${allowed.join(', ')}.`;
  return new BookrailError(
    'conflict',
    'invalid_transition',
    `A booking in status "${status}" cannot be ${PAST_PARTICIPLE[action]}. ${tail}`,
    'status',
  );
}

/** 422. `no_show` before `starts_at + grace_minutes`. */
export function noShowTooEarly(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'no_show_too_early', detail, 'status');
}

/**
 * 422. `complete` before the booking has even started.
 *
 * `completed` is one of the statuses that keep their occupancy (the period is in the past
 * and the row is the record that the resource was used), and that reasoning only holds for a
 * booking whose time has come. Completing one ten days early took its slot off the market
 * **for ever**: `completed` is terminal, so there was no way back, and no event said so.
 * The twin of `no_show_too_early`, and the same shape of check.
 */
export function completeTooEarly(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'complete_too_early', detail, 'status');
}

/** 422. `policy_snapshot.max_reschedules` is already reached. */
export function maxReschedulesReached(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'max_reschedules_reached', detail, 'booking_id');
}

// --- The booking row ------------------------------------------------------------------------

interface BookingRow {
  id: string;
  status: BookingStatus;
  serviceId: string;
  customerId: string | null;
  holdId: string | null;
  startsAt: number;
  endsAt: number;
  timezone: string;
  quantity: number;
  priceAmount: number | null;
  currency: string | null;
  priceRule: PriceRuleRef | null;
  amountPaid: number;
  amountDue: number;
  amountRefunded: number;
  policySnapshot: Record<string, unknown> | null;
  source: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  tenantId: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  refundPercent: number | null;
  refundAmountExpected: number | null;
  noShowChargeExpected: number | null;
  rescheduleFeeExpected: number | null;
  rescheduleCount: number;
  rescheduledFromBookingId: string | null;
  rescheduledToBookingId: string | null;
  confirmedAt: number | null;
  checkedInAt: number | null;
  cancelledAt: number | null;
  completedAt: number | null;
  noShowAt: number | null;
  rescheduledAt: number | null;
  nextTransition: AutomaticTransition | null;
  nextTransitionAt: number | null;
}

interface AllocationRow {
  resourceId: string;
  role: string | null;
  capacityUsed: number;
}

function ms(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * The booking, with its row locked.
 *
 * `FOR UPDATE` is the whole reason this is a separate query rather than a join: everything
 * decided below has to be decided on a row nobody else can move underneath it.
 */
async function lockBooking(tx: Transaction, bookingId: string): Promise<BookingRow | null> {
  const { rows } = await tx.execute<Record<string, string | null>>(sql`
    SELECT id, status, service_id, customer_id, hold_id, timezone, quantity,
           price_amount, currency, price_rule, amount_paid, amount_due, amount_refunded,
           policy_snapshot, source, notes, metadata, tenant_id,
           cancelled_by, cancellation_reason, refund_percent, refund_amount_expected,
           no_show_charge_expected, reschedule_fee_expected, reschedule_count,
           rescheduled_from_booking_id, rescheduled_to_booking_id, next_transition,
           (extract(epoch FROM starts_at) * 1000)::bigint AS starts_ms,
           (extract(epoch FROM ends_at) * 1000)::bigint AS ends_ms,
           (extract(epoch FROM confirmed_at) * 1000)::bigint AS confirmed_ms,
           (extract(epoch FROM checked_in_at) * 1000)::bigint AS checked_in_ms,
           (extract(epoch FROM cancelled_at) * 1000)::bigint AS cancelled_ms,
           (extract(epoch FROM completed_at) * 1000)::bigint AS completed_ms,
           (extract(epoch FROM no_show_at) * 1000)::bigint AS no_show_ms,
           (extract(epoch FROM rescheduled_at) * 1000)::bigint AS rescheduled_ms,
           (extract(epoch FROM next_transition_at) * 1000)::bigint AS next_transition_ms
      FROM bookings
     WHERE id = ${bookingId}
       FOR UPDATE
  `);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    id: row.id as string,
    status: row.status as BookingStatus,
    serviceId: row.service_id as string,
    customerId: (row.customer_id as string | null) ?? null,
    holdId: (row.hold_id as string | null) ?? null,
    startsAt: Number(row.starts_ms),
    endsAt: Number(row.ends_ms),
    timezone: row.timezone as string,
    quantity: Number(row.quantity),
    priceAmount: row.price_amount === null ? null : Number(row.price_amount),
    currency: (row.currency as string | null) ?? null,
    priceRule: priceRuleOfRow(row.price_rule),
    amountPaid: Number(row.amount_paid),
    amountDue: Number(row.amount_due),
    amountRefunded: Number(row.amount_refunded),
    policySnapshot: (row.policy_snapshot as Record<string, unknown> | null) ?? null,
    source: row.source as string,
    notes: (row.notes as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    tenantId: (row.tenant_id as string | null) ?? null,
    cancelledBy: (row.cancelled_by as string | null) ?? null,
    cancellationReason: (row.cancellation_reason as string | null) ?? null,
    // `numeric` comes back as a string from node-postgres, on purpose: it is exact and a
    // float is not. It is a percentage, so a Number is lossless here.
    refundPercent: row.refund_percent === null ? null : Number(row.refund_percent),
    refundAmountExpected:
      row.refund_amount_expected === null ? null : Number(row.refund_amount_expected),
    noShowChargeExpected:
      row.no_show_charge_expected === null ? null : Number(row.no_show_charge_expected),
    rescheduleFeeExpected:
      row.reschedule_fee_expected === null ? null : Number(row.reschedule_fee_expected),
    rescheduleCount: Number(row.reschedule_count),
    rescheduledFromBookingId: (row.rescheduled_from_booking_id as string | null) ?? null,
    rescheduledToBookingId: (row.rescheduled_to_booking_id as string | null) ?? null,
    confirmedAt: ms(row.confirmed_ms as string | null),
    checkedInAt: ms(row.checked_in_ms as string | null),
    cancelledAt: ms(row.cancelled_ms as string | null),
    completedAt: ms(row.completed_ms as string | null),
    noShowAt: ms(row.no_show_ms as string | null),
    rescheduledAt: ms(row.rescheduled_ms as string | null),
    nextTransition: (row.next_transition as AutomaticTransition | null) ?? null,
    nextTransitionAt: ms(row.next_transition_ms as string | null),
  };
}

async function allocationsOf(tx: Transaction, bookingId: string): Promise<AllocationRow[]> {
  const { rows } = await tx.execute<{
    resource_id: string;
    role: string | null;
    capacity_used: number;
  }>(sql`
    SELECT resource_id, role, capacity_used
      FROM booking_allocations
     WHERE booking_id = ${bookingId}
     ORDER BY resource_id
  `);
  return rows.map((row) => ({
    resourceId: row.resource_id,
    role: row.role,
    capacityUsed: row.capacity_used,
  }));
}

function snapshotOf(row: BookingRow, allocations: readonly AllocationRow[]): BookingSnapshot {
  return {
    id: row.id,
    status: row.status,
    serviceId: row.serviceId,
    customerId: row.customerId,
    holdId: row.holdId,
    start: row.startsAt,
    end: row.endsAt,
    timezone: row.timezone,
    quantity: row.quantity,
    price:
      row.priceAmount === null || row.currency === null
        ? null
        : { amount: row.priceAmount, currency: row.currency },
    priceRule: row.priceRule,
    amountPaid: row.amountPaid,
    amountDue: row.amountDue,
    amountRefunded: row.amountRefunded,
    source: row.source,
    notes: row.notes,
    tenantId: row.tenantId,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    refundPercent: row.refundPercent,
    refundAmountExpected: row.refundAmountExpected,
    noShowChargeExpected: row.noShowChargeExpected,
    rescheduleFeeExpected: row.rescheduleFeeExpected,
    rescheduleCount: row.rescheduleCount,
    rescheduledFromBookingId: row.rescheduledFromBookingId,
    rescheduledToBookingId: row.rescheduledToBookingId,
    confirmedAt: row.confirmedAt,
    checkedInAt: row.checkedInAt,
    cancelledAt: row.cancelledAt,
    completedAt: row.completedAt,
    noShowAt: row.noShowAt,
    rescheduledAt: row.rescheduledAt,
    nextTransition: row.nextTransition,
    nextTransitionAt: row.nextTransitionAt,
    allocations,
  };
}

// --- Public entry point -----------------------------------------------------------------------

/**
 * Applies one transition, in its own transaction.
 *
 * The natural signature would be `transition(tx, …)`; it takes a {@link Database} instead
 * because the function has to run inside `withProjectContext` under the application role,
 * which a caller-supplied transaction cannot provide. It is also the shape
 * `createBooking` and `releaseHold` already have, and the routes call all three the same way.
 */
export async function transition(db: Database, input: TransitionInput): Promise<TransitionResult> {
  const ctx: ProjectContext = { projectId: input.projectId, environment: input.environment };
  return runBookingTransaction(
    db,
    ctx,
    {
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      isolationLevel: input.isolationLevel ?? 'read committed',
    },
    async (tx) => {
      await assertApplicationRole(tx);
      return applyTransition(tx, input);
    },
  );
}

/**
 * The transition itself, inside an existing transaction.
 *
 * Exported for the scheduler, which applies a batch and wants each booking in its own
 * transaction without paying for a second `assertApplicationRole` round trip per booking, and
 * for anything that has to compose a transition with another write atomically.
 */
export async function applyTransition(
  tx: Transaction,
  input: TransitionInput,
): Promise<TransitionResult> {
  const booking = await lockBooking(tx, input.bookingId);
  if (booking === null) throw errors.notFound('booking', input.bookingId);

  // The scheduler's guard. Checked **after** the row lock, so two workers that both selected
  // this booking as due find, one after the other, one application and one no-op.
  if (input.expectedNextTransition !== undefined) {
    if (
      booking.nextTransition !== input.expectedNextTransition ||
      booking.nextTransitionAt === null ||
      booking.nextTransitionAt > input.now
    ) {
      return {
        bookingId: booking.id,
        action: input.action,
        previousStatus: booking.status,
        status: booking.status,
        newBookingId: null,
        applied: false,
        refundPercent: booking.refundPercent,
        refundAmountExpected: booking.refundAmountExpected,
        noShowChargeExpected: booking.noShowChargeExpected,
        rescheduleFeeExpected: booking.rescheduleFeeExpected,
        eventIds: [],
        touchedDays: [],
        nextTransition:
          booking.nextTransition === null || booking.nextTransitionAt === null
            ? null
            : { action: booking.nextTransition, at: booking.nextTransitionAt },
      };
    }
  }

  const allowed = TRANSITIONS[booking.status] ?? {};
  const target = allowed[input.action];
  if (target === undefined) {
    throw invalidTransition(
      booking.status,
      input.action,
      Object.keys(allowed) as TransitionAction[],
    );
  }

  return input.action === 'reschedule'
    ? rescheduleBooking(tx, input, booking)
    : simpleTransition(tx, input, booking, target);
}

// --- Everything but the reschedule ---------------------------------------------------------

async function simpleTransition(
  tx: Transaction,
  input: TransitionInput,
  booking: BookingRow,
  target: BookingStatus,
): Promise<TransitionResult> {
  const before = snapshotOf(booking, await allocationsOf(tx, booking.id));
  const beforeObject = bookingEventObject(before);

  const next: Record<string, unknown> = { status: target };
  let refundPercent: number | null = booking.refundPercent;
  let refundAmountExpected: number | null = booking.refundAmountExpected;
  let noShowChargeExpected: number | null = booking.noShowChargeExpected;

  switch (input.action) {
    case 'confirm':
      next.confirmedAt = input.now;
      break;
    case 'check_in':
      next.checkedInAt = input.now;
      break;
    case 'start':
      // No `checked_in_at`: the policy started the booking, not the customer.
      break;
    case 'complete': {
      if (input.now < booking.startsAt) {
        throw completeTooEarly(
          `A booking cannot be completed before it starts; this one starts at ${new Date(booking.startsAt).toISOString()}.`,
        );
      }
      next.completedAt = input.now;
      break;
    }
    case 'cancel': {
      refundPercent = cancellationRefundPercent(input, booking);
      refundAmountExpected = Math.floor((booking.amountPaid * refundPercent) / 100);
      next.cancelledAt = input.now;
      next.cancelledBy = input.by ?? 'customer';
      next.cancellationReason = input.reason ?? null;
      next.refundPercent = refundPercent;
      next.refundAmountExpected = refundAmountExpected;
      break;
    }
    case 'no_show': {
      const graceMs = graceMinutes(booking.policySnapshot) * MINUTE_MS;
      const earliest = booking.startsAt + graceMs;
      if (input.now < earliest) {
        throw noShowTooEarly(
          `A no-show may only be recorded from ${new Date(earliest).toISOString()}, which is ${String(graceMinutes(booking.policySnapshot))} minutes after the booking starts.`,
        );
      }
      const chargePercent = noShowChargePercent(booking.policySnapshot);
      noShowChargeExpected = Math.floor(((booking.priceAmount ?? 0) * chargePercent) / 100);
      next.noShowAt = input.now;
      next.noShowChargeExpected = noShowChargeExpected;
      break;
    }
    default:
      break;
  }

  // Capacity comes back the moment the booking stops occupying, and it comes back through the
  // one door that takes the advisory locks first.
  const touchedDays: TouchedDay[] = [];
  if (OCCUPYING.has(booking.status) && !OCCUPYING.has(target)) {
    const released = await releaseOccupancies(tx, { refId: booking.id, kind: 'booking' });
    const zones = await resourceZones(
      tx,
      released.map((row) => row.resourceId),
    );
    for (const row of released) {
      touchedDays.push(
        ...touchedDaysOf([{ resourceId: row.resourceId }], zones, row.start, row.end),
      );
    }
  }

  const scheduled = nextTransitionFor(
    {
      status: target,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      checkedInAt: (next.checkedInAt as number | undefined) ?? booking.checkedInAt,
    },
    booking.policySnapshot,
  );
  next.nextTransition = scheduled?.action ?? null;
  next.nextTransitionAt = scheduled?.at ?? null;

  await writeBooking(tx, booking.id, next);

  const after = await lockBooking(tx, booking.id);
  if (after === null) throw errors.internal('The booking disappeared inside its own transaction.');
  const afterObject = bookingEventObject(snapshotOf(after, before.allocations));

  const eventId = await insertEvent(
    tx,
    input.projectId,
    input.environment,
    EVENT_TYPE[input.action],
    afterObject,
    {
      previous: previousOf(beforeObject, afterObject),
      actor: actorPayload(input),
      occurredAt: input.now,
    },
  );

  return {
    bookingId: booking.id,
    action: input.action,
    previousStatus: booking.status,
    status: target,
    newBookingId: null,
    applied: true,
    refundPercent,
    refundAmountExpected,
    noShowChargeExpected,
    rescheduleFeeExpected: booking.rescheduleFeeExpected,
    eventIds: [eventId],
    touchedDays,
    nextTransition: scheduled,
  };
}

/** The event each action writes: exactly one per transition, in the same transaction. */
const EVENT_TYPE: Record<TransitionAction, string> = {
  confirm: 'booking.confirmed',
  cancel: 'booking.cancelled',
  reschedule: 'booking.rescheduled',
  no_show: 'booking.no_show',
  check_in: 'booking.checked_in',
  complete: 'booking.completed',
  start: 'booking.started',
};

/**
 * The actor, as the caller built it, with `id` normalised to `null` when it is absent.
 *
 * It **spreads** rather than naming the fields it keeps. Naming them is how `via` was lost: the
 * route passed `{type, id, via}` and this function wrote `{type, id}`, so every event the engine
 * writes claimed the request had declared no tool. A payload that enumerates what it copies has
 * to be edited every time the shape grows, and the failure when it is not is silent.
 */
function actorPayload(input: TransitionInput): Record<string, unknown> {
  // The transition input always carries an actor, so the null branch of `actorRecord` is
  // unreachable here; `?? {}` is the type narrowing, not a fallback with a meaning.
  return actorRecord(input.actor) ?? {};
}

/**
 * `refund_percent` for a cancellation.
 *
 * The order: an explicit override wins over everything, a cancellation by the provider is a
 * full refund, and otherwise the tiers of the frozen snapshot decide. **A policy with no tiers
 * refunds nothing**, which is the conservative reading: an absent rule is not a promise, and
 * `override_refund_percent` is there for the case where the provider means to make one anyway.
 */
function cancellationRefundPercent(input: TransitionInput, booking: BookingRow): number {
  if (input.overrideRefundPercent != null) {
    const value = input.overrideRefundPercent;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw errors.invalidRequest(
        `override_refund_percent must be between 0 and 100, received ${String(value)}.`,
        'override_refund_percent',
        'parameter_invalid',
      );
    }
    return value;
  }
  if ((input.by ?? 'customer') === 'provider') return 100;
  const tier = tierFor(
    policyTiers(booking.policySnapshot, 'cancellation'),
    booking.startsAt - input.now,
  );
  return tier?.refundPercent ?? 0;
}

/** One UPDATE from a map of camelCase field names, so no call site writes SQL twice. */
async function writeBooking(
  tx: Transaction,
  bookingId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const columns: Record<string, string> = {
    status: 'status',
    confirmedAt: 'confirmed_at',
    checkedInAt: 'checked_in_at',
    cancelledAt: 'cancelled_at',
    completedAt: 'completed_at',
    noShowAt: 'no_show_at',
    rescheduledAt: 'rescheduled_at',
    cancelledBy: 'cancelled_by',
    cancellationReason: 'cancellation_reason',
    refundPercent: 'refund_percent',
    refundAmountExpected: 'refund_amount_expected',
    noShowChargeExpected: 'no_show_charge_expected',
    rescheduleFeeExpected: 'reschedule_fee_expected',
    rescheduleCount: 'reschedule_count',
    rescheduledToBookingId: 'rescheduled_to_booking_id',
    rescheduledFromBookingId: 'rescheduled_from_booking_id',
    nextTransition: 'next_transition',
    nextTransitionAt: 'next_transition_at',
  };
  const timestamps = new Set([
    'confirmedAt',
    'checkedInAt',
    'cancelledAt',
    'completedAt',
    'noShowAt',
    'rescheduledAt',
    'nextTransitionAt',
  ]);
  const assignments = [];
  for (const [key, value] of Object.entries(values)) {
    const column = columns[key];
    if (column === undefined) throw errors.internal(`Unknown booking column ${key}.`);
    const literal = timestamps.has(key)
      ? sql`${value === null ? null : new Date(value as number).toISOString()}::timestamptz`
      : sql`${value}`;
    assignments.push(sql`${sql.identifier(column)} = ${literal}`);
  }
  if (assignments.length === 0) return;
  await tx.execute(
    sql`UPDATE bookings SET ${sql.join(assignments, sql`, `)} WHERE id = ${bookingId}`,
  );
}

// --- Reschedule --------------------------------------------------------------------------------

/**
 * Moves a booking to a new instant, in one transaction, with no observable gap.
 *
 * The order below is the whole point, so it is spelled out:
 *
 * 1. the **union** of the resources (those the old booking holds and those the new one might
 *    take) is locked in ascending order of id, before anything about occupancies is read.
 *    One lock set for the whole operation is what keeps a concurrent booking from slipping
 *    between the release and the take, and the common order is what keeps two reschedules of
 *    the same pair of resources from deadlocking;
 * 2. the old booking is marked `rescheduled` and its occupancies are released;
 * 3. the new booking is created by the **same** function `POST /v1/bookings` uses: capacity
 *    verified, grid revalidated, `policy_snapshot` re-frozen, `booking.created` written;
 * 4. the two rows are linked, and the fee is recorded on the new one.
 *
 * **Why the release comes before the take, when the obvious order is the opposite.** With the old
 * occupancies still active, a reschedule whose new period *overlaps* the old one on a capacity-1
 * resource (moving a court from 10:00 to 10:30, the commonest reschedule there is) is refused by
 * the exclusion constraint `occ_no_overlap_cap1`, which looks at `active` and knows nothing about
 * the two rows belonging to the same booking. Taking first would mean either deferring that
 * constraint (weakening the one capacity guarantee the database itself makes) or teaching the
 * capacity check to ignore one reference (which would not help the constraint at all).
 *
 * What actually has to hold is that no observer ever sees the slot free or the slot
 * doubly taken, and that survives the reordering intact: the whole sequence is one
 * transaction holding the advisory locks on the union, so a concurrent **writer** waits on
 * those locks, and a concurrent **reader** takes no locks but, under `read committed`, still
 * reads the state from before the transaction: the old booking, occupying. Neither can
 * observe the intermediate state, and a failure at step 3 rolls the release back with
 * everything else, leaving the old booking exactly as it was. There is a test for each half.
 *
 * **Why two events.** Step 3 creates a booking, which is a state change of a new object, and
 * step 2 closes another one. Every state change owes exactly one event, and there are two
 * transitions here: `booking.created` for the new booking (byte for byte the event a plain
 * creation writes, so a consumer mirroring bookings needs no special case) and
 * `booking.rescheduled` for the old one, carrying `rescheduled_to_booking_id` and a
 * `data.previous` with the status and the instants it had. Either event alone lets a consumer
 * find the other.
 */
async function rescheduleBooking(
  tx: Transaction,
  input: TransitionInput,
  booking: BookingRow,
): Promise<TransitionResult> {
  if (input.start === undefined) {
    throw errors.invalidRequest('A reschedule needs the new start.', 'start', 'parameter_missing');
  }

  const limit = maxReschedules(booking.policySnapshot);
  if (limit !== null && booking.rescheduleCount >= limit) {
    throw maxReschedulesReached(
      `Booking ${encodeId('booking', booking.id)} has already been rescheduled ${String(booking.rescheduleCount)} times and the policy allows ${String(limit)}.`,
    );
  }

  const before = snapshotOf(booking, await allocationsOf(tx, booking.id));
  const beforeObject = bookingEventObject(before);

  // Step 1: the union, locked once, in one order. `takeOccupancy` will ask for its own subset
  // again inside `take`; advisory locks are re-entrant within a transaction, and because this
  // set is a superset taken in the same ascending order, nothing new is acquired later.
  const heldResources = await occupiedResources(tx, booking.id);
  const candidates = await candidateResourceIds(tx, booking.serviceId);
  const wanted =
    input.resourceIds == null || input.resourceIds.length === 0
      ? candidates
      : candidates.filter((id) => input.resourceIds!.includes(id));
  await lockResources(tx, [...new Set([...heldResources, ...wanted, ...candidates])]);

  // Step 2. The status moves **before** the new booking is created, and not only for
  // tidiness: `loadAvailabilityData` counts the customer's active bookings for
  // `max_active_bookings_per_customer`, and a customer sitting exactly on that limit must be
  // able to move a booking without first cancelling it.
  const releasedDays: TouchedDay[] = [];
  const released = await releaseOccupancies(tx, { refId: booking.id, kind: 'booking' });
  const releasedZones = await resourceZones(
    tx,
    released.map((row) => row.resourceId),
  );
  for (const row of released) {
    releasedDays.push(
      ...touchedDaysOf([{ resourceId: row.resourceId }], releasedZones, row.start, row.end),
    );
  }
  await writeBooking(tx, booking.id, {
    status: 'rescheduled',
    rescheduledAt: input.now,
    nextTransition: null,
    nextTransitionAt: null,
  });

  // Step 3. The fee is computed **before** the creation, from the tiers of the **old**
  // booking's frozen policy (the one the customer agreed to), because it has to travel into
  // the `INSERT` with the link and the counter, not follow it in an `UPDATE`: the
  // `booking.created` event is written inside `take`, and an event is never corrected.
  const tier = tierFor(
    policyTiers(booking.policySnapshot, 'reschedule'),
    booking.startsAt - input.now,
  );
  const fee = tier?.fee ?? 0;

  // Step 4: the same creation as `POST /v1/bookings`, with the old booking's own shape. The
  // new booking's automatic clock is set by `insertBooking`, from the same `nextTransitionFor`
  // every transition uses, so there is nothing left to fix up afterwards either.
  const created = await take(tx, {
    projectId: input.projectId,
    environment: input.environment,
    serviceId: booking.serviceId,
    start: input.start,
    durationMinutes: Math.round((booking.endsAt - booking.startsAt) / MINUTE_MS),
    quantity: booking.quantity,
    resourceIds: input.resourceIds ?? null,
    customerId: booking.customerId,
    kind: 'booking',
    now: input.now,
    source: booking.source as 'api' | 'widget' | 'portal' | 'import',
    notes: booking.notes,
    metadata: booking.metadata,
    reschedule: {
      fromBookingId: booking.id,
      count: booking.rescheduleCount + 1,
      feeExpected: fee,
    },
  });

  // Step 5. The only write left is on the **old** booking, whose event has not been written
  // yet, so it is in time.
  await writeBooking(tx, booking.id, { rescheduledToBookingId: created.id });

  const after = await lockBooking(tx, booking.id);
  if (after === null) throw errors.internal('The booking disappeared inside its own transaction.');
  const afterObject = bookingEventObject(snapshotOf(after, before.allocations));

  const rescheduledEventId = await insertEvent(
    tx,
    input.projectId,
    input.environment,
    'booking.rescheduled',
    afterObject,
    {
      previous: previousOf(beforeObject, afterObject),
      actor: actorPayload(input),
      occurredAt: input.now,
    },
  );

  return {
    bookingId: booking.id,
    action: 'reschedule',
    previousStatus: booking.status,
    status: 'rescheduled',
    newBookingId: created.id,
    applied: true,
    refundPercent: booking.refundPercent,
    refundAmountExpected: booking.refundAmountExpected,
    noShowChargeExpected: booking.noShowChargeExpected,
    rescheduleFeeExpected: fee,
    // `booking.created` first: it is the event the new booking's existence begins with.
    eventIds: [created.eventId, rescheduledEventId],
    touchedDays: [...releasedDays, ...created.touchedDays],
    nextTransition: null,
  };
}

/** The resources a booking's active occupancies sit on. */
async function occupiedResources(tx: Transaction, bookingId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ resource_id: string }>(sql`
    SELECT DISTINCT resource_id FROM occupancies
     WHERE ref_id = ${bookingId} AND kind = 'booking' AND active
     ORDER BY resource_id
  `);
  return rows.map((row) => row.resource_id);
}

// --- The scheduler's half ----------------------------------------------------------------------

export interface DueTransition {
  readonly bookingId: string;
  readonly action: AutomaticTransition;
  readonly at: number;
}

/**
 * The bookings whose automatic transition is due, oldest first.
 *
 * Ordered by `next_transition_at` so a backlog is worked through in the order it accumulated,
 * and capped so one project with ten thousand overdue bookings cannot hold a transaction (or
 * the worker) for minutes. Reads only the partial index of migration 0011.
 */
export async function dueTransitions(
  tx: Transaction,
  now: number,
  limit: number,
): Promise<DueTransition[]> {
  const { rows } = await tx.execute<{
    id: string;
    next_transition: AutomaticTransition;
    due_ms: string;
  }>(sql`
    SELECT id, next_transition,
           (extract(epoch FROM next_transition_at) * 1000)::bigint AS due_ms
      FROM bookings
     WHERE next_transition IS NOT NULL
       AND next_transition_at <= ${new Date(now).toISOString()}::timestamptz
     ORDER BY next_transition_at, id
     LIMIT ${limit}
  `);
  return rows.map((row) => ({
    bookingId: row.id,
    action: row.next_transition,
    at: Number(row.due_ms),
  }));
}
