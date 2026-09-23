/**
 * The arithmetic of a deposit, at the table.
 *
 * Pure functions, no database and no clock, which is exactly why they can be tested this way:
 * the amount a customer is charged is a number that has to be reproducible from the price and
 * the rule alone. Everything about a booking that touches money downstream (the refund, the
 * expectation written on a cancellation) reads this number, so a rounding decision made here
 * is a rounding decision made everywhere.
 */
import { describe, expect, it } from 'vitest';
import { depositRule, paymentAmountFor } from '../src/booking/payment.js';

describe('depositRule', () => {
  it('reads a percent rule and a fixed rule', () => {
    expect(depositRule({ deposit: { type: 'percent', value: 30 } })).toEqual({
      type: 'percent',
      value: 30,
    });
    expect(depositRule({ deposit: { type: 'fixed', value: 1500 } })).toEqual({
      type: 'fixed',
      value: 1500,
    });
  });

  it('is null for a snapshot with no deposit at all', () => {
    expect(depositRule(null)).toBeNull();
    expect(depositRule({})).toBeNull();
    expect(depositRule({ deposit: null })).toBeNull();
  });

  /**
   * A snapshot is a copy of a row that may be years old, and the rule everywhere else in
   * `policy.ts` is that a malformed value is dropped rather than thrown on. The consequence is
   * the honest one: there is no deposit this code can compute, which is the same answer as a
   * policy that never had one, and the caller answers `400 deposit_not_configured`.
   */
  it('drops a rule it cannot read, rather than throwing on it', () => {
    for (const deposit of [
      { type: 'share', value: 30 },
      { type: 'percent', value: -1 },
      { type: 'percent', value: 101 },
      { type: 'percent' },
      { type: 'fixed', value: 'lots' },
      { type: 'fixed', value: Number.NaN },
      'thirty percent',
      42,
    ]) {
      expect(depositRule({ deposit }), JSON.stringify(deposit)).toBeNull();
    }
  });
});

describe('paymentAmountFor', () => {
  it('charges the whole frozen price for mode full', () => {
    expect(paymentAmountFor({ mode: 'full', priceAmount: 2500, depositRule: null })).toEqual({
      ok: true,
      amount: 2500,
    });
  });

  /**
   * **Down, never up.** Rounding a deposit up would charge a cent the policy did not ask for,
   * on every booking, for ever; the difference belongs to the balance, which comes later.
   * `2500 x 30% = 750` exactly, and `999 x 30% = 299.7` becomes 299.
   */
  it('rounds a percent deposit down', () => {
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 2500,
        depositRule: { type: 'percent', value: 30 },
      }),
    ).toEqual({ ok: true, amount: 750 });
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 999,
        depositRule: { type: 'percent', value: 30 },
      }),
    ).toEqual({ ok: true, amount: 299 });
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 101,
        depositRule: { type: 'percent', value: 99 },
      }),
    ).toEqual({ ok: true, amount: 99 });
  });

  it('charges the whole price for a percent deposit of 100', () => {
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 2500,
        depositRule: { type: 'percent', value: 100 },
      }),
    ).toEqual({ ok: true, amount: 2500 });
  });

  /**
   * A fixed deposit larger than the thing being bought is a configuration mistake, and taking
   * the money would be the wrong way to report it. Capped at the price.
   */
  it('caps a fixed deposit at the price', () => {
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 2000,
        depositRule: { type: 'fixed', value: 5000 },
      }),
    ).toEqual({ ok: true, amount: 2000 });
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 5000,
        depositRule: { type: 'fixed', value: 2000 },
      }),
    ).toEqual({ ok: true, amount: 2000 });
  });

  /**
   * Zero is refused rather than sent. Stripe has a minimum of its own and would refuse it, but
   * the reason to refuse here is better: a booking that takes no money is `mode: "none"`,
   * which already exists and leaves no `payments` row waiting for an event that never comes.
   */
  it('refuses an amount of zero, however it arises', () => {
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 2500,
        depositRule: { type: 'percent', value: 0 },
      }),
    ).toEqual({ ok: false, reason: 'zero' });
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 2500,
        depositRule: { type: 'fixed', value: 0 },
      }),
    ).toEqual({ ok: false, reason: 'zero' });
    expect(paymentAmountFor({ mode: 'full', priceAmount: 0, depositRule: null })).toEqual({
      ok: false,
      reason: 'zero',
    });
    // Ninety-nine cents at one percent is 0.99, which floors to zero: the rounding rule and
    // the zero rule meet here, and the answer is a refusal rather than a free booking.
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: 99,
        depositRule: { type: 'percent', value: 1 },
      }),
    ).toEqual({ ok: false, reason: 'zero' });
  });

  it('reports a missing price and a missing deposit as two different reasons', () => {
    expect(paymentAmountFor({ mode: 'full', priceAmount: null, depositRule: null })).toEqual({
      ok: false,
      reason: 'price_missing',
    });
    expect(
      paymentAmountFor({
        mode: 'deposit',
        priceAmount: null,
        depositRule: { type: 'percent', value: 30 },
      }),
    ).toEqual({ ok: false, reason: 'price_missing' });
    expect(paymentAmountFor({ mode: 'deposit', priceAmount: 2500, depositRule: null })).toEqual({
      ok: false,
      reason: 'deposit_missing',
    });
  });

  /** `mode: "full"` never looks at the deposit: the two are different questions. */
  it('ignores the deposit rule entirely for mode full', () => {
    expect(
      paymentAmountFor({
        mode: 'full',
        priceAmount: 2500,
        depositRule: { type: 'percent', value: 10 },
      }),
    ).toEqual({ ok: true, amount: 2500 });
  });
});
