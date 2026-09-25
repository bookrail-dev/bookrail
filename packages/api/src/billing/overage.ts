/**
 * What a paid plan owes at the end of a month, beyond its monthly price.
 *
 * Two lines, computed in whole numbers of cents from the usage counter of the closed month and
 * the prices in the code:
 *
 *   bookings   max(0, confirmed - included) × the price of one booking over the quantity
 *   payments   the per mille of the month's paid volume beyond the included volume, rounded half
 *              up to the cent
 *
 * **The included quantities are pro rata by days** (decision of the founder of 25 September
 * 2026): for each plan that served the account in the month, its included quantity × the days
 * on that plan / the days of the month, added up and rounded **up** to the whole booking and the
 * whole cent (a fraction is never charged). A day belongs to the plan in force at its end (see
 * `billing_overage_context` and migration 0028): a move up counts from its own day, a move down
 * at midnight of the first from the next month. The free plan counts with its own quantities for
 * its days: 1,000 bookings and 1,000 € of paid volume a month, pro rata; Pro and Scale include
 * no volume (the per mille applies to all of it on their days). What goes beyond is billed at the
 * prices of the plan of the last day, or, when the last day was free (a subscription that ended
 * in the middle of the month), of the last paid plan that served the month.
 *
 * A month that was never on a paid plan owes nothing (the free plan refuses at its threshold
 * instead), and one with a day on `enterprise` is billed by its contract. Nothing here is a
 * floating point number. The per mille is `PLAN_PRICES[plan].paymentsPerMille` and the rounding is
 * `perMilleOf` of `@bookrail/shared`, written once, and computed again by the database when the
 * claim is written (a row check keeps the two equal).
 */
import {
  PLAN_PRICE_CURRENCY,
  PLAN_PRICES,
  isPaidPlanId,
  perMilleOf,
  type PaidPlanId,
  type PlanTable,
} from '@bookrail/shared';
import { ORCHESTRATED_PAYMENTS_PRODUCT_ID, OVERAGE_BOOKINGS_PRODUCT_ID } from './catalog.js';

export interface OverageUsage {
  bookingsConfirmed: number;
  paymentVolume: number;
  currency: string | null;
}

/** The days of a month on each plan, and the plan whose prices bill it. */
export interface MonthOfPlans {
  /** The paid plan of the last day, or the last paid plan of the month; `null` when none. */
  plan: string | null;
  daysInMonth: number;
  days: Readonly<Record<'free' | 'pro' | 'scale' | 'enterprise', number>>;
}

export interface Overage {
  plan: PaidPlanId;
  bookingsConfirmed: number;
  bookingsIncluded: number;
  bookingsOver: number;
  bookingUnitAmount: number;
  bookingsAmount: number;
  paymentVolume: number;
  paymentVolumeIncluded: number;
  paymentsPerMille: number;
  paymentsAmount: number;
  volumeCurrency: string | null;
}

/** `ceil(numerator / denominator)` for non negative safe integers, without a float. */
function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

/**
 * The included quantities of a month, pro rata by days: the sum over the plans of the month of
 * `quantity × days`, divided by the days of the month and rounded up. A plan that includes no
 * volume (`null`, Pro and Scale) counts as zero volume.
 */
export function includedOf(
  month: MonthOfPlans,
  plans: PlanTable,
): { bookings: number; paymentVolume: number } {
  let bookings = 0;
  let volume = 0;
  for (const plan of ['free', 'pro', 'scale'] as const) {
    const days = month.days[plan];
    bookings += (plans[plan].bookingsIncluded ?? 0) * days;
    volume += (plans[plan].paymentVolumeIncluded ?? 0) * days;
  }
  return {
    bookings: ceilDiv(bookings, month.daysInMonth),
    paymentVolume: ceilDiv(volume, month.daysInMonth),
  };
}

/**
 * The overage of a month, or `null` when there is none to bill: no paid plan in the month, or a
 * day on `enterprise` (a contract).
 */
export function computeOverage(
  month: MonthOfPlans,
  usage: OverageUsage,
  plans: PlanTable,
): Overage | null {
  const plan = month.plan;
  if (!isPaidPlanId(plan) || month.days.enterprise > 0 || month.daysInMonth <= 0) return null;
  const included = includedOf(month, plans);
  const prices = PLAN_PRICES[plan];
  const over = Math.max(0, usage.bookingsConfirmed - included.bookings);
  return {
    plan,
    bookingsConfirmed: usage.bookingsConfirmed,
    bookingsIncluded: included.bookings,
    bookingsOver: over,
    bookingUnitAmount: prices.extraBooking,
    bookingsAmount: over * prices.extraBooking,
    paymentVolume: usage.paymentVolume,
    paymentVolumeIncluded: included.paymentVolume,
    paymentsPerMille: prices.paymentsPerMille,
    paymentsAmount: perMilleOf(
      Math.max(0, usage.paymentVolume - included.paymentVolume),
      prices.paymentsPerMille,
    ),
    volumeCurrency: usage.currency,
  };
}

/** A month on one plan only: what a test, or a caller that knows it, passes. */
export function wholeMonthOn(plan: string, daysInMonth = 30): MonthOfPlans {
  const days = { free: 0, pro: 0, scale: 0, enterprise: 0 };
  if (plan === 'free' || plan === 'pro' || plan === 'scale' || plan === 'enterprise') {
    days[plan] = daysInMonth;
  }
  return { plan: isPaidPlanId(plan) ? plan : null, daysInMonth, days };
}

