/**
 * The states in which a Stripe subscription is one the account still has.
 *
 * The definition is the database's, `billing_subscription_is_live` of migration 0027, which the
 * receiver, the dashboard, `bookrail-plan` and the jobs ask. This copy exists for the places that
 * ask Stripe instead of the database: the list of a customer's subscriptions read before a
 * checkout is opened, and the instant the daily reconciliation records a subscription read back
 * from Stripe at. `billing.test.ts` compares the two on every status Stripe has.
 *
 * `unpaid` and `paused` are dead: the account is on the free plan, a new checkout is allowed,
 * and the daily job cancels them at Stripe so that they stop invoicing.
 */
export const LIVE_SUBSCRIPTION_STATUSES = ['incomplete', 'trialing', 'active', 'past_due'] as const;

/** Every status a Stripe subscription can have, for the test of the two definitions. */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? '');
}
