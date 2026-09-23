/**
 * How much a booking asks for up front, and how that number is read out of a frozen policy.
 *
 * Pure arithmetic and a reader of `policy_snapshot`, with no clock, no database and no network,
 * for the reason every money rule in this engine is written that way: the number a customer is
 * charged has to be reproducible from the row alone, by a person reading the code, years later.
 *
 * The amount is computed **inside** the booking transaction, on `bookings.price_amount` as it is
 * frozen there: a pricing rule may make Saturday evening cost more than Tuesday morning, and the
 * price of a booking is the price of the instant it was made. The route checks the same
 * pre-conditions before the transaction, but only so that a request that could never work fails
 * with a clear error instead of taking capacity and giving it back.
 */

/** `payment.mode` of `POST /v1/bookings`, restricted to the two that take money today. */
export type PaymentMode = 'deposit' | 'full';

/** `policy_snapshot.deposit`, as the policy schema writes it. */
export interface DepositRule {
  readonly type: 'percent' | 'fixed';
  /** A percentage for `percent`, a minor-unit amount for `fixed`. Never negative. */
  readonly value: number;
}

/**
 * `policy_snapshot.deposit`, or `null` when the policy has none or has a malformed one.
 *
 * Malformed is dropped rather than thrown on, exactly as a malformed cancellation tier is
 * (`policy.ts`): a snapshot is a copy of a row that may be years old, and the honest reading of
 * a rule nobody can parse is that there is no rule. The caller then answers
 * `400 deposit_not_configured`, which is the same answer as "this policy never had a deposit",
 * and which is the truthful one: there is no deposit this code can compute.
 */
export function depositRule(snapshot: Record<string, unknown> | null): DepositRule | null {
  const raw = snapshot?.deposit;
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const type = row.type;
  const value = row.value;
  if (type !== 'percent' && type !== 'fixed') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (type === 'percent' && value > 100) return null;
  return { type, value };
}

export interface PaymentAmountInput {
  readonly mode: PaymentMode;
  /** `bookings.price_amount` as frozen by the transaction. `null` for a service with no price. */
  readonly priceAmount: number | null;
  /** Only read for `deposit`. */
  readonly depositRule: DepositRule | null;
}

export type PaymentAmountResult =
  | { readonly ok: true; readonly amount: number }
  /** Why no amount could be computed. The caller turns it into one of three 400s. */
  | { readonly ok: false; readonly reason: 'price_missing' | 'deposit_missing' | 'zero' };

/**
 * The amount to ask Stripe for, in the minor unit of the booking's currency.
 *
 * `full` is the frozen price. A `percent` deposit rounds **down**: the alternative is charging a
 * cent the policy did not ask for, and the difference belongs to the balance, which this release
 * does not charge. A `fixed` deposit is capped at the price, because a deposit larger than the
 * thing being bought is a configuration mistake and taking the money would be the wrong way to
 * report it.
 *
 * Zero is refused rather than sent. Stripe has a minimum charge of its own and would refuse it
 * anyway, but the reason to refuse here is better than that: a booking that takes no money is
 * `mode: "none"`, which already exists, costs nothing and leaves no `payments` row waiting for
 * an event that will never come.
 *
 * `quantity` does not enter: `price_amount` is the price of a booking and not of a unit.
 */
export function paymentAmountFor(input: PaymentAmountInput): PaymentAmountResult {
  const price = input.priceAmount;
  if (price === null) return { ok: false, reason: 'price_missing' };
  if (input.mode === 'full') {
    return price > 0 ? { ok: true, amount: price } : { ok: false, reason: 'zero' };
  }
  const rule = input.depositRule;
  if (rule === null) return { ok: false, reason: 'deposit_missing' };
  const amount =
    rule.type === 'percent'
      ? Math.floor((price * rule.value) / 100)
      : Math.min(Math.floor(rule.value), price);
  return amount > 0 ? { ok: true, amount } : { ok: false, reason: 'zero' };
}
