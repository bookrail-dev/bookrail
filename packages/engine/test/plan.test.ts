/**
 * The plan counter and the free plan's refusal, against a real Postgres, through the
 * application role, with every instant injected.
 *
 * Each test gets an account of its own, because the counter is the account's and a test that
 * shared one with the next would be measuring the order the tests ran in. The threshold is
 * lowered through the plan table the engine accepts for exactly this, from a thousand bookings
 * to three: the arithmetic is the same and a test does not have to write a thousand rows to
 * reach it.
 *
 * The fixtures live in 2031, like the rest of this package: the write path refuses a start in
 * the past.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from '@bookrail/db';
import { PLANS, type PlanTable } from '@bookrail/shared';

import {
  accountPosition,
  accountUsage,
  lockPlanForBooking,
  createBooking,
  createHold,
  recordPlanUsage,
  transition,
  type TransitionAction,
} from '../src/index.js';
import { createHarness, utc, DAY, HOUR, type Harness } from './availability-harness.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Monday 2 June 2031. Rome is on CEST, so 09:00 local is 07:00Z. */
const MONDAY = utc(2031, 6, 2);
const NINE = MONDAY + 7 * HOUR;
/** A week before, in May: the month the counter moves in. */
const NOW = MONDAY - 7 * DAY;
const MAY = '2031-05';

/** Three bookings and one hundred euro a month on the free plan; three bookings on pro. */
const SMALL: PlanTable = {
  ...PLANS,
  free: { ...PLANS.free, bookingsIncluded: 3, paymentVolumeIncluded: 10_000 },
  pro: { ...PLANS.pro, bookingsIncluded: 3 },
};

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

interface Setup {
  h: Harness;
  serviceId: string;
  resourceId: string;
}

async function setup(
  options: {
    environment?: 'test' | 'live';
    plan?: 'free' | 'pro';
    requiresConfirmation?: boolean;
    price?: number;
    ownerEmail?: string;
  } = {},
): Promise<Setup> {
  const h = await createHarness('Plan', { environment: options.environment ?? 'live' });
  open.push(h);
  await h.admin.execute(sql`
    UPDATE accounts SET plan = ${options.plan ?? 'free'}, owner_email = ${options.ownerEmail ?? null}
     WHERE id = ${h.accountId}
  `);
  const schedule = await h.schedule({
    timezone: 'Europe/Rome',
    rules: [{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '00:00' }],
  });
  const resourceId = await h.resource({ name: 'Court', capacity: 1, scheduleId: schedule });
  const policyId =
    options.requiresConfirmation === true ? await h.policy({ requiresConfirmation: true }) : null;
  const serviceId = await h.service({
    durationMinutes: 60,
    policyId,
    price: options.price === undefined ? null : { amount: options.price, currency: 'EUR' },
  });
  await h.requirement({ serviceId, resourceId });
  return { h, serviceId, resourceId };
}

function book(
  s: Setup,
  hour: number,
  extra: Partial<Parameters<typeof createBooking>[1]> = {},
): ReturnType<typeof createBooking> {
  return createBooking(s.h.app, {
    projectId: s.h.projectId,
    environment: s.h.environment,
    serviceId: s.serviceId,
    start: NINE + hour * HOUR,
    kind: 'booking',
    now: NOW,
    plans: SMALL,
    ...extra,
  });
}

function move(
  s: Setup,
  bookingId: string,
  action: TransitionAction,
  extra: Record<string, unknown> = {},
): ReturnType<typeof transition> {
  return transition(s.h.app, {
    projectId: s.h.projectId,
    environment: s.h.environment,
    bookingId,
    action,
    actor: { type: 'api', id: 'key_test' },
    now: NOW,
    plans: SMALL,
    ...extra,
  });
}

async function usageRows(
  h: Harness,
): Promise<
  { month: string; bookings_confirmed: number; payment_volume: string; currency: string | null }[]
> {
  const result = await h.admin.execute<{
    month: string;
    bookings_confirmed: number;
    payment_volume: string;
    currency: string | null;
  }>(sql`
    SELECT month, bookings_confirmed, payment_volume::text AS payment_volume, currency
      FROM plan_usage WHERE project_id = ${h.projectId} ORDER BY month
  `);
  return result.rows;
}

