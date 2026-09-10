/**
 * The vocabulary of the booking transaction: what goes in, what comes out, and the error codes
 * it raises, which are the codes the public API reports verbatim.
 *
 * Identifiers in and out are bare UUIDs, exactly as in the availability engine: prefixing
 * them (`bk_…`, `hold_…`) is the API's job, and so is turning these `BookrailError`s into
 * HTTP responses.
 */
import { BookrailError, type Environment, type PriceRuleRef } from '@bookrail/shared';

/**
 * Who the write is attributed to, as it lands in `events.actor`.
 *
 * A **type alias and not an interface**, deliberately: TypeScript gives an object type alias an
 * implicit index signature, so a `TransitionActor` is assignable to the
 * `Record<string, unknown>` that `insertEvent` takes, and an interface is not. That difference
 * is the whole reason `routes/bookings.ts` used to carry an `as unknown as TransitionActor`
 * cast.
 *
 * `via` is the tool that declared itself with the `Bookrail-Actor` header. It is **absent**,
 * never `null`, when the caller declared nothing:
 * "this request did not name a tool" is a different statement from "this request named none",
 * and the engine must pass through what the route built rather than rebuilding it: a payload
 * recomposed from a list of named fields silently drops whatever the list does not mention,
 * which is exactly how `via` went missing.
 */
export type TransitionActor = {
  readonly type: 'api' | 'customer' | 'provider' | 'system';
  /** Free form: an API key id, a customer id, or nothing for the scheduler. */
  readonly id?: string | null;
  /** The tool the caller declared, when it declared one. */
  readonly via?: 'mcp' | 'cli' | 'sdk' | 'dashboard';
};

/**
 * Shared by the transitions, the creation and the hold release.
 *
 * `null` when there is no actor at all, which is what `events.actor` then stores. An absent
 * actor is not the same claim as `{type: "system"}`: the scheduler names itself, and a caller
 * of the engine that is not the HTTP layer (a test, a script) names nobody.
 */
export function actorRecord(
  actor: TransitionActor | null | undefined,
): Record<string, unknown> | null {
  if (actor === null || actor === undefined) return null;
  return { ...actor, id: actor.id ?? null };
}

export type BookingKind = 'hold' | 'booking';

/** `bookings.status` as a creation can produce it; the rest of the life cycle comes later. */
export type InitialBookingStatus = 'pending' | 'confirmed';

/**
 * One request to take capacity away.
 *
 * `kind: 'hold'` writes a `holds` row plus its occupancies; `kind: 'booking'` writes a
 * `bookings` row, its `booking_allocations` and its occupancies, or, with `holdId`, converts
 * an existing hold without asking for the capacity a second time.
 */
export interface CreateBookingInput {
  readonly projectId: string;
  readonly environment: Environment;
  /** Bare UUID of the service. */
  readonly serviceId: string;
  /** Start of the booking, epoch milliseconds. */
  readonly start: number;
  /** One of the durations the service offers; defaults to the first one. */
  readonly durationMinutes?: number | null;
  /** Units of capacity requested; defaults to `services.capacity_per_booking`. */
  readonly quantity?: number | null;
  /** When present, only these resources may be allocated. */
  readonly resourceIds?: readonly string[] | null;
  readonly customerId?: string | null;
  readonly kind: BookingKind;
  /** `kind: 'booking'` only: the hold to convert. */
  readonly holdId?: string | null;
  /** `kind: 'hold'` only: overrides `policies.hold_duration_seconds`. */
  readonly ttlSeconds?: number | null;
  /** The instant the request is evaluated at. Explicit: the engine never reads the clock. */
  readonly now: number;
  readonly source?: 'api' | 'widget' | 'portal' | 'import';
  readonly notes?: string | null;
  readonly metadata?: Record<string, unknown>;
  /**
   * How many times a serialization failure (`40001`) or a deadlock (`40P01`) is retried.
   * Three by default; above that, heavy contention turns retries into queueing rather than
   * into throughput.
   */
  readonly maxRetries?: number;
  /**
   * Isolation level of the transaction. `read committed` by default, and the reason is in the
   * header of `create.ts`: the capacity check runs **after** the advisory lock, and only under
   * `read committed` does it then see what the lock was taken to wait for.
   */
  readonly isolationLevel?: 'read committed' | 'serializable';
  /**
   * Set only by a reschedule: the link back to the booking this one replaces, the running
   * count, and the fee the old booking's policy asks for.
   *
   * It travels **into** the creation rather than being written after it, and that is the whole
   * point: `insertBooking` puts these three values in the same `INSERT` as the rest of the
   * row, so the `booking.created` event carries them. Written afterwards, they would be
   * missing from the one event that announces the new booking's existence, and `events` is
   * append-only: nothing could ever correct it, and a consumer mirroring bookings would be
   * permanently wrong about a fee in cents.
   */
  readonly reschedule?: RescheduleOrigin | null;
  /**
   * Who is asking, as it lands in `events.actor` of `booking.created` / `hold.created`.
   *
   * Optional because the engine has callers that are not the HTTP layer (tests, scripts, the
   * reschedule path), and an absent actor writes a NULL, which is the honest record of "nobody
   * said". The routes always pass it: before that the creation events
   * were the only writes of the system whose `actor` was NULL even when a credential had
   * plainly made them.
   */
  readonly actor?: TransitionActor | null;
}

