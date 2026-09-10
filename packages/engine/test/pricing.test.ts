/**
 * `priceForSlot`: the pure evaluation of `services.pricing_rules`.
 *
 * Everything here is a function of a service, a slot and a zone, with no database and no clock,
 * which is why the seven edge cases the specification names can be written down as arithmetic
 * rather than staged. The DST cases take their dates from the IANA database through
 * `dst-helpers.ts`, like the rest of the time zone suite: a tzdata update changes the data, not
 * the test.
 *
 * The end to end cases (the price frozen on a booking, the no-show charge computed on the
 * surcharged price, the reschedule that does not move it, the cache that does not hide a rule
 * change) live in `booking.test.ts` and `availability.cache.test.ts`, against real Postgres.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PricingRule } from '@bookrail/shared';

import { priceForSlot, type PricedSlot, type ServiceData } from '../src/index.js';
import { findTransitions, instantOfLocal, localTimeOf, previousDay } from './dst-helpers.js';

const RESOURCE_A = '0193f0c2-a1b4-7e2e-9a1c-0f4d5e6a7b8c';
const RESOURCE_A_PREFIXED = 'res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c';
const RESOURCE_B = '0193f0c2-a1b4-7e2e-9a1c-0f4d5e6a7b8d';

function service(input: {
  price?: { amount: number; currency: string } | null;
  rules?: readonly (PricingRule | null)[];
}): ServiceData {
  return {
    id: 'svc',
    durationMinutes: 60,
    durationOptions: null,
    durationMinMinutes: null,
    durationMaxMinutes: null,
    capacityPerBooking: 1,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotIntervalMinutes: null,
    alignTo: null,
    priceAmount: input.price === null ? null : (input.price?.amount ?? 3000),
    priceCurrency: input.price === null ? null : (input.price?.currency ?? 'EUR'),
    pricingRules: input.rules ?? [],
    bookingWindow: null,
    bufferSharing: false,
    allowSplit: false,
  };
}

function slot(input: Partial<PricedSlot> & { startUtc: number }): PricedSlot {
  return {
    startUtc: input.startUtc,
    durationMinutes: input.durationMinutes ?? 60,
    resourceIds: input.resourceIds ?? [RESOURCE_A],
  };
}

/** A slot starting at a local wall time in a zone, which is how every rule is written. */
function at(
  timezone: string,
  day: string,
  time: string,
  rest: Partial<PricedSlot> = {},
): PricedSlot {
  return slot({ ...rest, startUtc: instantOfLocal(timezone, day, time) });
}

const ROME = 'Europe/Rome';