async function counted(h: Harness, month = MAY): Promise<number> {
  const rows = await usageRows(h);
  return rows.find((row) => row.month === month)?.bookings_confirmed ?? 0;
}

async function warningEvents(h: Harness): Promise<Record<string, unknown>[]> {
  const result = await h.admin.execute<{ data: Record<string, unknown> }>(sql`
    SELECT data FROM events
     WHERE project_id = ${h.projectId} AND type = 'plan.usage_warning' ORDER BY seq
  `);
  return result.rows.map((row) => row.data);
}

describe('counting confirmed live bookings', () => {
  it('counts a booking born confirmed once, in the UTC month of the instant it was made', async () => {
    const s = await setup();
    const created = await book(s, 0);
    expect(created.status).toBe('confirmed');
    expect(await usageRows(s.h)).toEqual([
      { month: MAY, bookings_confirmed: 1, payment_volume: '0', currency: null },
    ]);
  });

  it('counts a pending booking when it is confirmed, and only then, and only once', async () => {
    const s = await setup({ requiresConfirmation: true });
    const created = await book(s, 0);
    expect(created.status).toBe('pending');
    expect(await counted(s.h)).toBe(0);

    await move(s, created.id, 'confirm');
    expect(await counted(s.h)).toBe(1);
    // A second confirm is not a transition at all.
    await expect(move(s, created.id, 'confirm')).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await counted(s.h)).toBe(1);
  });

  it('does not count a cancellation, a no-show, a check-in or a completion again', async () => {
    const s = await setup();
    const a = await book(s, 0);
    const b = await book(s, 2);
    expect(await counted(s.h)).toBe(2);
    await move(s, a.id, 'cancel');
    await move(s, b.id, 'no_show', { now: NINE + 3 * HOUR });
    const c = await book(s, 4);
    await move(s, c.id, 'check_in');
    await move(s, c.id, 'complete', { now: NINE + 5 * HOUR });
    expect(await counted(s.h)).toBe(3);
  });

  it('does not count a reschedule of a confirmed booking, however many times it moves', async () => {
    const s = await setup();
    const created = await book(s, 0);
    const once = await move(s, created.id, 'reschedule', { start: NINE + 2 * HOUR });
    const twice = await move(s, once.newBookingId!, 'reschedule', { start: NINE + 4 * HOUR });
    expect(twice.status).toBe('rescheduled');
    expect(await counted(s.h)).toBe(1);
  });

  it('counts a rescheduled pending booking once, when the chain is first confirmed', async () => {
    const s = await setup({ requiresConfirmation: true });
    const created = await book(s, 0);
    const moved = await move(s, created.id, 'reschedule', { start: NINE + 2 * HOUR });
    expect(await counted(s.h)).toBe(0);
    await move(s, moved.newBookingId!, 'confirm');
    expect(await counted(s.h)).toBe(1);
  });

  it('counts a hold only when it is converted into a confirmed booking', async () => {
    const s = await setup();
    const hold = await createHold(s.h.app, {
      projectId: s.h.projectId,
      environment: 'live',
      serviceId: s.serviceId,
      start: NINE,
      now: NOW,
      plans: SMALL,
    });
    expect(await counted(s.h)).toBe(0);
    await book(s, 0, { holdId: hold.id });
    expect(await counted(s.h)).toBe(1);
  });

  it('never counts in the test environment, and writes nothing there at all', async () => {
    const s = await setup({ environment: 'test' });
    const a = await book(s, 0);
    await book(s, 2);
    await move(s, a.id, 'cancel');
    const warnings = await s.h.app.transaction((tx) =>
      recordPlanUsage(tx, {
        projectId: s.h.projectId,
        environment: 'test',
        now: NOW,
        bookings: 5,
        paymentVolume: 100,
      }),
    );
    expect(warnings).toEqual([]);
    expect(await usageRows(s.h)).toEqual([]);
    // Nor refuses: three bookings is the threshold of the free plan above, and a fourth goes in.
    await book(s, 4);
    await book(s, 6);
  });

  it('starts every UTC month from zero', async () => {
    const s = await setup();
    for (const hour of [0, 2, 4]) await book(s, hour);
    await expect(book(s, 6)).rejects.toMatchObject({ code: 'plan_limit_reached' });

    // The first instant of June, UTC: a new row, and room again.
    const june = utc(2031, 6, 1);
    await book(s, 6, { now: june });
    expect(await usageRows(s.h)).toEqual([
      { month: MAY, bookings_confirmed: 3, payment_volume: '0', currency: null },
      { month: '2031-06', bookings_confirmed: 1, payment_volume: '0', currency: null },
    ]);
  });
});