/** Where a booking came from, when it came from a reschedule. */
export interface RescheduleOrigin {
  /** Bare UUID of the booking being replaced. */
  readonly fromBookingId: string;
  /** `bookings.reschedule_count` of the old booking, plus one. */
  readonly count: number;
  /** `reschedule_fee_expected`, from the tiers of the **old** booking's frozen policy. */
  readonly feeExpected: number;
}

export interface ReleaseHoldInput {
  readonly projectId: string;
  readonly environment: Environment;
  readonly holdId: string;
  readonly now: number;
  readonly maxRetries?: number;
  readonly isolationLevel?: 'read committed' | 'serializable';
  /** Who is releasing, for `events.actor` of `hold.released`. See {@link CreateBookingInput.actor}. */
  readonly actor?: TransitionActor | null;
}

/** One resource the request took, with the units it took from it. */
export interface AllocatedResource {
  readonly resourceId: string;
  readonly role: string | null;
  readonly capacityUsed: number;
  /** The `occupancies` row that holds it. */
  readonly occupancyId: string;
}

/** One (resource, local day) whose availability cache the caller has to drop. */
export interface TouchedDay {
  readonly resourceId: string;
  /** `YYYY-MM-DD` in the resource's own zone. */
  readonly day: string;
}

export interface CreateBookingResult {
  readonly kind: BookingKind;
  /** The booking id, or the hold id when `kind` is `hold`. */
  readonly id: string;
  readonly serviceId: string;
  readonly customerId: string | null;
  /** The hold this booking was converted from, when there was one. */
  readonly holdId: string | null;
  readonly start: number;
  readonly end: number;
  readonly durationMinutes: number;
  readonly quantity: number;
  readonly timezone: string;
  readonly status: InitialBookingStatus | 'active';
  /** `kind: 'hold'` only. */
  readonly expiresAt: number | null;
  readonly price: { readonly amount: number; readonly currency: string } | null;
  /**
   * Which `services.pricing_rules` entry produced {@link price}, `null` for the flat price.
   *
   * A hold carries it too, even though `holds` has no column for it: the hold's answer is a
   * quote, and saying which rule made the quote is the whole point of the field.
   */
  readonly priceRule: PriceRuleRef | null;
  readonly policySnapshot: Record<string, unknown> | null;
  readonly allocations: readonly AllocatedResource[];
  /** The `events` row written in the same transaction. */
  readonly eventId: string;
  /**
   * The (resource, local day) pairs the write touched.
   *
   * The caller must call `invalidateResourceDay` for each of them **after** the commit:
   * `avail:occ:{resource}:{day}` is the one cache family a booking makes stale, and the
   * obligation to drop it belongs to the caller. Invalidating from inside the transaction would
   * drop the entry before the row is visible, and a concurrent read would put the stale value
   * back.
   */
  readonly touchedDays: readonly TouchedDay[];
}

export interface ReleaseHoldResult {
  readonly holdId: string;
  /** `false` when the hold was already released: releasing twice is not an error. */
  readonly released: boolean;
  readonly eventId: string | null;
  readonly touchedDays: readonly TouchedDay[];
}

// --- Errors -------------------------------------------------------------------------------

/** 409. The capacity is gone. `requested` and `available` are in the message, as `05` shows. */
export function slotUnavailable(
  requested: number,
  available: number,
  detail?: string,
): BookrailError {
  const tail = detail === undefined ? '' : ` ${detail}`;
  return new BookrailError(
    'conflict',
    'slot_unavailable',
    `The requested slot is no longer available. ${String(requested)} unit${requested === 1 ? '' : 's'} requested, ${String(available)} available.${tail}`,
    'start',
  );
}

/** 422. The instant is past `booking_window.max_advance_days`, or in the past. */
export function outsideBookingWindow(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'outside_booking_window', detail, 'start');
}

/** 422. The instant is inside `booking_window.min_notice_minutes`. */
export function minNoticeViolated(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'min_notice_violated', detail, 'start');
}

/** 422. `policies.max_active_bookings_per_customer` is already reached. */
export function customerLimitReached(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'customer_limit_reached', detail, 'customer_id');
}

/** 400. A forced resource is not a candidate of any requirement of the service. */
export function resourceNotEligible(detail: string): BookrailError {
  return new BookrailError('invalid_request', 'resource_not_eligible', detail, 'resource_ids');
}

/**
 * 422. The instant is not one the availability grid of this service would ever offer.
 *
 * Only for a service that defines a grid (`slot_interval_minutes` or `align_to`), because a
 * service with neither (a rental, a duration range) has no grid to be off.
 */
export function startNotOnGrid(detail: string): BookrailError {
  return new BookrailError('policy_violation', 'start_not_on_grid', detail, 'start');
}

/** 409. The hold expired between the hold and the conversion. */
export function holdExpired(detail: string): BookrailError {
  return new BookrailError('conflict', 'hold_expired', detail, 'hold_id');
}

/** 409. The hold exists but was already released or already converted. */
export function holdNotActive(detail: string): BookrailError {
  return new BookrailError('conflict', 'hold_not_active', detail, 'hold_id');
}

/**
 * 409. The transaction could not be serialized after every retry.
 *
 * It is a `conflict` and not an `internal` on purpose: nothing is broken, the request raced
 * with another one and the client may simply send it again.
 */
export function serializationFailure(attempts: number): BookrailError {
  return new BookrailError(
    'conflict',
    'serialization_failure',
    `The booking transaction could not be serialized after ${String(attempts)} attempts; retry the request.`,
  );
}