describe('priceForSlot', () => {
  it('answers null for a service with no price, rules or not', () => {
    const rules: PricingRule[] = [{ when: { days: ['sat'] }, price: 3500 }];
    expect(
      priceForSlot(service({ price: null }), at(ROME, '2026-09-12', '10:00'), ROME),
    ).toBeNull();
    expect(
      priceForSlot(service({ price: null, rules }), at(ROME, '2026-09-12', '10:00'), ROME),
    ).toBeNull();
  });

  it('answers the flat price when there are no rules', () => {
    const priced = priceForSlot(service({}), at(ROME, '2026-09-12', '10:00'), ROME);
    expect(priced).toEqual({
      price: { amount: 3000, currency: 'EUR' },
      ruleIndex: null,
      label: null,
    });
  });

  it('answers the flat price when no rule matches', () => {
    const rules: PricingRule[] = [{ when: { days: ['mon'] }, price: 9900 }];
    // 12 September 2026 is a Saturday.
    const priced = priceForSlot(service({ rules }), at(ROME, '2026-09-12', '10:00'), ROME);
    expect(priced?.price.amount).toBe(3000);
    expect(priced?.ruleIndex).toBeNull();
  });

  it('applies the weekend rule of 07 to a Saturday and not to a Monday', () => {
    const rules: PricingRule[] = [
      { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
    ];
    const svc = service({ rules });
    expect(priceForSlot(svc, at(ROME, '2026-09-12', '10:00'), ROME)).toEqual({
      price: { amount: 3500, currency: 'EUR' },
      ruleIndex: 0,
      label: 'Weekend',
    });
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '10:00'), ROME)?.ruleIndex).toBeNull();
  });

  it('reads the time band as half open, [from, to)', () => {
    const rules: PricingRule[] = [{ when: { time_from: '18:00', time_to: '22:00' }, price: 4000 }];
    const svc = service({ rules });
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '17:59'), ROME)?.ruleIndex).toBeNull();
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '18:00'), ROME)?.ruleIndex).toBe(0);
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '21:59'), ROME)?.ruleIndex).toBe(0);
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '22:00'), ROME)?.ruleIndex).toBeNull();
  });

  it('prices a band that crosses midnight on both sides of it', () => {
    const rules: PricingRule[] = [
      { when: { time_from: '22:00', time_to: '02:00' }, price_add: 500, label: 'Night' },
    ];
    const svc = service({ rules });
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '21:59'), ROME)?.ruleIndex).toBeNull();
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '22:00'), ROME)?.price.amount).toBe(3500);
    expect(priceForSlot(svc, at(ROME, '2026-09-14', '23:30'), ROME)?.price.amount).toBe(3500);
    expect(priceForSlot(svc, at(ROME, '2026-09-15', '00:30'), ROME)?.price.amount).toBe(3500);
    expect(priceForSlot(svc, at(ROME, '2026-09-15', '01:59'), ROME)?.price.amount).toBe(3500);
    expect(priceForSlot(svc, at(ROME, '2026-09-15', '02:00'), ROME)?.ruleIndex).toBeNull();
  });

  /**
   * `days` and a band that wraps are read on the same instant, the **start** of the slot, so
   * the night of Friday to Saturday is two different weekdays. The rule below is the most
   * natural thing to write and covers only the first half of the night; it is not a bug, it is
   * the only reading of "the start of the slot" that is consistent. The other one is written by
   * listing both days. This test exists so nobody "fixes" it.
   */
  it('reads days on the day the slot starts, so a band that wraps needs both days', () => {
    // 11 September 2026 is a Friday, 12 September a Saturday.
    const fridayOnly: PricingRule[] = [
      {
        when: { days: ['fri'], time_from: '22:00', time_to: '02:00' },
        price_add: 1000,
        label: 'Friday night',
      },
    ];
    const narrow = service({ rules: fridayOnly });
    expect(priceForSlot(narrow, at(ROME, '2026-09-11', '22:30'), ROME)).toEqual({
      price: { amount: 4000, currency: 'EUR' },
      ruleIndex: 0,
      label: 'Friday night',
    });
    // Saturday 00:30 is inside the band and outside `days`, so the flat price applies.
    expect(priceForSlot(narrow, at(ROME, '2026-09-12', '00:30'), ROME)).toEqual({
      price: { amount: 3000, currency: 'EUR' },
      ruleIndex: null,
      label: null,
    });

    // Naming both days the band touches covers the whole night, which is what the person
    // writing "the Friday night rate" meant.
    const bothDays: PricingRule[] = [
      {
        when: { days: ['fri', 'sat'], time_from: '22:00', time_to: '02:00' },
        price_add: 1000,
        label: 'Friday night',
      },
    ];
    const wide = service({ rules: bothDays });
    expect(priceForSlot(wide, at(ROME, '2026-09-11', '22:30'), ROME)?.price.amount).toBe(4000);
    expect(priceForSlot(wide, at(ROME, '2026-09-12', '00:30'), ROME)?.price.amount).toBe(4000);
    // The price of naming both days: the band also covers the Saturday evening.
    expect(priceForSlot(wide, at(ROME, '2026-09-12', '22:30'), ROME)?.price.amount).toBe(4000);
  });

  it('respects an inclusive date range', () => {
    const rules: PricingRule[] = [
      { when: { date_from: '2026-07-01', date_to: '2026-08-31' }, price_multiplier: 1.2 },
    ];
    const svc = service({ rules });
    expect(priceForSlot(svc, at(ROME, '2026-06-30', '10:00'), ROME)?.ruleIndex).toBeNull();
    expect(priceForSlot(svc, at(ROME, '2026-07-01', '10:00'), ROME)?.price.amount).toBe(3600);
    expect(priceForSlot(svc, at(ROME, '2026-08-31', '23:00'), ROME)?.price.amount).toBe(3600);
    expect(priceForSlot(svc, at(ROME, '2026-09-01', '10:00'), ROME)?.ruleIndex).toBeNull();
  });

  it('matches resource_id only when that resource is in the assignment', () => {
    const rules: PricingRule[] = [
      { when: { resource_id: RESOURCE_A_PREFIXED }, price_add: 500, label: 'Centre court' },
    ];
    const svc = service({ rules });
    const when = '2026-09-14';
    expect(
      priceForSlot(svc, at(ROME, when, '10:00', { resourceIds: [RESOURCE_A] }), ROME)?.price.amount,
    ).toBe(3500);
    expect(
      priceForSlot(svc, at(ROME, when, '10:00', { resourceIds: [RESOURCE_B, RESOURCE_A] }), ROME)
        ?.price.amount,
    ).toBe(3500);
    expect(
      priceForSlot(svc, at(ROME, when, '10:00', { resourceIds: [RESOURCE_B] }), ROME)?.ruleIndex,
    ).toBeNull();
    expect(
      priceForSlot(svc, at(ROME, when, '10:00', { resourceIds: [] }), ROME)?.ruleIndex,
    ).toBeNull();
  });

  it('matches duration_min on equality, not on a minimum', () => {
    const rules: PricingRule[] = [{ when: { duration_min: 90 }, price_multiplier: 1.4 }];
    const svc = service({ rules });
    expect(
      priceForSlot(svc, at(ROME, '2026-09-14', '10:00', { durationMinutes: 60 }), ROME)?.ruleIndex,
    ).toBeNull();
    expect(
      priceForSlot(svc, at(ROME, '2026-09-14', '10:00', { durationMinutes: 90 }), ROME)?.price
        .amount,
    ).toBe(4200);
    expect(
      priceForSlot(svc, at(ROME, '2026-09-14', '10:00', { durationMinutes: 120 }), ROME)?.ruleIndex,
    ).toBeNull();
  });

  it('takes every condition of a when together, as an and', () => {
    const rules: PricingRule[] = [
      {
        when: { days: ['sat'], time_from: '18:00', time_to: '22:00', duration_min: 90 },
        price: 9900,
      },
    ];
    const svc = service({ rules });
    const saturdayEvening90 = at(ROME, '2026-09-12', '19:00', { durationMinutes: 90 });
    expect(priceForSlot(svc, saturdayEvening90, ROME)?.price.amount).toBe(9900);
    // One condition off is enough to miss: Saturday morning, and Monday evening.
    expect(
      priceForSlot(svc, at(ROME, '2026-09-12', '10:00', { durationMinutes: 90 }), ROME)?.ruleIndex,
    ).toBeNull();
    expect(
      priceForSlot(svc, at(ROME, '2026-09-14', '19:00', { durationMinutes: 90 }), ROME)?.ruleIndex,
    ).toBeNull();
    expect(
      priceForSlot(svc, at(ROME, '2026-09-12', '19:00', { durationMinutes: 60 }), ROME)?.ruleIndex,
    ).toBeNull();
  });

  it('lets the first matching rule win, with no chaining', () => {
    const rules: PricingRule[] = [
      { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
      { when: { time_from: '18:00', time_to: '22:00' }, price_add: 500, label: 'Evening' },
    ];
    const priced = priceForSlot(service({ rules }), at(ROME, '2026-09-12', '19:00'), ROME);
    // Saturday evening is 3500, not 4000: the second rule never runs.
    expect(priced).toEqual({
      price: { amount: 3500, currency: 'EUR' },
      ruleIndex: 0,
      label: 'Weekend',
    });
  });

  it('never lets price_add take the price below zero', () => {
    const rules: PricingRule[] = [{ when: { days: ['mon'] }, price_add: -5000 }];
    const priced = priceForSlot(service({ rules }), at(ROME, '2026-09-14', '10:00'), ROME);
    expect(priced?.price.amount).toBe(0);
    expect(priced?.ruleIndex).toBe(0);
  });

  it('rounds a multiplier to the minor unit, the two worked examples of the specification', () => {
    const times = (amount: number, multiplier: number): number | undefined =>
      priceForSlot(
        service({
          price: { amount, currency: 'EUR' },
          rules: [{ when: { days: ['mon'] }, price_multiplier: multiplier }],
        }),
        at(ROME, '2026-09-14', '10:00'),
        ROME,
      )?.price.amount;
    expect(times(2500, 1.15)).toBe(2875);
    expect(times(1999, 0.8)).toBe(1599);
    // Halves round up, which is what Math.round does and what the documentation says.
    expect(times(1, 1.5)).toBe(2);
    expect(times(1, 0.5)).toBe(1);
  });

  it('skips a stored rule the schema refuses and keeps the indices of the ones after it', () => {
    const rules: readonly (PricingRule | null)[] = [
      null,
      { when: { days: ['mon'] }, price: 4200, label: 'Monday' },
    ];
    const priced = priceForSlot(service({ rules }), at(ROME, '2026-09-14', '10:00'), ROME);
    expect(priced).toEqual({
      price: { amount: 4200, currency: 'EUR' },
      ruleIndex: 1,
      label: 'Monday',
    });
  });

  it('gives a label of null when the rule has none', () => {
    const rules: PricingRule[] = [{ when: { days: ['mon'] }, price: 100 }];
    expect(
      priceForSlot(service({ rules }), at(ROME, '2026-09-14', '10:00'), ROME)?.label,
    ).toBeNull();
  });
});