describe('the free plan at its threshold', () => {
  it('refuses the next live booking with 402 plan_limit_reached, and takes nothing', async () => {
    const s = await setup();
    for (const hour of [0, 2, 4]) await book(s, hour);

    const refusal = await book(s, 6).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      type: 'payment_required',
      code: 'plan_limit_reached',
      status: 402,
      param: undefined,
    });
    expect((refusal as Error).message).toContain('includes 3 confirmed live bookings a month');
    expect((refusal as { fix?: string }).fix).toContain(
      'https://bookrail.dev/dashboard/?upgrade=pro',
    );

    // Nothing was written: the slot is still free, and a hold on it goes through.
    const occupancies = await s.h.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM occupancies
       WHERE resource_id = ${s.resourceId} AND active
         AND period && tstzrange(${new Date(NINE + 6 * HOUR).toISOString()}::timestamptz,
                                 ${new Date(NINE + 7 * HOUR).toISOString()}::timestamptz)
    `);
    expect(occupancies.rows[0]?.n).toBe('0');
    const hold = await createHold(s.h.app, {
      projectId: s.h.projectId,
      environment: 'live',
      serviceId: s.serviceId,
      start: NINE + 6 * HOUR,
      now: NOW,
      plans: SMALL,
    });
    expect(hold.status).toBe('active');
    // And converting it is a booking, which the plan refuses too.
    await expect(book(s, 6, { holdId: hold.id })).rejects.toMatchObject({
      code: 'plan_limit_reached',
    });
    expect(await counted(s.h)).toBe(3);
  });

  /**
   * The case the review found: a policy that asks for confirmation makes every booking `pending`,
   * and a check that looked only at confirmed bookings let an account create any number of them.
   * The check adds the open `pending` bookings, so the fourth creation on a threshold of three is
   * refused before any confirmation has happened.
   */
  it('counts open pending bookings against the threshold, so confirmation cannot be used to go past it', async () => {
    const s = await setup({ requiresConfirmation: true });
    const pending = [await book(s, 0), await book(s, 2), await book(s, 4)];
    expect(pending.every((created) => created.status === 'pending')).toBe(true);
    expect(await counted(s.h)).toBe(0);
    const refusal = await book(s, 6).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'plan_limit_reached', param: undefined });
    expect((refusal as Error).message).toContain('0 confirmed this month and 3 pending');

    // Confirming them does not block (each already took its place when it was created) and counts
    // each once; the account is then at its threshold with nothing pending, and still refused.
    for (const created of pending) {
      expect((await move(s, created.id, 'confirm')).status).toBe('confirmed');
    }
    expect(await counted(s.h)).toBe(3);
    await expect(book(s, 6)).rejects.toMatchObject({ code: 'plan_limit_reached' });
  });

  /**
   * The two numbers of the check are one snapshot. A confirmation moves a booking from `pending`
   * to the counter in one commit and takes no account lock; if the check read the two numbers in
   * two statements, a confirmation committed between them would be in neither. The seam
   * `afterRead` of the check runs a real confirmation, from another connection, right after the
   * read: with one statement the numbers were taken before it and add up to three; with two
   * statements (checked by putting them back) the confirmation falls between them and the sum is
   * two, and this test fails.
   */
  it('reads the counter and the pending bookings in one snapshot', async () => {
    const s = await setup({ requiresConfirmation: true });
    const first = await book(s, 0);
    const second = await book(s, 2);
    const third = await book(s, 4);
    await move(s, first.id, 'confirm');
    // One confirmed and two pending: three, which is the threshold, so the check must refuse.
    let read: { confirmed: number; pending: number } | null = null;
    const refusal = await s.h.app
      .transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${s.h.projectId}, true), set_config('app.environment', 'live', true)`,
        );
        const position = await accountPosition(tx, s.h.accountId, MAY, async () => {
          // Another connection, another transaction, committed right after the read.
          await move(s, second.id, 'confirm');
        });
        read = {
          confirmed: position.usage.bookingsConfirmed,
          pending: position.reserved.bookingsPending,
        };
        // And the check itself, with the same seam, on the next confirmation.
        return lockPlanForBooking(tx, {
          projectId: s.h.projectId,
          environment: 'live',
          now: NOW,
          plans: SMALL,
          afterRead: async () => {
            await move(s, third.id, 'confirm');
          },
        });
      })
      .catch((error: unknown) => error);
    expect(read).toEqual({ confirmed: 1, pending: 2 });
    expect(refusal).toMatchObject({ code: 'plan_limit_reached' });
    // Both confirmations did happen.
    expect(await counted(s.h)).toBe(3);
  });

  it('gives the place of a pending booking back when it is cancelled', async () => {
    const s = await setup({ requiresConfirmation: true });
    const first = await book(s, 0);
    await book(s, 2);
    await book(s, 4);
    await expect(book(s, 6)).rejects.toMatchObject({ code: 'plan_limit_reached' });
    await move(s, first.id, 'cancel');
    const again = await book(s, 6);
    expect(again.status).toBe('pending');
    expect(await counted(s.h)).toBe(0);
  });

  it('does not refuse a reschedule, which is not a new booking', async () => {
    const s = await setup();
    const first = await book(s, 0);
    await book(s, 2);
    await book(s, 4);
    const moved = await move(s, first.id, 'reschedule', { start: NINE + 8 * HOUR });
    expect(moved.newBookingId).not.toBeNull();
    expect(await counted(s.h)).toBe(3);
  });

  it('refuses a payment that would take the month past the included volume', async () => {
    const s = await setup({ price: 6_000 });
    const payment = { mode: 'full' as const, providerAccountId: 'acct_plan', timeoutMs: 1_800_000 };
    await book(s, 0, { payment });
    // The money arrives, as the payment webhook records it: in one transaction the row becomes
    // `succeeded`, which takes it out of the open payments, and the amount moves into the month's
    // counter. Without the second half nothing would be counted and the booking below would pass.
    await s.h.app.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.project_id', ${s.h.projectId}, true), set_config('app.environment', 'live', true)`,
      );
      await tx.execute(sql`UPDATE payments SET status = 'succeeded'`);
      await recordPlanUsage(tx, {
        projectId: s.h.projectId,
        environment: 'live',
        now: NOW,
        paymentVolume: 6_000,
        currency: 'EUR',
      });
    });
    // 60 + 60 is more than the 100 euro of this table.
    const refusal = await book(s, 2, { payment }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'plan_limit_reached', param: 'payment.mode' });
    expect((refusal as Error).message).toContain('100.00 of paid volume a month');
    // A booking that takes no money is not about the volume.
    await book(s, 2);
  });

  /**
   * Deposits in flight: nothing has been paid yet, and two open payments that together go past
   * the included volume cannot both be created, because the second one finds the first in the
   * sum. Before the open payments were in the sum, both passed.
   */
  it('counts open payments against the included volume', async () => {
    const s = await setup({ price: 6_000 });
    const payment = { mode: 'full' as const, providerAccountId: 'acct_plan', timeoutMs: 1_800_000 };
    await book(s, 0, { payment });
    const refusal = await book(s, 2, { payment }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'plan_limit_reached', param: 'payment.mode' });
    expect((refusal as Error).message).toContain('60.00 of it in payments still open');
    expect(await usageRows(s.h)).toEqual([]);
  });

  it('adds a payment in a second currency and says mixed', async () => {
    const s = await setup();
    const add = (volume: number, currency: string): Promise<unknown> =>
      s.h.app.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${s.h.projectId}, true), set_config('app.environment', 'live', true)`,
        );
        return recordPlanUsage(tx, {
          projectId: s.h.projectId,
          environment: 'live',
          now: NOW,
          paymentVolume: volume,
          currency,
        });
      });
    await add(1_000, 'EUR');
    await add(500, 'eur');
    expect((await usageRows(s.h))[0]?.currency).toBe('EUR');
    await add(2_000, 'USD');
    expect(await usageRows(s.h)).toEqual([
      { month: MAY, bookings_confirmed: 0, payment_volume: '3500', currency: 'mixed' },
    ]);
    await add(100, 'EUR');
    expect((await usageRows(s.h))[0]?.currency).toBe('mixed');
  });

  it('does not refuse a pro account at the same count', async () => {
    const s = await setup({ plan: 'pro' });
    for (const hour of [0, 2, 4, 6, 8]) await book(s, hour);
    expect(await counted(s.h)).toBe(5);
  });

  it('shares one threshold between two projects of the same account', async () => {
    const first = await setup();
    const second = await setup();
    await first.h.admin.execute(
      sql`UPDATE projects SET account_id = ${first.h.accountId} WHERE id = ${second.h.projectId}`,
    );
    await book(first, 0);
    await book(second, 0);
    await book(first, 2);
    await expect(book(second, 2)).rejects.toMatchObject({ code: 'plan_limit_reached' });

    const total = await second.h.app.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.project_id', ${second.h.projectId}, true), set_config('app.environment', 'live', true)`,
      );
      return accountUsage(tx, first.h.accountId, MAY);
    });
    expect(total.bookingsConfirmed).toBe(3);
  });
});

