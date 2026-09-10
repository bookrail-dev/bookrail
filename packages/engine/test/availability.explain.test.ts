/**
 * `explain: true`, against a real Postgres.
 *
 * One test per `explain` code the engine can report. Every expected value is written by hand
 * from the fixture, not read off a run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, utc, DAY, HOUR, MINUTE, type Harness } from './availability-harness.js';
import type { ExplainCode, ExplainEntry } from '../src/index.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const MONDAY = utc(2026, 6, 1);
const TUESDAY = utc(2026, 6, 2);

function at(entries: readonly ExplainEntry[], instant: number): ExplainEntry {
  const found = entries.find((entry) => entry.at === instant);
  if (found === undefined) {
    throw new Error(
      `No explanation at ${String(instant)}; got ${entries.map((e) => String(e.at)).join(', ')}`,
    );
  }
  return found;
}

function codes(entry: ExplainEntry): ExplainCode[] {
  return entry.reasons.map((reason) => reason.code);
}

describe('explain', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Explain');
  });

  afterAll(async () => {
    await h.close();
  });

  async function romeSchedule(startTime: string, endTime: string): Promise<string> {
    return h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: WEEKDAYS, startTime, endTime }],
    });
  }

  it('names the schedule, the exception, the block and the booking that stand in the way', async () => {
    const wide = await romeSchedule('09:00', '19:00');
    const narrow = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '12:00', endTime: '19:00' }],
      exceptions: [{ date: '2026-06-01', type: 'closed', startTime: '13:00', endTime: '14:00' }],
    });
    const therapist = await h.resource({ name: 'Therapist', scheduleId: wide });
    const cabin = await h.resource({ name: 'Cabin', scheduleId: narrow });

    const blockId = await h.block({
      resourceId: cabin,
      from: MONDAY + 13 * HOUR, // 15:00 local
      to: MONDAY + 14 * HOUR,
    });
    const bookingRef = await h.customer(); // any uuid works as a ref for a bare occupancy
    await h.occupancy({
      resourceId: cabin,
      from: MONDAY + 15 * HOUR, // 17:00 local
      to: MONDAY + 16 * HOUR,
      kind: 'booking',
      refId: bookingRef,
    });

    const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
    await h.requirement({ serviceId: service, resourceId: therapist, position: 0 });
    await h.requirement({ serviceId: service, resourceId: cabin, position: 1 });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );

    // The candidates run 09:00 to 18:00 local, from the widest set of rules.
    expect(result.explain).toBeDefined();
    expect(result.truncated).toBe(false);

    // 09:00 local: the cabin's rules do not open before 12:00.
    const nine = at(result.explain!, MONDAY + 7 * HOUR);
    expect(codes(nine)).toEqual(['outside_schedule']);
    expect(nine.reasons[0]!.resourceId).toBe(cabin);

    // 13:00 local: the rules cover it, a closed exception does not.
    expect(codes(at(result.explain!, MONDAY + 11 * HOUR))).toEqual(['exception_closed']);

    // 15:00 local: blocked, and the block is named.
    const blocked = at(result.explain!, MONDAY + 13 * HOUR);
    expect(codes(blocked)).toEqual(['blocked']);
    expect(blocked.reasons[0]!.refId).toBe(blockId);

    // 17:00 local: already booked, and the booking is named.
    const taken = at(result.explain!, MONDAY + 15 * HOUR);
    expect(codes(taken)).toEqual(['occupied']);
    expect(taken.reasons[0]!.refId).toBe(bookingRef);

    // 12:00, 14:00, 16:00 and 18:00 local are real slots and are absent from the explanation.
    expect(result.slots.map((slot) => slot.start)).toEqual([
      MONDAY + 10 * HOUR,
      MONDAY + 12 * HOUR,
      MONDAY + 14 * HOUR,
      MONDAY + 16 * HOUR,
    ]);
    for (const slot of result.slots) {
      expect(result.explain!.some((entry) => entry.at === slot.start)).toBe(false);
    }
  });

  it('tells a buffer apart from the booking that owns it', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Chair', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      bufferAfter: 30,
      slotInterval: 60,
      alignTo: 'hour',
    });
    await h.requirement({ serviceId: service, resourceId: resource });
    const ref = await h.customer();
    await h.occupancy({
      resourceId: resource,
      from: MONDAY + 10 * HOUR, // 12:00-13:00 local
      to: MONDAY + 11 * HOUR,
      refId: ref,
      // Written by this same service, so it carries this service's half hour of cleaning.
      bufferAfterMs: 30 * MINUTE,
    });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );

    // 12:00 local sits on the booking itself.
    const occupied = at(result.explain!, MONDAY + 10 * HOUR);
    expect(codes(occupied)).toEqual(['occupied']);
    expect(occupied.reasons[0]!.refId).toBe(ref);

    // 13:00 local is free of the booking, but its own thirty minutes of cleaning are not.
    const buffered = at(result.explain!, MONDAY + 11 * HOUR);
    expect(codes(buffered)).toEqual(['buffer']);
    expect(buffered.reasons[0]!.refId).toBe(ref);
  });

  it('says capacity when the resource is open but too small for the quantity asked', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Studio', capacity: 3, scheduleId: schedule });
    const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
    await h.requirement({ serviceId: service, resourceId: resource });
    await h.occupancy({
      resourceId: resource,
      from: MONDAY + 10 * HOUR,
      to: MONDAY + 11 * HOUR,
      capacityUsed: 2,
    });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true, quantity: 2 },
    );
    const short = at(result.explain!, MONDAY + 10 * HOUR);
    expect(codes(short)).toEqual(['capacity']);
    expect(short.reasons[0]!.detail).toContain('1 units left');
    expect(result.explain).toHaveLength(1);
  });

  it('says min_notice for the instants the notice swallows', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Desk', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      bookingWindow: { min_notice_minutes: 180 },
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY + 7 * HOUR, explain: true },
    );
    // Three hours of notice from 09:00 local push the first bookable start to 12:00 local.
    expect(result.explain!.map((entry) => entry.at)).toEqual([
      MONDAY + 7 * HOUR,
      MONDAY + 8 * HOUR,
      MONDAY + 9 * HOUR,
    ]);
    for (const entry of result.explain!) expect(codes(entry)).toEqual(['min_notice']);
    expect(result.slots[0]!.start).toBe(MONDAY + 10 * HOUR);
  });

  it('says max_advance past the horizon', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Court', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      bookingWindow: { max_advance_days: 0 },
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY, explain: true },
    );
    expect(result.slots).toEqual([]);
    expect(result.explain).toHaveLength(10);
    for (const entry of result.explain!) expect(codes(entry)).toEqual(['max_advance']);
  });

  it('says customer_limit on every candidate when the customer is at the limit', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Room', scheduleId: schedule });
    const policy = await h.policy({ maxActiveBookingsPerCustomer: 1 });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      policyId: policy,
    });
    await h.requirement({ serviceId: service, resourceId: resource });
    const customer = await h.customer();
    await h.booking({
      serviceId: service,
      customerId: customer,
      from: Date.now() + 30 * DAY,
      to: Date.now() + 30 * DAY + HOUR,
      status: 'pending',
    });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY, customerId: customer },
      { now: MONDAY - DAY, explain: true },
    );
    expect(result.reason?.code).toBe('customer_limit_reached');
    expect(result.explain).toHaveLength(10);
    for (const entry of result.explain!) expect(codes(entry)).toEqual(['customer_limit']);
  });

  it('truncates past the ceiling instead of growing without bound', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Tiny', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      bookingWindow: { max_advance_days: 0 },
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY, explain: true, maxExplainInstants: 3 },
    );
    expect(result.explain).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.explain!.map((entry) => entry.at)).toEqual([
      MONDAY + 7 * HOUR,
      MONDAY + 8 * HOUR,
      MONDAY + 9 * HOUR,
    ]);
  });

  it('explains a whole day closed by an exception', async () => {
    const schedule = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '19:00' }],
      exceptions: [{ date: '2026-06-01', type: 'closed' }],
    });
    const resource = await h.resource({ name: 'Holiday', scheduleId: schedule });
    const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );
    expect(result.slots).toEqual([]);
    expect(result.explain).toHaveLength(10);
    for (const entry of result.explain!) expect(codes(entry)).toEqual(['exception_closed']);
    expect(result.explain![0]!.at).toBe(MONDAY + 7 * HOUR);
    expect(result.explain![0]!.reasons[0]!.detail).toContain('Holiday');
  });

  /**
   * The defect the review found: with the grid anchored to the residual timeline the
   * accepted starts and the candidates fell on different phases, so most candidates were
   * emitted with no reason at all: an `explain` that says "not available" and nothing else.
   */
  it('never emits a candidate without a reason', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Phase', scheduleId: schedule });
    // No align_to: the default, which is where the two grids used to diverge.
    const service = await h.service({ durationMinutes: 60, slotInterval: 60 });
    await h.requirement({ serviceId: service, resourceId: resource });
    await h.occupancy({
      resourceId: resource,
      from: MONDAY + 7 * HOUR, // 09:00-09:15 local
      to: MONDAY + 7 * HOUR + 15 * MINUTE,
    });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );
    expect(result.slots.map((slot) => slot.start)).toEqual([
      MONDAY + 8 * HOUR,
      MONDAY + 9 * HOUR,
      MONDAY + 10 * HOUR,
      MONDAY + 11 * HOUR,
      MONDAY + 12 * HOUR,
      MONDAY + 13 * HOUR,
      MONDAY + 14 * HOUR,
      MONDAY + 15 * HOUR,
      MONDAY + 16 * HOUR,
    ]);
    expect(result.explain).toHaveLength(1);
    expect(codes(at(result.explain!, MONDAY + 7 * HOUR))).toEqual(['occupied']);
    for (const entry of result.explain!) expect(entry.reasons.length).toBeGreaterThan(0);
  });

  /** The documented ceiling: five hundred instants, then `truncated`. */
  it('stops at five hundred instants by default', async () => {
    const schedule = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }],
    });
    const resource = await h.resource({ name: 'Round the clock', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 5,
      alignTo: 'hour',
      // Everything is past the horizon, so every candidate is discarded and explained.
      bookingWindow: { max_advance_days: 0 },
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: MONDAY + 2 * DAY },
      { now: MONDAY - MINUTE, explain: true },
    );
    expect(result.slots).toEqual([]);
    expect(result.explain).toHaveLength(500);
    expect(result.truncated).toBe(true);
    for (const entry of result.explain!) expect(codes(entry)).toEqual(['max_advance']);
  });

  /**
   * A rule stored on the service that the strict schema refuses is skipped rather than fatal,
   * and it used to be skipped in silence: the only symptom was a `price_rule.index` pointing at
   * a different rule. The rule below is written straight into the column through the admin
   * connection, which is the only way it can exist at all: `POST`/`PATCH /v1/services` refuses
   * it.
   */
  it('reports a stored pricing rule the schema refuses, and prices with the next one', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Priced', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [
        // `time_from` without `time_to`: refused by the schema, and the API would never have
        // let it in. It keeps its position, so the rule after it is still rule 1.
        { when: { time_from: '09:00' }, price: 9900, label: 'Broken' },
        { when: { days: ['mon'] }, price_add: 500, label: 'Monday' },
      ],
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );

    expect(result.explainNotes).toHaveLength(1);
    expect(result.explainNotes![0]).toMatchObject({ code: 'pricing_rule_ignored', index: 0 });
    expect(result.explainNotes![0]!.detail).toContain('pricing_rules');

    // The price is the one rule 1 produces, and it is reported at position 1 of the column.
    expect(result.slots.length).toBeGreaterThan(0);
    for (const slot of result.slots) {
      expect(slot.price).toEqual({ amount: 3500, currency: 'EUR' });
      expect(slot.priceRule).toEqual({ index: 1, label: 'Monday' });
    }
  });

  it('says nothing about the pricing rules of a service whose rules are all valid', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Sound', scheduleId: schedule });
    const service = await h.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { days: ['mon'] }, price_add: 500, label: 'Monday' }],
    });
    await h.requirement({ serviceId: service, resourceId: resource });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, explain: true },
    );
    expect(result.explainNotes).toEqual([]);
  });

  it('costs nothing when it is not asked for', async () => {
    const schedule = await romeSchedule('09:00', '19:00');
    const resource = await h.resource({ name: 'Quiet', scheduleId: schedule });
    const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
    await h.requirement({ serviceId: service, resourceId: resource });
    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: MONDAY + 12 * HOUR + 30 * MINUTE },
      { now: MONDAY - DAY },
    );
    expect(result.explain).toBeUndefined();
    expect(result.explainNotes).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });
});