describe('priceForSlot on the local calendar', () => {
  /**
   * The zone of the offer, applied to prices: the weekday is the resource's, never UTC's.
   *
   * At 00:30 local on a Saturday in Rome the instant is 22:30 on the Friday in UTC, and in
   * `Pacific/Auckland` the gap is wider still. A rule for `sat` has to fire for both.
   */
  it.each(['Europe/Rome', 'Pacific/Auckland', 'Asia/Kolkata'])(
    'reads days on the local day of %s, even when UTC is still on the day before',
    (timezone) => {
      const rules: PricingRule[] = [{ when: { days: ['sat'] }, price: 3500 }];
      const svc = service({ rules });
      const saturdayEarly = at(timezone, '2026-09-12', '00:30');
      expect(new Date(saturdayEarly.startUtc).getUTCDay()).toBe(5);
      expect(priceForSlot(svc, saturdayEarly, timezone)?.ruleIndex).toBe(0);
      // The same instant read on UTC is a Friday, and a UTC rule would price it flat.
      expect(priceForSlot(svc, saturdayEarly, 'UTC')?.ruleIndex).toBeNull();
    },
  );

  const zones = ['Europe/Rome', 'America/New_York', 'Pacific/Auckland'];
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2029, 0, 1);

  it.each(zones)('cannot fire on the hour that does not exist in %s', (timezone) => {
    const gaps = findTransitions(timezone, from, to).filter((entry) => entry.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      // The vanished band runs from the hour after the last local minute before the change to
      // the local reading of the change itself: in Rome 01:59 is the last minute that exists,
      // the clock then reads 03:00, and `[02:00, 03:00)` is the hour nobody can be in.
      const lastBefore = Number(localTimeOf(timezone, gap.at - 60_000).slice(0, 2));
      const bandFrom = `${String((lastBefore + 1) % 24).padStart(2, '0')}:00`;
      const bandTo = localTimeOf(timezone, gap.at);
      if (bandFrom === bandTo) continue;
      const rules: PricingRule[] = [
        { when: { time_from: bandFrom, time_to: bandTo }, price: 9900 },
      ];
      const svc = service({ rules });
      // A whole day around the change, minute by minute: no instant reads inside the vanished
      // band, so no instant is priced by the rule.
      const scanFrom = gap.at - 12 * 3_600_000;
      const fired: string[] = [];
      for (let offset = 0; offset < 24 * 60; offset += 1) {
        const instant = scanFrom + offset * 60_000;
        if (priceForSlot(svc, slot({ startUtc: instant }), timezone)?.ruleIndex === 0) {
          fired.push(localTimeOf(timezone, instant));
        }
      }
      expect(fired, `${timezone} ${gap.localDay} ${bandFrom}-${bandTo}`).toEqual([]);
    }
  });

  it.each(zones)('fires twice on the hour that happens twice in %s', (timezone) => {
    const overlaps = findTransitions(timezone, from, to).filter(
      (entry) => entry.kind === 'overlap',
    );
    expect(overlaps.length).toBeGreaterThan(0);
    for (const overlap of overlaps) {
      const repeated = localTimeOf(timezone, overlap.at);
      const bandFrom = `${repeated.slice(0, 2)}:00`;
      const bandTo = `${String((Number(bandFrom.slice(0, 2)) + 1) % 24).padStart(2, '0')}:00`;
      if (bandFrom === bandTo) continue;
      const rules: PricingRule[] = [
        { when: { time_from: bandFrom, time_to: bandTo }, price: 9900 },
      ];
      const svc = service({ rules });
      // The half hour before the change and the half hour after it read the same wall time.
      const before = overlap.at - 30 * 60_000;
      const after = overlap.at + 30 * 60_000;
      expect(localTimeOf(timezone, before)).toBe(localTimeOf(timezone, after));
      expect(priceForSlot(svc, slot({ startUtc: before }), timezone)?.price.amount).toBe(9900);
      expect(priceForSlot(svc, slot({ startUtc: after }), timezone)?.price.amount).toBe(9900);
    }
  });

  it('prices the day before a clock change as the day it is locally', () => {
    const transition = findTransitions(ROME, from, to)[0];
    expect(transition).toBeDefined();
    const day = previousDay(transition!.localDay);
    const rules: PricingRule[] = [{ when: { date_from: day, date_to: day }, price: 4200 }];
    const svc = service({ rules });
    expect(priceForSlot(svc, at(ROME, day, '23:30'), ROME)?.price.amount).toBe(4200);
    expect(priceForSlot(svc, at(ROME, transition!.localDay, '12:00'), ROME)?.ruleIndex).toBeNull();
  });
});

