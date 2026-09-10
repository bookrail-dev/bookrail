/**
 * The shape a booking has inside an event.
 *
 * An event carries `data.object` (a snapshot of the booking) and `data.previous` for the fields
 * that changed. That snapshot has to be **one** shape: a consumer that mirrors bookings receives
 * `booking.created` from the creation and `booking.cancelled` from a transition, and if the two
 * carried different sets of fields the mirror would silently lose a column on every update. So both
 * paths build the object here, from the same struct, and neither writes an object literal of its
 * own.
 *
 * Identifiers are the **public**, prefixed ones: an event is something a customer's system reads,
 * and it must never have to know that the database stores bare UUIDs. Instants are ISO 8601 in UTC.
 *
 * Nothing here reads the database: the caller passes what it already has. The creation has it
 * in memory, and a transition has it in the row it locked.
 */
import { encodeId, type PriceRuleRef } from '@bookrail/shared';

/** One allocation, as it appears inside a booking snapshot. */
export interface SnapshotAllocation {
  readonly resourceId: string;
  readonly role: string | null;
  readonly capacityUsed: number;
}

/**
 * Every field of a booking an event exposes.
 *
 * Deliberately flat and deliberately complete: adding a column to `bookings` and forgetting it
 * here makes the event a partial view of the object, which is the failure mode this type
 * exists to make visible.
 */
export interface BookingSnapshot {
  readonly id: string;
  readonly status: string;
  readonly serviceId: string;
  readonly customerId: string | null;
  readonly holdId: string | null;
  readonly start: number;
  readonly end: number;
  readonly timezone: string;
  readonly quantity: number;
  readonly price: { readonly amount: number; readonly currency: string } | null;
  /** Which `services.pricing_rules` entry priced it; `null` for the flat service price. */
  readonly priceRule: PriceRuleRef | null;
  readonly amountPaid: number;
  readonly amountDue: number;
  readonly amountRefunded: number;
  readonly source: string;
  readonly notes: string | null;
  readonly tenantId: string | null;
  readonly cancelledBy: string | null;
  readonly cancellationReason: string | null;
  readonly refundPercent: number | null;
  readonly refundAmountExpected: number | null;
  readonly noShowChargeExpected: number | null;
  readonly rescheduleFeeExpected: number | null;
  readonly rescheduleCount: number;
  readonly rescheduledFromBookingId: string | null;
  readonly rescheduledToBookingId: string | null;
  readonly confirmedAt: number | null;
  readonly checkedInAt: number | null;
  readonly cancelledAt: number | null;
  readonly completedAt: number | null;
  readonly noShowAt: number | null;
  readonly rescheduledAt: number | null;
  readonly nextTransition: string | null;
  readonly nextTransitionAt: number | null;
  readonly allocations: readonly SnapshotAllocation[];
}

/**
 * A booking never expires, so this is always `null`, and it is here on purpose.
 *
 * `booking.created` used to come out of the same builder as `hold.created` and
 * therefore carried `expires_at: null`. Dropping the key would have changed a public event
 * from `null` to `undefined` for anyone reading `event.data.object.expires_at`, which is a
 * contract change dressed up as a refactor. It costs one line to
 * keep the payload purely additive, so it stays.
 */
const BOOKING_EXPIRES_AT = null;

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

export function bookingEventObject(snapshot: BookingSnapshot): Record<string, unknown> {
  return {
    id: encodeId('booking', snapshot.id),
    object: 'booking',
    status: snapshot.status,
    service_id: encodeId('service', snapshot.serviceId),
    customer_id: snapshot.customerId === null ? null : encodeId('customer', snapshot.customerId),
    hold_id: snapshot.holdId === null ? null : encodeId('hold', snapshot.holdId),
    expires_at: BOOKING_EXPIRES_AT,
    start: iso(snapshot.start),
    end: iso(snapshot.end),
    timezone: snapshot.timezone,
    quantity: snapshot.quantity,
    price: snapshot.price,
    price_rule: snapshot.priceRule,
    amount_paid: snapshot.amountPaid,
    amount_due: snapshot.amountDue,
    amount_refunded: snapshot.amountRefunded,
    source: snapshot.source,
    notes: snapshot.notes,
    tenant_id: snapshot.tenantId,
    cancelled_by: snapshot.cancelledBy,
    cancellation_reason: snapshot.cancellationReason,
    refund_percent: snapshot.refundPercent,
    refund_amount_expected: snapshot.refundAmountExpected,
    no_show_charge_expected: snapshot.noShowChargeExpected,
    reschedule_fee_expected: snapshot.rescheduleFeeExpected,
    reschedule_count: snapshot.rescheduleCount,
    rescheduled_from_booking_id:
      snapshot.rescheduledFromBookingId === null
        ? null
        : encodeId('booking', snapshot.rescheduledFromBookingId),
    rescheduled_to_booking_id:
      snapshot.rescheduledToBookingId === null
        ? null
        : encodeId('booking', snapshot.rescheduledToBookingId),
    confirmed_at: iso(snapshot.confirmedAt),
    checked_in_at: iso(snapshot.checkedInAt),
    cancelled_at: iso(snapshot.cancelledAt),
    completed_at: iso(snapshot.completedAt),
    no_show_at: iso(snapshot.noShowAt),
    rescheduled_at: iso(snapshot.rescheduledAt),
    next_transition: snapshot.nextTransition,
    next_transition_at: iso(snapshot.nextTransitionAt),
    allocations: snapshot.allocations.map((allocation) => ({
      resource_id: encodeId('resource', allocation.resourceId),
      role: allocation.role,
      capacity_used: allocation.capacityUsed,
    })),
  };
}

/**
 * `data.previous`: the entries of `before` whose value the transition changed.
 *
 * Computed by comparing the two whole snapshots rather than by listing, at each call site,
 * which fields that particular action touches. Those lists are always right the day they are
 * written and wrong the first time somebody adds a field, and `previous` being wrong is
 * worse than `previous` being absent, because a consumer uses it to decide what to redraw.
 *
 * `null` when nothing changed, so an event never carries an empty object that a reader would
 * have to tell apart from "no previous state".
 */
export function previousOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> | null {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(before)) {
    if (JSON.stringify(value) !== JSON.stringify(after[key])) previous[key] = value;
  }
  return Object.keys(previous).length === 0 ? null : previous;
}
