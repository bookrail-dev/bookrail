/**
 * The plans of Bookrail, in one place.
 *
 * A plan is what an account pays for, and it decides four things this code reads: how many live
 * bookings a month are included, how much paid volume a month is included, whether the account
 * is stopped when it reaches the first of the two, and how fast a live key of that account may
 * call the API. Projects and members are here too because the pricing table states them, and a
 * table that silently dropped two of its rows would be a second, different table; nothing
 * enforces them yet.
 *
 * ## What counts
 *
 * A **booking** is a booking of the live environment that reaches `confirmed`, once. A
 * cancellation, a hold, a no-show or a reschedule does not count again, and nothing that happens
 * in the test environment ever counts. The **paid volume** is the sum of the live payments that
 * succeeded in the month, in the minor unit, net of the refunds made in the month.
 *
 * ## Why only the free plan blocks
 *
 * Above the included quantity a paying plan is billed for the difference, which is not something
 * to refuse a booking over. The free plan has nobody to bill, so reaching its threshold is where
 * new live bookings stop (`402 plan_limit_reached`) until the account moves to a paying plan.
 *
 * ## The month
 *
 * A calendar month in UTC, written `YYYY-MM`. UTC and not the zone of the account because an
 * account with projects in two zones still has one threshold, and a month that began at a
 * different instant for each of its projects would not be one month.
 */

export const PLAN_IDS = ['free', 'pro', 'scale', 'enterprise'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Confirmed live bookings included per month. `null` means negotiated, and never blocks. */
  bookingsIncluded: number | null;
  /**
   * Paid volume included per month, in the minor unit (cents). `null` means unlimited: the
   * volume of a paying plan is billed as a percentage, not capped.
   */
  paymentVolumeIncluded: number | null;
  /** Whether reaching an included quantity refuses the next live booking. The free plan only. */
  blocksAtLimit: boolean;
  /** The rate limit of a live key of this plan: requests per second, and the burst. */
  rateLimit: { rate: number; burst: number };
  /** Projects per account. `null` is unlimited. Stated, not yet enforced. */
  projects: number | null;
  /** Members per account. `null` is unlimited. Stated, not yet enforced: members do not exist. */
  members: number | null;
}

export type PlanTable = Readonly<Record<PlanId, PlanLimits>>;

/**
 * The published numbers.
 *
 * The free volume is 1 000 euro written in cents. Enterprise is negotiated per contract, and
 * until a contract says otherwise it has the rate limit of the scale plan and nothing that
 * counts against it.
 */
export const PLANS: PlanTable = {
  free: {
    bookingsIncluded: 1000,
    paymentVolumeIncluded: 100_000,
    blocksAtLimit: true,
    rateLimit: { rate: 20, burst: 40 },
    projects: 2,
    members: 3,
  },
  pro: {
    bookingsIncluded: 5000,
    paymentVolumeIncluded: null,
    blocksAtLimit: false,
    rateLimit: { rate: 100, burst: 500 },
    projects: null,
    members: 10,
  },
  scale: {
    bookingsIncluded: 50_000,
    paymentVolumeIncluded: null,
    blocksAtLimit: false,
    rateLimit: { rate: 500, burst: 2500 },
    projects: null,
    members: null,
  },
  enterprise: {
    bookingsIncluded: null,
    paymentVolumeIncluded: null,
    blocksAtLimit: false,
    rateLimit: { rate: 500, burst: 2500 },
    projects: null,
    members: null,
  },
};

/** The two plans that are bought in self service, through Stripe Checkout. */
export const PAID_PLAN_IDS = ['pro', 'scale'] as const;

export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return typeof value === 'string' && (PAID_PLAN_IDS as readonly string[]).includes(value);
}

/**
 * What the two paid plans cost, in whole numbers only.
 *
 * Every amount is in the minor unit of the euro (cents), and the price of the orchestrated
 * payments is **per mille** of the volume rather than a percentage with a decimal point: 0.4 %
 * is 4 per mille. Nothing that becomes money is ever a floating point number, here or where it
 * is used (`packages/api/src/billing/overage.ts`), and the rounding of a per mille amount is
 * written once, in {@link perMilleOf}.
 *
 * The prices are **VAT excluded**: Bookrail sells to businesses only, and the tax is added on
 * the invoice according to the country of the customer.
 *
 * This is the one statement of the prices in the code. The pricing page of the website reads it
 * (and prints euro), the checkout and the overage lines read it, and the setup script of the
 * Stripe catalogue reads it; a test compares it with the internal pricing document.
 */
export interface PlanPrice {
  /** The monthly price, in cents. */
  monthly: number;
  /** A confirmed live booking past the included ones, in cents. */
  extraBooking: number;
  /** The price of the orchestrated payments, per mille of the month's paid volume. */
  paymentsPerMille: number;
}

export const PLAN_PRICES: Readonly<Record<PaidPlanId, PlanPrice>> = {
  pro: { monthly: 2900, extraBooking: 3, paymentsPerMille: 4 },
  scale: { monthly: 24_900, extraBooking: 2, paymentsPerMille: 3 },
};

/** The currency of every price above. Lower case, which is how Stripe writes it. */
export const PLAN_PRICE_CURRENCY = 'eur';

/**
 * `amount * perMille / 1000`, rounded half up to the cent, in integers.
 *
 * Half up and not half to even: a customer reading `0.4 % of 1,234.50 EUR` expects the school
 * rounding of `4.938` to `4.94`, and the difference between the two rules is at most one cent a
 * month. A negative amount (a month with more refunds than payments) is treated as zero.
 */
export function perMilleOf(amount: number, perMille: number): number {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(perMille) || perMille < 0) {
    throw new Error('perMilleOf takes two safe integers and a non negative rate.');
  }
  if (amount <= 0) return 0;
  return Math.floor((amount * perMille + 500) / 1000);
}

/** The percentages of the included bookings at which the owner of an account is told. */
export const PLAN_WARNING_THRESHOLDS = [80, 100] as const;

export type PlanWarningThreshold = (typeof PLAN_WARNING_THRESHOLDS)[number];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

/**
 * The plan an account row names, or `free` for anything this build does not know.
 *
 * The database refuses an unknown value with a CHECK, so the fallback is for a row read by an
 * older build after a newer one has added a plan: treating it as the most restrictive plan is
 * the direction that cannot open anything by mistake.
 */
export function planOf(value: unknown): PlanId {
  return isPlanId(value) ? value : 'free';
}

/** `YYYY-MM` of an instant, in UTC. */
export function planMonthOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${month}`;
}

/**
 * The warning thresholds a count has reached, for a plan that has an included quantity.
 *
 * `[]` for a plan with no included bookings: there is nothing to be a percentage of. The
 * comparison is done in whole numbers (`count * 100 >= included * threshold`), so that 800 of
 * 1 000 is exactly 80 and no rounding can move a warning by one booking.
 */
export function reachedThresholds(count: number, included: number | null): PlanWarningThreshold[] {
  if (included === null || included <= 0) return [];
  return PLAN_WARNING_THRESHOLDS.filter((threshold) => count * 100 >= included * threshold);
}
