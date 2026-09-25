/**
 * What the CLI needs to know about the plans, declared here rather than imported.
 *
 * The CLI does not depend on `@bookrail/shared` at run time (three dependencies, all without
 * dependencies of their own, is what keeps `npx bookrail` fast), so the few facts it prints are
 * written again here, and `test/plans.test.ts` compares them with `@bookrail/shared` and with the
 * engine, where they are defined: a plan added there, a threshold moved, or the upgrade sentence
 * changed without this file following, fails that test.
 *
 * Everything else about a plan (what it includes, whether it blocks) comes from the API in
 * `GET /v1/project`, which is the only place that knows the plan of an account.
 */

/** The plans, in the order of the pricing table. */
export const PLAN_IDS = ['free', 'pro', 'scale', 'enterprise'] as const;

/** The percentages of the included bookings at which the API warns the owner of an account. */
export const PLAN_WARNING_THRESHOLDS = [80, 100] as const;

/** The operative sentence of `402 plan_limit_reached`, repeated by `doctor` before it happens. */
export const PLAN_UPGRADE_FIX =
  'Upgrade in the dashboard: https://bookrail.dev/dashboard/?upgrade=pro. Then retry with a new Idempotency-Key.';

/** The `usage` object of `GET /v1/project`. */
export interface PlanUsage {
  month: string;
  bookings_confirmed: number;
  bookings_included: number | null;
  payment_volume: number;
  payment_volume_included: number | null;
  currency: string | null;
  blocks_at_limit: boolean;
}

/** Minor units as a decimal amount, `123456` as `1234.56`. */
export function amountOf(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** One line: `12 of 1000 confirmed live bookings in 2026-09, paid volume 45.00 of 1000.00 EUR`. */
export function describeUsage(usage: PlanUsage): string {
  const bookings =
    usage.bookings_included === null
      ? `${String(usage.bookings_confirmed)} confirmed live bookings`
      : `${String(usage.bookings_confirmed)} of ${String(usage.bookings_included)} confirmed live bookings`;
  const currency =
    usage.currency === null || usage.currency === 'mixed' ? '' : ` ${usage.currency}`;
  const volume =
    usage.payment_volume_included === null
      ? `${amountOf(usage.payment_volume)}${currency}`
      : `${amountOf(usage.payment_volume)} of ${amountOf(usage.payment_volume_included)}${currency}`;
  return `${bookings} in ${usage.month} (UTC), paid volume ${volume}`;
}
