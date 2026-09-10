/**
 * The state machine, against a real Postgres, through the application role.
 *
 * Nothing is mocked and nothing waits: every instant is injected as `now`, which is why the
 * automatic transitions can be tested at the millisecond instead of with a sleep. The
 * assertions read the tables back with the superuser connection, because a transition the
 * engine *says* it applied and that is not in `bookings`, `occupancies` and `events` is
 * exactly what these tests exist to catch.
 *
 * The fixtures live in 2031: the write path refuses a start in the past, so a booking created
 * on a 2026 fixture would be rejected before any transition could be tested on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@bookrail/db';
import { encodeId } from '@bookrail/shared';

import {
  createBooking,
  invalidTransition,
  nextTransitionFor,
  noShowChargePercent,
  parseDurationMs,
  policyTiers,
  tierFor,
  transition,
  DURATION_PATTERN,
  TRANSITIONS,
  type TransitionAction,
} from '../src/index.js';
import { createHarness, utc, DAY, HOUR, MINUTE, type Harness } from './availability-harness.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Monday 2 June 2031. Rome is on CEST, so 09:00 local is 07:00Z. */
const MONDAY = utc(2031, 6, 2);
const NINE = MONDAY + 7 * HOUR;
const NOW = MONDAY - 7 * DAY;

interface BookingRow extends Record<string, unknown> {
  status: string;
  refund_percent: string | null;
  refund_amount_expected: number | null;
  no_show_charge_expected: number | null;
  price_amount: number | null;
  price_rule: { index: number; label: string | null } | null;
  reschedule_fee_expected: number | null;
  reschedule_count: number;
  rescheduled_to_booking_id: string | null;
  rescheduled_from_booking_id: string | null;
  next_transition: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  checked_in_at: string | null;
  next_transition_at: string | null;
  no_show_at: string | null;
  amount_refunded: number;
}