describe('the usage warnings', () => {
  const FIVE: PlanTable = {
    ...PLANS,
    free: { ...PLANS.free, bookingsIncluded: 5 },
    pro: { ...PLANS.pro, bookingsIncluded: 5 },
  };

  it('claims 80 % and 100 % once each, with an event in the same transaction', async () => {
    const s = await setup({ plan: 'pro', ownerEmail: 'owner@example.com' });
    const warnings: string[] = [];
    for (const hour of [0, 2, 4, 6, 8, 10, 12]) {
      const created = await book(s, hour, { plans: FIVE });
      for (const warning of created.planWarnings) {
        warnings.push(`${String(warning.threshold)}@${String(warning.bookingsConfirmed)}`);
        expect(warning.ownerEmail).toBe('owner@example.com');
        expect(warning.bookingsIncluded).toBe(5);
      }
    }
    // Four of five is 80 %; five of five is 100 %; the sixth and seventh are past both.
    expect(warnings).toEqual(['80@4', '100@5']);

    const events = await warningEvents(s.h);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      object: 'plan_usage',
      plan: 'pro',
      month: MAY,
      threshold: 80,
      bookings_confirmed: 4,
      bookings_included: 5,
      payment_volume: 0,
      payment_volume_included: null,
    });
    expect(String(events[0]?.account_id)).toMatch(/^acct_/);
    expect(events[1]).toMatchObject({ threshold: 100, bookings_confirmed: 5 });
  });

  it('warns at the confirmation of a pending booking as well', async () => {
    const s = await setup({ plan: 'pro', requiresConfirmation: true });
    const created = [];
    for (const hour of [0, 2, 4, 6]) created.push(await book(s, hour, { plans: FIVE }));
    const results = [];
    for (const booking of created)
      results.push(await move(s, booking.id, 'confirm', { plans: FIVE }));
    expect(results.map((result) => result.planWarnings.map((w) => w.threshold))).toEqual([
      [],
      [],
      [],
      [80],
    ]);
    // No owner address on this account: the event is the whole warning.
    expect(results[3]?.planWarnings[0]?.ownerEmail).toBeNull();
    expect(await warningEvents(s.h)).toHaveLength(1);
  });

  it('warns nobody in the test environment', async () => {
    const s = await setup({ environment: 'test' });
    for (const hour of [0, 2, 4, 6, 8]) {
      const created = await book(s, hour, { plans: FIVE });
      expect(created.planWarnings).toEqual([]);
    }
    expect(await warningEvents(s.h)).toEqual([]);
  });
});