/** `1000` as `1,000`. */
function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Cents as euro with two decimals: `123450` is `€1,234.50`. */
export function euros(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}€${thousands(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Per mille as a percentage with one decimal: `4` is `0.4%`. */
export function perMilleAsPercent(perMille: number): string {
  return `${String(Math.floor(perMille / 10))}.${String(perMille % 10)}%`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-09` as `September 2026`. */
export function monthName(month: string): string {
  const [year, number] = month.split('-');
  return `${MONTHS[Number(number) - 1] ?? month} ${year ?? ''}`.trim();
}

/** The first instant of the month after `month`, in UTC: the end of the closed month. */
export function monthEndUtc(month: string): Date {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, number ?? 1, 1));
}

/** The first instant of `month`, in UTC. */
export function monthStartUtc(month: string): Date {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1));
}

export interface OverageLine {
  kind: 'bookings' | 'payments';
  form: Record<string, unknown>;
}

/** What the lines of an overage are written from: the claim, as the database recorded it. */
export type ClaimedOverage = Pick<
  Overage,
  | 'plan'
  | 'bookingsIncluded'
  | 'bookingsOver'
  | 'bookingUnitAmount'
  | 'bookingsAmount'
  | 'paymentVolume'
  | 'paymentVolumeIncluded'
  | 'paymentsPerMille'
  | 'paymentsAmount'
>;

/**
 * The invoice items of an overage, as forms: one per non zero amount.
 *
 * Built from the claim recorded in `billing_overages`, never from the usage read again: two
 * attempts at the same line send the same parameters, which is what lets Stripe's
 * `Idempotency-Key` recognise the second one. `invoice` is the draft of the renewal, or `null`
 * for a pending item, which Stripe puts on the next invoice of the customer (a draft that was no
 * longer a draft, or the invoice of a subscription that has ended). The tax is Stripe Tax's,
 * computed on the invoice the line goes on from the product's tax code and the `exclusive` tax
 * behaviour; the products are the two of the catalogue; the currency is the euro of the prices.
 * The metadata (`bookrail_month`, `bookrail_kind`) is how a line already at Stripe is recognised.
 */
export function overageLines(options: {
  overage: ClaimedOverage;
  month: string;
  accountId: string;
  customer: string;
  invoice: string | null;
}): OverageLine[] {
  const { overage, month } = options;
  const common = {
    customer: options.customer,
    ...(options.invoice === null ? {} : { invoice: options.invoice }),
    currency: PLAN_PRICE_CURRENCY,
    period: {
      start: Math.floor(monthStartUtc(month).getTime() / 1000),
      end: Math.floor(monthEndUtc(month).getTime() / 1000) - 1,
    },
  };
  const lines: OverageLine[] = [];
  if (overage.bookingsAmount > 0) {
    lines.push({
      kind: 'bookings',
      form: {
        ...common,
        quantity: overage.bookingsOver,
        price_data: {
          currency: PLAN_PRICE_CURRENCY,
          product: OVERAGE_BOOKINGS_PRODUCT_ID,
          unit_amount: overage.bookingUnitAmount,
          tax_behavior: 'exclusive',
        },
        description: `Bookings over the ${thousands(overage.bookingsIncluded)} included, ${monthName(month)}: ${thousands(overage.bookingsOver)} × ${euros(overage.bookingUnitAmount)}`,
        metadata: { bookrail_month: month, bookrail_kind: 'bookings', bookrail_plan: overage.plan },
      },
    });
  }
  if (overage.paymentsAmount > 0) {
    lines.push({
      kind: 'payments',
      form: {
        ...common,
        quantity: 1,
        price_data: {
          currency: PLAN_PRICE_CURRENCY,
          product: ORCHESTRATED_PAYMENTS_PRODUCT_ID,
          unit_amount: overage.paymentsAmount,
          tax_behavior: 'exclusive',
        },
        description:
          overage.paymentVolumeIncluded > 0
            ? `Orchestrated payments, ${monthName(month)}: ${perMilleAsPercent(overage.paymentsPerMille)} of ${euros(Math.max(0, overage.paymentVolume - overage.paymentVolumeIncluded))} (${euros(overage.paymentVolume)} paid, ${euros(overage.paymentVolumeIncluded)} included)`
            : `Orchestrated payments, ${monthName(month)}: ${perMilleAsPercent(overage.paymentsPerMille)} of ${euros(overage.paymentVolume)}`,
        metadata: { bookrail_month: month, bookrail_kind: 'payments', bookrail_plan: overage.plan },
      },
    });
  }
  return lines;
}

/**
 * The idempotency key of one line: the account, the month, the line, and whether it goes on a
 * draft or is pending. The two placements have distinct keys, because they are two different
 * requests to Stripe: the same key with other parameters is refused as an `idempotency_error`.
 */
export function overageIdempotencyKey(
  accountId: string,
  month: string,
  kind: 'bookings' | 'payments',
  placement: 'invoice' | 'pending',
  attempt = 0,
): string {
  return `bookrail-overage-${accountId}-${month}-${kind}-${placement}${retrySuffix(attempt)}`;
}

/**
 * A claim taken again uses keys of its own: Stripe keeps the answer of the first request under a
 * key, a `500` included, for 24 hours, so a retry under the same key would get the same `500`
 * back. A retry looks at Stripe first (the line, or the invoice, by its metadata) and creates only
 * what is not there, so a new key cannot make a second line.
 */
function retrySuffix(attempt: number): string {
  return attempt > 0 ? `-retry${String(attempt)}` : '';
}

/** The idempotency key of the invoice of its own that carries the last overage of an account. */
export function finalInvoiceIdempotencyKey(accountId: string, month: string, attempt = 0): string {
  return `bookrail-final-invoice-${accountId}-${month}${retrySuffix(attempt)}`;
}
