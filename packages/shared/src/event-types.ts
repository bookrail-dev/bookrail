/**
 * The event types a webhook may subscribe to.
 *
 * Two lists, because they answer two different questions.
 *
 * {@link EMITTED_EVENT_TYPES} is what the system writes **today**. It is the honest answer to
 * "what will I actually receive", and the API test suite compares it with what the engine emits
 * so the two cannot drift apart in silence.
 *
 * {@link SUBSCRIBABLE_EVENT_TYPES} is what `POST /v1/webhooks` accepts, and it is deliberately
 * wider: it contains every type the webhook documentation lists, including the ones that will
 * exist when payments, waitlists and entitlements do. An integration that is being written against
 * the documented roadmap must be able to register for `payment.succeeded` before the day it
 * starts arriving, and a customer who spells `booking.canceled` must still be told they made a
 * typo. A list that only contained today's types would refuse the first and accept neither.
 *
 * `webhook.*` is in neither list. Those events are about the delivery machinery itself
 * (`webhook.failing`, `webhook.test`), and a webhook that reported on webhooks would be a loop:
 * a failing endpoint would generate the event that generates the delivery that fails.
 */

/** Subscribe to everything, including types added after the endpoint was registered. */
export const EVENT_TYPE_WILDCARD = '*';

/**
 * What the engine and the API actually write into `events`.
 *
 * The `booking.*`, `hold.*` and `plan.*` types are written by the engine; the two `stripe.*` ones are
 * written by `/v1/stripe`, which is the first part of the API that records something of its
 * own in a project's log; the three `payment.*` ones are written by the Stripe webhook
 * receiver, which is the first part that records something a **provider** did.
 * `webhooks.test.ts` reads both sources and refuses a type that is in one and not the other.
 */
export const EMITTED_EVENT_TYPES = [
  'booking.created',
  'booking.confirmed',
  'booking.checked_in',
  'booking.started',
  'booking.completed',
  'booking.cancelled',
  'booking.no_show',
  'booking.rescheduled',
  'booking.orphaned',
  'hold.created',
  'hold.released',
  'hold.expired',
  'stripe.connected',
  'stripe.disconnected',
  // Written by the Stripe webhook receiver, after a verified signature and never before.
  // They are the only events of this system whose cause is outside it.
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  // Written by the engine, in the live environment only, when an account reaches 80 % or 100 %
  // of the bookings its plan includes in a month: once per account, month and threshold, in the
  // log of the project whose booking crossed it.
  'plan.usage_warning',
  // Written by the database, in the same transaction that changes the plan of an account, in the
  // live log of every project of that account: by a signed Stripe Billing event, or by an
  // operator's `bookrail-plan`.
  'plan.changed',
] as const;

/** Every documented type, emitted today or not. A superset of {@link EMITTED_EVENT_TYPES}. */
export const SUBSCRIBABLE_EVENT_TYPES = [
  ...EMITTED_EVENT_TYPES,
  'booking.updated',
  'booking.reminder_due',
  'hold.converted',
  'waitlist.added',
  'waitlist.slot_available',
  'waitlist.offer_expired',
  'entitlement.consumed',
  'entitlement.expiring',
  'entitlement.exhausted',
  'resource.updated',
  'resource.blocked',
  'schedule.updated',
  'availability.changed',
] as const;

/** Prefix of the events about the delivery machinery, which are never themselves delivered. */
export const INTERNAL_EVENT_PREFIX = 'webhook.';

/** An endpoint has started failing: the last retry of a delivery to it was refused. */
export const WEBHOOK_FAILING_EVENT = 'webhook.failing';

/** `POST /v1/webhooks/{id}/test`: a synthetic delivery, recorded like any other. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export function isSubscribableEventType(value: string): boolean {
  return (
    value === EVENT_TYPE_WILDCARD || (SUBSCRIBABLE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Does an endpoint subscribed to `subscriptions` want an event of this type? */
export function subscribes(subscriptions: readonly string[], type: string): boolean {
  if (type.startsWith(INTERNAL_EVENT_PREFIX)) return false;
  for (const subscription of subscriptions) {
    if (subscription === EVENT_TYPE_WILDCARD || subscription === type) return true;
  }
  return false;
}
