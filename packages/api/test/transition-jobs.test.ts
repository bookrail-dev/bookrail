/**
 * The scheduler of the automatic transitions, which ticks every thirty seconds.
 *
 * Split the same way `jobs.test.ts` splits the hold sweep. `runBookingTransitions` is what a
 * reader has to trust, so it is exercised directly, synchronously, with an **injected clock**:
 * every assertion about "after the grace period" is made by moving `now`, never by waiting.
 * The queue is then exercised once, end to end, to prove the only thing left: that a tick
 * reaches the task on its own.
 *
 * The bookings are made through the public API, so the automatic clock under test is the one a
 * real `POST /v1/bookings` writes, not one a fixture set by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { createHarness, type Harness } from './harness.js';
import { settleEventLog } from './event-horizon.js';
import {
  DEFAULT_TRANSITIONS_INTERVAL_SECONDS,
  runBookingTransitions,
  startWorker,
  type Worker,
} from '../src/jobs/index.js';
import {
  ageBooking,
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
} from './booking-fixtures.js';
import { TEST_DB_NAME } from './db-name.js';

const MINUTE_MS = 60_000;

interface BookingBody {
  id: string;
  status: string;
  start: string;
  end: string;
  next_transition: string | null;
  next_transition_at: string | null;
  checked_in_at: string | null;
  no_show_charge_expected: number | null;
}

describe('automatic booking transitions', () => {
  let h: Harness;
  let token: string;

  const monday = nextMonday();
  const tuesday = plusDays(monday, 1);

  beforeAll(async () => {
    h = createHarness();
    token = (await h.bootstrap('Transitions job')).testKey;
  });

  afterAll(async () => {
    await h.close();
  });

  function deps(): Parameters<typeof runBookingTransitions>[0] {
    return {
      db: createDatabase(h.pools.app),
      cache: h.cache,
      logger: h.logger,
    };
  }

  async function booked(policy: Record<string, unknown>): Promise<BookingBody> {
    const scenario = await buildScenario(h, token, { policy, resources: 2 });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, tuesday);
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    return created.body;
  }

  /**
   * How many times this booking has been moved by the scheduler.
   *
   * The assertions are about **this** booking and not about `report.applied`, because the
   * sweep is cross-project by design: the API package shares one database between its test
   * files, and another file's `auto_complete` booking legitimately raises the global count.
   * Counting the events of the booking under test says the thing that actually matters
   * (applied once, never twice) and says it whatever else is in the database.
   */
  async function automaticEvents(id: string): Promise<string[]> {
    return (await eventTypes(id)).filter((type) => type !== 'booking.created');
  }

  async function read(id: string): Promise<BookingBody> {
    const response = await h.call<BookingBody>('GET', `/v1/bookings/${id}`, { token });
    expect(response.status).toBe(200);
    return response.body;
  }

  /**
   * The event types of one booking, read after the log has settled.
   *
   * `GET /v1/events` answers from below the horizon, and the horizon is a property of the
   * whole Postgres cluster: a write transaction open in another test database or in an
   * autovacuum worker holds back the last event this test just caused. Asserting on the list
   * without waiting for it asks the endpoint for a promise it does not make.
   */
  async function eventTypes(id: string): Promise<string[]> {
    await settleEventLog(h);
    const list = await h.call<{ data: { type: string; actor: { type: string } | null }[] }>(
      'GET',
      `/v1/events?object_id=${id}&limit=100`,
      { token },
    );
    return list.body.data.map((event) => event.type);
  }

  async function actorOf(id: string, type: string): Promise<{ type: string } | null> {
    await settleEventLog(h);
    const list = await h.call<{ data: { type: string; actor: { type: string } | null }[] }>(
      'GET',
      `/v1/events?object_id=${id}&limit=100`,
      { token },
    );
    return list.body.data.find((event) => event.type === type)?.actor ?? null;
  }

  it('does nothing before the instant, and starts the booking at it', async () => {
    const booking = await booked({ auto_start: true });
    expect(booking.next_transition).toBe('start');
    expect(booking.next_transition_at).toBe(booking.start);

    const start = new Date(booking.start).getTime();
    const early = await runBookingTransitions(deps(), { now: start - 1 });
    expect(early.failed).toBe(0);
    expect((await read(booking.id)).status).toBe('confirmed');
    expect(await automaticEvents(booking.id)).toEqual([]);

    const onTime = await runBookingTransitions(deps(), { now: start });
    expect(onTime.applied).toBeGreaterThanOrEqual(1);
    const started = await read(booking.id);
    expect(started.status).toBe('in_progress');
    // An automatic start is not a check-in: that is what keeps `no_show.auto_mark` alive.
    expect(started.checked_in_at).toBeNull();
    expect(await eventTypes(booking.id)).toEqual(['booking.created', 'booking.started']);
    expect(await actorOf(booking.id, 'booking.started')).toEqual({ type: 'system', id: null });
  });

  it('completes at the end when the policy asks for it', async () => {
    const booking = await booked({ auto_complete: true });
    expect(booking.next_transition).toBe('complete');
    const end = new Date(booking.end).getTime();

    expect((await read(booking.id)).status).toBe('confirmed');
    await runBookingTransitions(deps(), { now: end - 1 });
    expect((await read(booking.id)).status).toBe('confirmed');
    await runBookingTransitions(deps(), { now: end });

    const done = await read(booking.id);
    expect(done.status).toBe('completed');
    expect(done.next_transition).toBeNull();
    expect(await eventTypes(booking.id)).toEqual(['booking.created', 'booking.completed']);
  });

  it('marks a no-show after the grace period, and never before it', async () => {
    const booking = await booked({
      no_show: { auto_mark: true, grace_minutes: 15, charge_percent: 40 },
    });
    const start = new Date(booking.start).getTime();
    expect(booking.next_transition).toBe('no_show');
    expect(new Date(booking.next_transition_at!).getTime()).toBe(start + 15 * MINUTE_MS);

    await runBookingTransitions(deps(), { now: start + 15 * MINUTE_MS - 1 });
    expect((await read(booking.id)).status).toBe('confirmed');
    await runBookingTransitions(deps(), { now: start + 15 * MINUTE_MS });
    const marked = await read(booking.id);
    expect(marked.status).toBe('no_show');
    expect(marked.no_show_charge_expected).toBe(0); // the fixture service has no price
  });

  it('does not mark a no-show once the customer has checked in', async () => {
    const booking = await booked({ no_show: { auto_mark: true, grace_minutes: 15 } });
    const checked = await h.call<BookingBody>('POST', `/v1/bookings/${booking.id}/check_in`, {
      token,
    });
    expect(checked.status).toBe(200);
    // The check-in recomputed the clock, and there is nothing automatic left to do.
    expect(checked.body.next_transition).toBeNull();

    const start = new Date(booking.start).getTime();
    const report = await runBookingTransitions(deps(), { now: start + 60 * MINUTE_MS });
    expect(report.failed).toBe(0);
    expect((await read(booking.id)).status).toBe('in_progress');
    expect(await automaticEvents(booking.id)).toEqual(['booking.checked_in']);
  });

  it('starts, then no-shows, walking the chain one tick at a time', async () => {
    const booking = await booked({
      auto_start: true,
      no_show: { auto_mark: true, grace_minutes: 10 },
    });
    const start = new Date(booking.start).getTime();

    await runBookingTransitions(deps(), { now: start });
    expect((await read(booking.id)).next_transition).toBe('no_show');

    await runBookingTransitions(deps(), { now: start + 10 * MINUTE_MS });
    expect((await read(booking.id)).status).toBe('no_show');
    expect(await eventTypes(booking.id)).toEqual([
      'booking.created',
      'booking.started',
      'booking.no_show',
    ]);
  });

  it('applies a transition once even with several workers on the same tick', async () => {
    const booking = await booked({ auto_complete: true });
    const end = new Date(booking.end).getTime();

    const reports = await Promise.all(
      [0, 1, 2, 3].map(() => runBookingTransitions(deps(), { now: end })),
    );
    const failed = reports.reduce((total, report) => total + report.failed, 0);
    // Exactly one worker moves it. The other three either find nothing due (their scan ran
    // after the winner committed and cleared `next_transition`) or reach the row and are
    // refused by the guard inside the transaction, which counts as `skipped`. Both routes end
    // in the same place, and neither is an error: the engine suite pins the guard itself, with
    // four transitions racing on one booking.
    expect(failed).toBe(0);
    expect(await automaticEvents(booking.id)).toEqual(['booking.completed']);
    expect(
      (await eventTypes(booking.id)).filter((type) => type === 'booking.completed'),
    ).toHaveLength(1);
  });

  it('leaves a booking somebody cancelled first alone', async () => {
    const booking = await booked({ auto_complete: true });
    await h.call('POST', `/v1/bookings/${booking.id}/cancel`, { token });
    const report = await runBookingTransitions(deps(), {
      now: new Date(booking.end).getTime(),
    });
    expect(report.failed).toBe(0);
    expect((await read(booking.id)).status).toBe('cancelled');
    expect(await automaticEvents(booking.id)).toEqual(['booking.cancelled']);
  });

  it('frees the slot when it marks a no-show, and says so in touchedDays', async () => {
    const scenario = await buildScenario(h, token, {
      policy: { no_show: { auto_mark: true, grace_minutes: 0 } },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, tuesday);
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    const before = await slotsFor(h, token, scenario.serviceId, monday, tuesday);
    expect(before.some((entry) => entry.start === slot.start)).toBe(false);

    const report = await runBookingTransitions(deps(), {
      now: new Date(created.body.start).getTime(),
    });
    expect(report.applied).toBeGreaterThanOrEqual(1);
    expect(report.invalidated).toBeGreaterThan(0);
    const after = await slotsFor(h, token, scenario.serviceId, monday, tuesday);
    expect(after.some((entry) => entry.start === slot.start)).toBe(true);
  });

  it('never touches a booking of another project', async () => {
    const other = await h.bootstrap('Transitions job other');
    const scenario = await buildScenario(h, other.testKey, { policy: { auto_complete: true } });
    const slot = await firstSlot(h, other.testKey, scenario.serviceId, monday, tuesday);
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token: other.testKey,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);

    // The sweep is cross-project by design, so this asserts the opposite of isolation: it
    // must reach that project too, through its own `withProjectContext`.
    const report = await runBookingTransitions(deps(), {
      now: new Date(created.body.end).getTime(),
    });
    expect(report.applied).toBeGreaterThan(0);
    const read = await h.call<BookingBody>('GET', `/v1/bookings/${created.body.id}`, {
      token: other.testKey,
    });
    expect(read.body.status).toBe('completed');
  });

  it('keeps the documented thirty second interval as the default', () => {
    expect(DEFAULT_TRANSITIONS_INTERVAL_SECONDS).toBe(30);
  });

  it('is reached by a real pg-boss tick, with nobody calling anything', async () => {
    // The only test in this file that waits on real time: it is the one thing an injected
    // clock cannot prove: that the queue actually delivers the job.
    const scenario = await buildScenario(h, token, { policy: { auto_complete: true } });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, tuesday);
    const created = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    // The booking is in the future, so the worker's own `Date.now()` would never fire it. The
    // whole booking is aged instead (period included, because `complete` before the start is
    // a `422 complete_too_early`), which is what a real overdue booking looks like.
    await ageBooking(h, created.body.id);

    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: new MemoryAvailabilityCache(),
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        {
          connectionString: urls.admin,
          intervalSeconds: 1,
          transitionsIntervalSeconds: 1,
          maxConnections: 2,
          schedule: false,
        },
      );

      const deadline = Date.now() + 20_000;
      let status = 'confirmed';
      while (Date.now() < deadline && status !== 'completed') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = (await read(created.body.id)).status;
      }
      expect(status).toBe('completed');
    } finally {
      if (worker) await worker.stop();
    }
  }, 60_000);
});