describe('priceForSlot, as a property', () => {
  const arbRule = fc.oneof(
    fc
      .record({ price: fc.integer({ min: 0, max: 1_000_000 }) })
      .map((effect): PricingRule => ({ when: { days: ['mon'] }, ...effect })),
    fc
      .record({ price_add: fc.integer({ min: -1_000_000, max: 1_000_000 }) })
      .map((effect): PricingRule => ({ when: { days: ['mon'] }, ...effect })),
    fc
      .record({ price_multiplier: fc.integer({ min: 1, max: 50_000 }).map((n) => n / 10_000) })
      .map((effect): PricingRule => ({ when: { days: ['mon'] }, ...effect })),
  );

  it('is deterministic: the same input gives the same answer', () => {
    fc.assert(
      fc.property(
        fc.array(arbRule, { maxLength: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 365 }),
        (rules, base, dayOffset) => {
          const svc = service({ price: { amount: base, currency: 'EUR' }, rules });
          const candidate = slot({ startUtc: Date.UTC(2026, 0, 1) + dayOffset * 86_400_000 });
          const first = priceForSlot(svc, candidate, ROME);
          const second = priceForSlot(svc, candidate, ROME);
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never produces a negative amount, and never leaves the integers', () => {
    fc.assert(
      fc.property(
        fc.array(arbRule, { maxLength: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 365 }),
        (rules, base, dayOffset) => {
          const svc = service({ price: { amount: base, currency: 'EUR' }, rules });
          const priced = priceForSlot(
            svc,
            slot({ startUtc: Date.UTC(2026, 0, 1) + dayOffset * 86_400_000 }),
            ROME,
          );
          expect(priced).not.toBeNull();
          expect(Number.isSafeInteger(priced!.price.amount)).toBe(true);
          expect(priced!.price.amount).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('always reports the first rule that matches, never a later one', () => {
    fc.assert(
      fc.property(
        fc.array(arbRule, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (rules, base) => {
          const svc = service({ price: { amount: base, currency: 'EUR' }, rules });
          // A Monday, so every rule in the arbitrary matches: the answer must be rule 0.
          const priced = priceForSlot(svc, at(ROME, '2026-09-14', '10:00'), ROME);
          expect(priced?.ruleIndex).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps the currency of the service whatever the rule does', () => {
    fc.assert(
      fc.property(fc.array(arbRule, { maxLength: 5 }), (rules) => {
        const svc = service({ price: { amount: 1234, currency: 'CHF' }, rules });
        expect(priceForSlot(svc, at(ROME, '2026-09-14', '10:00'), ROME)?.price.currency).toBe(
          'CHF',
        );
      }),
      { numRuns: 100 },
    );
  });
});
