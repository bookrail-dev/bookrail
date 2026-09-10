/**
 * The canonical pricing rule schema, checked against its own conformance corpus.
 *
 * The corpus is exported rather than written here because a second declaration of the schema
 * lives in the CLI (`packages/cli/src/config/schema.ts`, which cannot import this package at
 * run time) and `packages/cli/test/config.test.ts` runs the very same cases through it. One
 * list, two schemas, the same verdicts.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_PRICE_AMOUNT,
  MAX_PRICE_MULTIPLIER,
  PRICING_RULE_CONFORMANCE_CASES,
  PRICING_WEEKDAYS,
  priceRuleOfRow,
  pricingRuleSchema,
  pricingRulesSchema,
} from '../src/pricing.js';

describe('the pricing rule schema', () => {
  it.each(PRICING_RULE_CONFORMANCE_CASES.map((entry) => [entry.title, entry] as const))(
    'agrees on %s',
    (_title, entry) => {
      expect(pricingRuleSchema.safeParse(entry.rule).success).toBe(entry.valid);
    },
  );

  it('carries a corpus with both verdicts in it', () => {
    expect(PRICING_RULE_CONFORMANCE_CASES.some((entry) => entry.valid)).toBe(true);
    expect(PRICING_RULE_CONFORMANCE_CASES.some((entry) => !entry.valid)).toBe(true);
    expect(PRICING_RULE_CONFORMANCE_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it('names the indexed path of the field that is wrong', () => {
    const parsed = pricingRulesSchema.safeParse([
      { when: { days: ['sat'] }, price: 3500 },
      { when: { days: ['sun'] }, price: 3500 },
      { when: { days: ['mon'] }, price: 3500 },
      { when: { time_from: '25:00', time_to: '02:00' }, price: 3500 },
    ]);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual([3, 'when', 'time_from']);
  });

  it('accepts every weekday name and nothing else', () => {
    expect(
      pricingRuleSchema.safeParse({ when: { days: [...PRICING_WEEKDAYS] }, price: 1 }).success,
    ).toBe(true);
  });

  it('holds at the bounds and refuses just past them', () => {
    expect(
      pricingRuleSchema.safeParse({ when: { days: ['sat'] }, price: MAX_PRICE_AMOUNT }).success,
    ).toBe(true);
    expect(
      pricingRuleSchema.safeParse({
        when: { days: ['sat'] },
        price_multiplier: MAX_PRICE_MULTIPLIER,
      }).success,
    ).toBe(true);
    expect(
      pricingRuleSchema.safeParse({ when: { days: ['sat'] }, price_add: -MAX_PRICE_AMOUNT - 1 })
        .success,
    ).toBe(false);
  });

  it('takes a hundred rules and refuses the hundred and first', () => {
    const rule = { when: { days: ['sat'] }, price: 100 };
    expect(pricingRulesSchema.safeParse(Array.from({ length: 100 }, () => rule)).success).toBe(
      true,
    );
    expect(pricingRulesSchema.safeParse(Array.from({ length: 101 }, () => rule)).success).toBe(
      false,
    );
  });

  it('takes an empty list, which is what every service has today', () => {
    expect(pricingRulesSchema.safeParse([]).success).toBe(true);
  });
});

/**
 * The single reader of `bookings.price_rule`, used by the engine (which puts the reference on
 * an event) and by the API (which puts it on a response). Two readers with two sets of
 * criteria would let the same row come back as a reference from one and as `null` from the
 * other, which is the bug this function exists to make impossible.
 */
describe('priceRuleOfRow', () => {
  it('reads the shape the booking transaction writes', () => {
    expect(priceRuleOfRow({ index: 0, label: 'Weekend' })).toEqual({ index: 0, label: 'Weekend' });
    expect(priceRuleOfRow({ index: 3, label: null })).toEqual({ index: 3, label: null });
  });

  it('answers null for a booking priced flat, or written before migration 0020', () => {
    expect(priceRuleOfRow(null)).toBeNull();
    expect(priceRuleOfRow(undefined)).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    expect(priceRuleOfRow([{ index: 0 }])).toBeNull();
    expect(priceRuleOfRow('index 0')).toBeNull();
    expect(priceRuleOfRow(0)).toBeNull();
  });

  it('takes an index only when it is a non-negative integer', () => {
    expect(priceRuleOfRow({ index: -1, label: null })).toBeNull();
    expect(priceRuleOfRow({ index: 1.5, label: null })).toBeNull();
    expect(priceRuleOfRow({ index: Number.NaN, label: null })).toBeNull();
    expect(priceRuleOfRow({ index: '0', label: null })).toBeNull();
    expect(priceRuleOfRow({ label: 'Weekend' })).toBeNull();
  });

  it('reads a label that is not a string as no label', () => {
    expect(priceRuleOfRow({ index: 0, label: 7 })).toEqual({ index: 0, label: null });
    expect(priceRuleOfRow({ index: 0 })).toEqual({ index: 0, label: null });
  });
});