describe('booking transitions', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Lifecycle');
  });

  afterAll(async () => {
    await h.close();
  });

  async function rows<T extends Record<string, unknown>>(
    text: ReturnType<typeof sql>,
  ): Promise<T[]> {
    const result = await h.admin.execute<T>(text);
    return result.rows as T[];
  }

  async function bookingRow(id: string): Promise<BookingRow> {
    const found = await rows<BookingRow>(sql`SELECT * FROM bookings WHERE id = ${id}`);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  async function eventsOf(bookingId: string): Promise<
    {
      type: string;
      data: Record<string, unknown>;
      previous: Record<string, unknown> | null;
      actor: Record<string, unknown> | null;
    }[]
  > {
    return rows(sql`
      SELECT type, data, previous, actor FROM events
       WHERE project_id = ${h.projectId} AND data ->> 'id' = ${encodeId('booking', bookingId)}
       ORDER BY seq
    `);
  }

  /** One resource of the given capacity, open round the clock, and a one hour service on it. */
  async function scenario(
    options: {
      capacity?: number;
      policyId?: string | null;
      price?: { amount: number; currency: string } | null;
      pricingRules?: readonly unknown[];
    } = {},
  ): Promise<{ resourceId: string; serviceId: string }> {
    const schedule = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '00:00' }],
    });
    const resourceId = await h.resource({
      name: 'Court',
      capacity: options.capacity ?? 1,
      scheduleId: schedule,
    });
    const serviceId = await h.service({
      durationMinutes: 60,
      policyId: options.policyId ?? null,
      price: options.price ?? null,
      pricingRules: options.pricingRules ?? [],
    });
    await h.requirement({ serviceId, resourceId });
    return { resourceId, serviceId };
  }

  async function book(
    serviceId: string,
    options: { start?: number; customerId?: string | null } = {},
  ): Promise<string> {
    const result = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: options.start ?? NINE,
      customerId: options.customerId ?? null,
      kind: 'booking',
      now: NOW,
    });
    return result.id;
  }

  function move(
    bookingId: string,
    action: TransitionAction,
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof transition> {
    return transition(h.app, {
      projectId: h.projectId,
      environment: 'test',
      bookingId,
      action,
      actor: { type: 'api', id: 'key_test' },
      now: NOW,
      ...extra,
    });
  }

  // --- The matrix ----------------------------------------------------------------------------

  it('exposes the documented transition matrix, and nothing more', () => {
    expect(TRANSITIONS).toEqual({
      pending: { confirm: 'confirmed', cancel: 'cancelled', reschedule: 'rescheduled' },
      confirmed: {
        cancel: 'cancelled',
        reschedule: 'rescheduled',
        check_in: 'in_progress',
        start: 'in_progress',
        complete: 'completed',
        no_show: 'no_show',
      },
      in_progress: { cancel: 'cancelled', complete: 'completed', no_show: 'no_show' },
    });
    // The terminal states are terminal: absent from the matrix entirely.
    for (const status of ['held', 'completed', 'cancelled', 'no_show', 'rescheduled'] as const) {
      expect(TRANSITIONS[status]).toBeUndefined();
    }
  });

  it('walks confirmed → in_progress → completed, one event each', async () => {
    const { serviceId } = await scenario();
    const bookingId = await book(serviceId);

    const checkedIn = await move(bookingId, 'check_in');
    expect(checkedIn.status).toBe('in_progress');
    expect(checkedIn.eventIds).toHaveLength(1);
    expect((await bookingRow(bookingId)).checked_in_at).not.toBeNull();

    // At the start, not before it: `completed` keeps its occupancy, and that only makes sense
    // for a booking whose time has come.
    const completed = await move(bookingId, 'complete', { now: NINE + HOUR });
    expect(completed.status).toBe('completed');

    const events = await eventsOf(bookingId);
    expect(events.map((event) => event.type)).toEqual([
      'booking.created',
      'booking.checked_in',
      'booking.completed',
    ]);
    // `previous` names what changed, and only what changed.
    expect(events[1]!.previous).toMatchObject({ status: 'confirmed', checked_in_at: null });
    expect(events[1]!.data).toMatchObject({ status: 'in_progress' });
    expect(events[1]!.actor).toEqual({ type: 'api', id: 'key_test' });
  });

  it('confirms a pending booking and refuses to confirm it twice', async () => {
    const policyId = await h.policy({ requiresConfirmation: true });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    expect((await bookingRow(bookingId)).status).toBe('pending');

    const confirmed = await move(bookingId, 'confirm');
    expect(confirmed.previousStatus).toBe('pending');
    expect(confirmed.status).toBe('confirmed');

    await expect(move(bookingId, 'confirm')).rejects.toMatchObject({
      code: 'invalid_transition',
      status: 409,
    });
  });

  it('names the current status and the allowed actions in the 409', async () => {
    const { serviceId } = await scenario();
    const bookingId = await book(serviceId);
    await move(bookingId, 'cancel');
    await expect(move(bookingId, 'check_in')).rejects.toMatchObject({
      type: 'conflict',
      code: 'invalid_transition',
      message: expect.stringContaining('"cancelled"'),
    });
    await expect(move(bookingId, 'check_in')).rejects.toMatchObject({
      message: expect.stringContaining('terminal state'),
    });
  });

  it('refuses every action the matrix does not allow, from every status', async () => {
    const actions: TransitionAction[] = [
      'confirm',
      'cancel',
      'reschedule',
      'no_show',
      'check_in',
      'complete',
      'start',
    ];
    // One booking per (status, forbidden action) pair, driven into that status first.
    const reach: Record<string, (id: string) => Promise<void>> = {
      confirmed: async () => {},
      in_progress: async (id) => void (await move(id, 'check_in')),
      completed: async (id) => void (await move(id, 'complete', { now: NINE + HOUR })),
      cancelled: async (id) => void (await move(id, 'cancel')),
      no_show: async (id) => void (await move(id, 'no_show', { now: NINE + HOUR })),
    };
    for (const [status, drive] of Object.entries(reach)) {
      const allowed = Object.keys(TRANSITIONS[status as keyof typeof TRANSITIONS] ?? {});
      for (const action of actions) {
        if (allowed.includes(action)) continue;
        const { serviceId } = await scenario();
        const bookingId = await book(serviceId);
        await drive(bookingId);
        await expect(
          move(bookingId, action, {
            // `now` past the start so that a refusal is the matrix speaking, not the
            // `complete_too_early` / `no_show_too_early` guards, which are tested on their own.
            now: NINE + HOUR,
            ...(action === 'reschedule' ? { start: NINE + 3 * HOUR } : {}),
          }),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
      }
    }
  });

  // --- Cancellation and the refund ------------------------------------------------------------

  const TIERS = [
    { before: '48h', refund_percent: 100 },
    { before: '24h', refund_percent: 50 },
    { before: '0h', refund_percent: 0 },
  ];

  it('picks the tier at the exact boundary, not a millisecond either side', async () => {
    const policyId = await h.policy({ cancellation: TIERS });
    const { serviceId } = await scenario({ policyId });

    const cases: { remaining: number; expected: number }[] = [
      { remaining: 72 * HOUR, expected: 100 },
      { remaining: 48 * HOUR, expected: 100 },
      { remaining: 48 * HOUR - 1, expected: 50 },
      { remaining: 24 * HOUR, expected: 50 },
      { remaining: 24 * HOUR - 1, expected: 0 },
      { remaining: 0, expected: 0 },
      { remaining: -1, expected: 0 },
    ];
    for (const testCase of cases) {
      const bookingId = await book(serviceId);
      const result = await move(bookingId, 'cancel', { now: NINE - testCase.remaining });
      expect({ ...testCase, got: result.refundPercent }).toEqual({
        ...testCase,
        got: testCase.expected,
      });
      expect(Number((await bookingRow(bookingId)).refund_percent)).toBe(testCase.expected);
    }
  });

  it('refunds 100% when the provider cancels, and honours an override for anyone', async () => {
    const policyId = await h.policy({ cancellation: TIERS });
    const { serviceId } = await scenario({ policyId });

    const byProvider = await book(serviceId);
    // One hour before the start: the customer would get nothing.
    const provider = await move(byProvider, 'cancel', { by: 'provider', now: NINE - HOUR });
    expect(provider.refundPercent).toBe(100);
    expect((await bookingRow(byProvider)).cancelled_by).toBe('provider');

    const overridden = await book(serviceId);
    const override = await move(overridden, 'cancel', {
      by: 'customer',
      overrideRefundPercent: 25,
      now: NINE - HOUR,
    });
    expect(override.refundPercent).toBe(25);

    // The override beats `by: provider` too, in the other direction.
    const cheap = await book(serviceId);
    const cheapResult = await move(cheap, 'cancel', {
      by: 'provider',
      overrideRefundPercent: 0,
      now: NINE - HOUR,
    });
    expect(cheapResult.refundPercent).toBe(0);
  });

  it('refunds nothing when the policy has no tiers, or when there is no policy at all', async () => {
    const empty = await h.policy({});
    for (const policyId of [empty, null]) {
      const { serviceId } = await scenario({ policyId });
      const bookingId = await book(serviceId);
      const result = await move(bookingId, 'cancel', { now: NOW });
      expect(result.refundPercent).toBe(0);
      expect(result.refundAmountExpected).toBe(0);
    }
  });

  it('computes the refund on amount_paid, not on the price', async () => {
    const policyId = await h.policy({ cancellation: TIERS });
    const { serviceId } = await scenario({ policyId, price: { amount: 4500, currency: 'EUR' } });
    const bookingId = await book(serviceId);
    // Payments do not exist yet, so `amount_paid` is set here the way one will set it.
    await h.admin.execute(sql`UPDATE bookings SET amount_paid = 4500 WHERE id = ${bookingId}`);
    const result = await move(bookingId, 'cancel', { now: NINE - 30 * HOUR, reason: 'ill' });
    expect(result.refundPercent).toBe(50);
    expect(result.refundAmountExpected).toBe(2250);
    const row = await bookingRow(bookingId);
    expect(row.refund_amount_expected).toBe(2250);
    expect(row.cancellation_reason).toBe('ill');
    // Nothing has actually moved: this is an expectation, not a refund.
    expect(row.amount_refunded).toBe(0);
  });

  it('gives the capacity back when it cancels', async () => {
    const { resourceId, serviceId } = await scenario();
    const bookingId = await book(serviceId);
    expect(await activeOccupancies(resourceId)).toBe(1);

    const result = await move(bookingId, 'cancel');
    expect(await activeOccupancies(resourceId)).toBe(0);
    expect(result.touchedDays.length).toBeGreaterThan(0);
    // The row is not deleted: it is the record that the capacity was once taken.
    const all = await rows<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM occupancies WHERE ref_id = ${bookingId}`,
    );
    expect(Number(all[0]!.count)).toBe(1);

    // And the slot is bookable again.
    await expect(book(serviceId)).resolves.toBeTruthy();
  });

  it('keeps the occupancy of a completed booking, and releases that of a no-show', async () => {
    const { resourceId, serviceId } = await scenario();
    const completed = await book(serviceId);
    await move(completed, 'complete', { now: NINE + HOUR });
    expect(await activeOccupancies(resourceId)).toBe(1);

    const { resourceId: other, serviceId: otherService } = await scenario();
    const noShow = await book(otherService);
    await move(noShow, 'no_show', { now: NINE + MINUTE });
    expect(await activeOccupancies(other)).toBe(0);
  });

  async function activeOccupancies(resourceId: string): Promise<number> {
    const found = await rows<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM occupancies
       WHERE resource_id = ${resourceId} AND active
    `);
    return Number(found[0]!.count);
  }

  // --- No-show -----------------------------------------------------------------------------------

  it('refuses a no-show before the grace period and accepts it at the exact minute', async () => {
    const policyId = await h.policy({
      noShow: { grace_minutes: 15, charge_percent: 50 },
    });
    const { serviceId } = await scenario({ policyId, price: { amount: 4000, currency: 'EUR' } });

    const early = await book(serviceId);
    await expect(move(early, 'no_show', { now: NINE + 15 * MINUTE - 1 })).rejects.toMatchObject({
      type: 'policy_violation',
      code: 'no_show_too_early',
      status: 422,
    });

    const onTime = await move(early, 'no_show', { now: NINE + 15 * MINUTE });
    expect(onTime.status).toBe('no_show');
    expect(onTime.noShowChargeExpected).toBe(2000);
    expect((await bookingRow(early)).no_show_at).not.toBeNull();
  });

  it('charges nothing for a no-show when the policy says nothing', async () => {
    const { serviceId } = await scenario({ price: { amount: 4000, currency: 'EUR' } });
    const bookingId = await book(serviceId);
    // No policy, so no grace either: a no-show is possible from the start itself.
    await expect(move(bookingId, 'no_show', { now: NINE - 1 })).rejects.toMatchObject({
      code: 'no_show_too_early',
    });
    const result = await move(bookingId, 'no_show', { now: NINE });
    expect(result.noShowChargeExpected).toBe(0);
  });

  // --- Dynamic prices, end to end -----------------------------------------------------------------

  /**
   * The whole dynamic price chain, on one booking: a weekend rule makes the slot
   * cost more, the booking freezes **that** price, and the no-show charge is a percentage of
   * the frozen price and not of the flat one.
   *
   * The fixture is Saturday 7 June 2031 in Rome, which is `MONDAY + 5 days`.
   */
  const SATURDAY_NINE = NINE + 5 * DAY;

  it('freezes the price a pricing rule produced, and charges the no-show on it', async () => {
    const policyId = await h.policy({ noShow: { grace_minutes: 0, charge_percent: 50 } });
    const { serviceId } = await scenario({
      policyId,
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { days: ['sat', 'sun'] }, price_add: 1000, label: 'Weekend' }],
    });
    // The fixture really is a Saturday in Rome, which is what the rule is about.
    expect(new Date(SATURDAY_NINE).getUTCDay()).toBe(6);

    const created = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: SATURDAY_NINE,
      kind: 'booking',
      now: NOW,
    });
    expect(created.price).toEqual({ amount: 4000, currency: 'EUR' });
    expect(created.priceRule).toEqual({ index: 0, label: 'Weekend' });

    const row = await bookingRow(created.id);
    expect(row.price_amount).toBe(4000);
    expect(row.price_rule).toEqual({ index: 0, label: 'Weekend' });

    // The event announces the same thing, which is what a consumer mirroring bookings reads.
    const [createdEvent] = await eventsOf(created.id);
    expect(createdEvent?.data.price).toEqual({ amount: 4000, currency: 'EUR' });
    expect(createdEvent?.data.price_rule).toEqual({ index: 0, label: 'Weekend' });

    // 50 % of the **surcharged** price, not of the flat 3000.
    const noShow = await move(created.id, 'no_show', { now: SATURDAY_NINE });
    expect(noShow.noShowChargeExpected).toBe(2000);
  });

  it('does not move a frozen price when the rules change afterwards', async () => {
    const { serviceId } = await scenario({
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { days: ['sat', 'sun'] }, price: 5000, label: 'Weekend' }],
    });
    const created = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: SATURDAY_NINE,
      kind: 'booking',
      now: NOW,
    });
    expect(created.price?.amount).toBe(5000);

    await h.setPricingRules(serviceId, []);
    const row = await bookingRow(created.id);
    expect(row.price_amount).toBe(5000);
    expect(row.price_rule).toEqual({ index: 0, label: 'Weekend' });
  });

  it('prices a hold at conversion, not at the hold', async () => {
    const { serviceId } = await scenario({
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { days: ['sat', 'sun'] }, price: 5000, label: 'Weekend' }],
    });
    const hold = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: SATURDAY_NINE,
      kind: 'hold',
      now: NOW,
    });
    expect(hold.price?.amount).toBe(5000);

    // The rules move between the hold and the conversion: a booking takes the price of the
    // conversion, never the one quoted when the hold was taken, and it does.
    await h.setPricingRules(serviceId, [
      { when: { days: ['sat', 'sun'] }, price: 6000, label: 'Weekend, revised' },
    ]);
    const booking = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: SATURDAY_NINE,
      kind: 'booking',
      holdId: hold.id,
      now: NOW,
    });
    expect(booking.price?.amount).toBe(6000);
    expect(booking.priceRule).toEqual({ index: 0, label: 'Weekend, revised' });
    expect((await bookingRow(booking.id)).price_rule).toEqual({
      index: 0,
      label: 'Weekend, revised',
    });
  });

  it('prices the new booking of a reschedule for the slot it moved to', async () => {
    const { serviceId } = await scenario({
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { days: ['sat', 'sun'] }, price: 5000, label: 'Weekend' }],
    });
    const created = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: SATURDAY_NINE,
      kind: 'booking',
      now: NOW,
    });
    expect(created.price?.amount).toBe(5000);

    // Saturday to the Monday after it: the weekend rule stops applying, and the new booking
    // carries the flat price. The old booking keeps the 5000 it froze
    // (reconciling the two amounts belongs to payments, not here).
    const moved = await move(created.id, 'reschedule', { start: SATURDAY_NINE + 2 * DAY });
    expect(moved.newBookingId).not.toBeNull();
    const fresh = await bookingRow(moved.newBookingId!);
    expect(fresh.price_amount).toBe(3000);
    expect(fresh.price_rule).toBeNull();
    expect((await bookingRow(created.id)).price_amount).toBe(5000);
  });

  // --- Reschedule ---------------------------------------------------------------------------------

  it('moves the booking, links the two, and leaves exactly one occupancy', async () => {
    const policyId = await h.policy({ reschedule: [{ before: '24h', fee: 500 }] });
    const { resourceId, serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);

    const result = await move(bookingId, 'reschedule', { start: NINE + 3 * HOUR });
    expect(result.status).toBe('rescheduled');
    expect(result.newBookingId).not.toBeNull();
    expect(result.rescheduleFeeExpected).toBe(500);
    expect(result.eventIds).toHaveLength(2);

    const old = await bookingRow(bookingId);
    const fresh = await bookingRow(result.newBookingId!);
    expect(old.status).toBe('rescheduled');
    expect(old.rescheduled_to_booking_id).toBe(result.newBookingId);
    expect(fresh.rescheduled_from_booking_id).toBe(bookingId);
    expect(fresh.reschedule_count).toBe(1);
    expect(fresh.reschedule_fee_expected).toBe(500);
    expect(fresh.status).toBe('confirmed');

    // One active occupancy on the resource, at the new instant and nowhere else.
    expect(await activeOccupancies(resourceId)).toBe(1);
    const active = await rows<{ ref_id: string; lower: string }>(sql`
      SELECT ref_id, lower(period)::text AS lower FROM occupancies
       WHERE resource_id = ${resourceId} AND active
    `);
    expect(active[0]!.ref_id).toBe(result.newBookingId);

    const events = await eventsOf(bookingId);
    expect(events.map((event) => event.type)).toEqual(['booking.created', 'booking.rescheduled']);
    expect(events[1]!.previous).toMatchObject({ status: 'confirmed' });
    expect(events[1]!.data).toMatchObject({
      status: 'rescheduled',
      rescheduled_to_booking_id: encodeId('booking', result.newBookingId!),
    });
    // The new booking has its own `booking.created`, identical in shape to a plain creation.
    const created = await eventsOf(result.newBookingId!);
    expect(created.map((event) => event.type)).toEqual(['booking.created']);
  });

  it('moves a booking onto a period that overlaps its own, on a capacity 1 resource', async () => {
    // The commonest reschedule there is (a court from 09:00 to 09:30) and the one the
    // exclusion constraint would refuse if the old occupancy were still active.
    const { resourceId, serviceId } = await scenario({ capacity: 1 });
    const bookingId = await book(serviceId);
    const result = await move(bookingId, 'reschedule', { start: NINE + 30 * MINUTE });
    expect(result.newBookingId).not.toBeNull();
    expect(await activeOccupancies(resourceId)).toBe(1);
  });

  it('leaves the old booking untouched when the new slot is gone', async () => {
    const { resourceId, serviceId } = await scenario({ capacity: 1 });
    const bookingId = await book(serviceId);
    // Somebody else takes 11:00 first.
    const rival = await book(serviceId, { start: NINE + 2 * HOUR });

    await expect(move(bookingId, 'reschedule', { start: NINE + 2 * HOUR })).rejects.toMatchObject({
      type: 'conflict',
      code: 'slot_unavailable',
    });

    const old = await bookingRow(bookingId);
    expect(old.status).toBe('confirmed');
    expect(old.rescheduled_to_booking_id).toBeNull();
    // Both original bookings still hold their capacity: the rollback took the release with it.
    expect(await activeOccupancies(resourceId)).toBe(2);
    expect((await bookingRow(rival)).status).toBe('confirmed');
    // And no event survived the rollback.
    expect((await eventsOf(bookingId)).map((event) => event.type)).toEqual(['booking.created']);
  });

  it('respects max_reschedules', async () => {
    const policyId = await h.policy({ maxReschedules: 1, reschedule: [{ before: '0h', fee: 0 }] });
    const { serviceId } = await scenario({ policyId });
    const first = await book(serviceId);

    const once = await move(first, 'reschedule', { start: NINE + 2 * HOUR });
    const second = once.newBookingId!;
    await expect(move(second, 'reschedule', { start: NINE + 4 * HOUR })).rejects.toMatchObject({
      type: 'policy_violation',
      code: 'max_reschedules_reached',
      status: 422,
    });
    expect((await bookingRow(second)).status).toBe('confirmed');
  });

  it('refuses a new start that is not on the service grid', async () => {
    const { serviceId } = await scenario();
    // The service takes an hourly grid, so 09:17 is not an instant the offer would ever show.
    await h.admin.execute(
      sql`UPDATE services SET slot_interval_minutes = 60, align_to = 'hour' WHERE id = ${serviceId}`,
    );
    const bookingId = await book(serviceId);
    await expect(
      move(bookingId, 'reschedule', { start: NINE + 17 * MINUTE }),
    ).rejects.toMatchObject({ code: 'start_not_on_grid' });
    expect((await bookingRow(bookingId)).status).toBe('confirmed');
  });

  it('lets a customer at the booking limit move a booking', async () => {
    const policyId = await h.policy({ maxActiveBookingsPerCustomer: 1 });
    const { serviceId } = await scenario({ policyId });
    const customerId = await h.customer();
    const bookingId = await book(serviceId, { customerId });
    // A second booking would be refused…
    await expect(book(serviceId, { customerId, start: NINE + 5 * HOUR })).rejects.toMatchObject({
      code: 'customer_limit_reached',
    });
    // …but moving the one they have must work: the old booking stops counting first.
    const result = await move(bookingId, 'reschedule', { start: NINE + 5 * HOUR });
    expect(result.newBookingId).not.toBeNull();
  });

  it('never lets a concurrent reader see the slot free while the reschedule runs', async () => {
    const { resourceId, serviceId } = await scenario({ capacity: 1 });
    const bookingId = await book(serviceId);

    // A second connection reads the occupancies of the resource while the reschedule holds its
    // transaction open. Under `read committed` it must see the old booking still occupying,
    // never zero: the window in which neither occupies exists only inside the transaction.
    const observed: number[] = [];
    const reader = (async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        observed.push(await activeOccupancies(resourceId));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    const result = await move(bookingId, 'reschedule', { start: NINE + 4 * HOUR });
    await reader;

    expect(result.newBookingId).not.toBeNull();
    expect(observed.length).toBeGreaterThan(10);
    // Never zero, and never two.
    expect(observed.every((count) => count === 1)).toBe(true);
  });

  // --- The automatic clock ------------------------------------------------------------------------

  it('sets next_transition at creation, from the policy', async () => {
    const policyId = await h.policy({ autoStart: true, autoComplete: true });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    const row = await bookingRow(bookingId);
    expect(row.next_transition).toBe('start');
    expect(new Date(row.next_transition_at!).getTime()).toBe(NINE);
  });

  it('recomputes the clock after every transition, in the order they happen', async () => {
    const policyId = await h.policy({
      autoStart: true,
      autoComplete: true,
      noShow: { auto_mark: true, grace_minutes: 10 },
    });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);

    // confirmed: `start` is the earliest of the three.
    expect((await bookingRow(bookingId)).next_transition).toBe('start');

    const started = await move(bookingId, 'start', { now: NINE });
    expect(started.status).toBe('in_progress');
    // Nobody checked in, so the no-show is next, at start + grace.
    expect(started.nextTransition).toEqual({ action: 'no_show', at: NINE + 10 * MINUTE });
    // …and `start` did **not** set `checked_in_at`, which is what keeps that true.
    expect((await bookingRow(bookingId)).checked_in_at).toBeNull();

    // A check-in takes the no-show off the table and leaves the completion.
    const { serviceId: other } = await scenario({ policyId });
    const attended = await book(other);
    const checkedIn = await move(attended, 'check_in', { now: NINE + MINUTE });
    expect(checkedIn.nextTransition).toEqual({ action: 'complete', at: NINE + HOUR });
  });

  it('clears the clock on a terminal state', async () => {
    const policyId = await h.policy({ autoComplete: true });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    expect((await bookingRow(bookingId)).next_transition).toBe('complete');
    await move(bookingId, 'cancel');
    const row = await bookingRow(bookingId);
    expect(row.next_transition).toBeNull();
    expect(row.next_transition_at).toBeNull();
  });

  it('applies an automatic transition once, whatever the number of workers', async () => {
    const policyId = await h.policy({ autoComplete: true });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);

    // Four "workers" reaching the same due booking at the same instant.
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        move(bookingId, 'complete', {
          now: NINE + HOUR,
          expectedNextTransition: 'complete',
        }),
      ),
    );
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => !result.applied)).toHaveLength(3);
    expect((await bookingRow(bookingId)).status).toBe('completed');
    // And exactly one event, not four.
    const events = await eventsOf(bookingId);
    expect(events.filter((event) => event.type === 'booking.completed')).toHaveLength(1);
  });

  it('does not apply a transition whose time has not come', async () => {
    const policyId = await h.policy({ autoComplete: true });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    const result = await move(bookingId, 'complete', {
      now: NINE,
      expectedNextTransition: 'complete',
    });
    expect(result.applied).toBe(false);
    expect((await bookingRow(bookingId)).status).toBe('confirmed');
  });

  // --- Pure helpers -------------------------------------------------------------------------------

  it('parses the durations 07 uses, and refuses the rest', () => {
    expect(parseDurationMs('48h')).toBe(48 * HOUR);
    expect(parseDurationMs('30m')).toBe(30 * MINUTE);
    expect(parseDurationMs('7d')).toBe(7 * DAY);
    expect(parseDurationMs('0h')).toBe(0);
    expect(parseDurationMs('tomorrow')).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
  });

  it('drops a malformed tier instead of failing the whole cancellation', () => {
    const tiers = policyTiers(
      { cancellation: [{ before: 'soon', refund_percent: 100 }, ...TIERS, 42] },
      'cancellation',
    );
    expect(tiers.map((tier) => tier.beforeMs)).toEqual([48 * HOUR, 24 * HOUR, 0]);
    expect(tierFor(tiers, 47 * HOUR)?.refundPercent).toBe(50);
    expect(tierFor([], 5)).toBeNull();
  });

  it('drops a percentage or a fee out of range, rather than letting it reach the column', () => {
    // A `refund_percent` of 150 used to travel all the way to the `numeric(5,2) CHECK (<= 100)`
    // of migration 0011 and turn the cancellation into a 400 naming an internal constraint,
    // leaving the booking uncancellable except through an override, while a malformed tier
    // must never stop a cancellation.
    const tiers = policyTiers(
      {
        cancellation: [
          { before: '72h', refund_percent: 150 },
          { before: '48h', refund_percent: -10 },
          { before: '24h', refund_percent: 50 },
        ],
      },
      'cancellation',
    );
    expect(tiers.map((tier) => tier.refundPercent)).toEqual([null, null, 50]);

    const fees = policyTiers(
      {
        reschedule: [
          { before: '24h', fee: -100 },
          { before: '0h', fee: 300 },
        ],
      },
      'reschedule',
    );
    expect(fees.map((tier) => tier.fee)).toEqual([null, 300]);
  });

  it('cancels a booking whose policy carries an impossible percentage', async () => {
    const policyId = await h.policy({ cancellation: [{ before: '72h', refund_percent: 100 }] });
    const { serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    // An import, or a policy written by an older version of the API, could carry this.
    await h.admin.execute(sql`
      UPDATE bookings
         SET policy_snapshot = '{"cancellation":[{"before":"48h","refund_percent":150}]}'::jsonb
       WHERE id = ${bookingId}
    `);
    const result = await move(bookingId, 'cancel', { now: NOW });
    expect(result.refundPercent).toBe(0);
    expect((await bookingRow(bookingId)).status).toBe('cancelled');
  });

  it('caps a no-show charge percentage at what the model allows', () => {
    expect(noShowChargePercent({ no_show: { charge_percent: 150 } })).toBe(0);
    expect(noShowChargePercent({ no_show: { charge_percent: 50 } })).toBe(50);
    expect(noShowChargePercent(null)).toBe(0);
  });

  it('reads exactly the durations the API accepts, and nothing else', () => {
    // The engine and the Zod schema compile the same `DURATION_PATTERN`, so a duration one
    // understands is a duration the other accepts. A bare number used to mean **milliseconds**,
    // so `{"before": 24}` was 24 ms and silently refunded nothing.
    expect(new RegExp(`^${DURATION_PATTERN}$`).test('90s')).toBe(true);
    expect(new RegExp(`^${DURATION_PATTERN}$`).test('1.5h')).toBe(false);
    expect(parseDurationMs(24)).toBeNull();
    expect(parseDurationMs(86_400_000)).toBeNull();
    expect(parseDurationMs('1.5h')).toBeNull();
  });

  it('refuses to complete a booking that has not started', async () => {
    // `completed` keeps its occupancy (the period is in the past and the row is the record
    // that the resource was used), and that only holds for a booking whose time has come.
    // Completing one ten days early took its slot off the market for ever, with no way back
    // and no event saying so.
    const { resourceId, serviceId } = await scenario();
    const bookingId = await book(serviceId);
    await expect(move(bookingId, 'complete', { now: NINE - 1 })).rejects.toMatchObject({
      type: 'policy_violation',
      code: 'complete_too_early',
      status: 422,
    });
    expect((await bookingRow(bookingId)).status).toBe('confirmed');

    // From the start onwards it is allowed, and the occupancy stays.
    const done = await move(bookingId, 'complete', { now: NINE });
    expect(done.status).toBe('completed');
    expect(await activeOccupancies(resourceId)).toBe(1);
  });

  it('cancels a booking that has already started, releasing the rest of the slot', async () => {
    const policyId = await h.policy({ cancellation: [{ before: '0h', refund_percent: 0 }] });
    const { resourceId, serviceId } = await scenario({ policyId });
    const bookingId = await book(serviceId);
    await move(bookingId, 'check_in', { now: NINE });

    const cancelled = await move(bookingId, 'cancel', {
      now: NINE + 10 * MINUTE,
      by: 'provider',
      reason: 'the boiler broke',
    });
    expect(cancelled.previousStatus).toBe('in_progress');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.refundPercent).toBe(100);
    expect(await activeOccupancies(resourceId)).toBe(0);
  });

  it('writes an English sentence when it refuses a transition', () => {
    expect(invalidTransition('cancelled', 'cancel', []).message).toBe(
      'A booking in status "cancelled" cannot be cancelled. This is a terminal state: no action leaves it.',
    );
    expect(invalidTransition('in_progress', 'check_in', ['complete', 'no_show']).message).toBe(
      'A booking in status "in_progress" cannot be checked in. Allowed from here: complete, no_show.',
    );
    expect(invalidTransition('completed', 'no_show', []).message).toContain(
      'cannot be marked as a no-show',
    );
  });

  it('orders the automatic candidates by instant, then by the order they happen in', () => {
    const booking = { status: 'confirmed' as const, startsAt: 100, endsAt: 200, checkedInAt: null };
    // grace 0 makes `start` and `no_show` tie; `start` happens first.
    expect(
      nextTransitionFor(booking, {
        auto_start: true,
        no_show: { auto_mark: true, grace_minutes: 0 },
      }),
    ).toEqual({ action: 'start', at: 100 });
    expect(nextTransitionFor(booking, { auto_complete: true })).toEqual({
      action: 'complete',
      at: 200,
    });
    expect(
      nextTransitionFor({ ...booking, status: 'cancelled' }, { auto_complete: true }),
    ).toBeNull();
    expect(nextTransitionFor(booking, null)).toBeNull();
  });
});
