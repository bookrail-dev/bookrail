/**
 * `GET /v1/events` and `GET /v1/events/{id}`.
 *
 * The rows are produced the only way they can be (by making bookings and moving them), so
 * these tests also check that the envelope a consumer will parse is the one a webhook delivery
 * carries, on events that were written by the real transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resolveDatabaseUrls } from '@bookrail/db';
import { decodeId } from '@bookrail/shared';
import { createHarness, type Harness } from './harness.js';
import { settleEventLog } from './event-horizon.js';
import { TEST_DB_NAME } from './db-name.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  ageBooking,
  type ErrorBody,
} from './booking-fixtures.js';

interface EventBody {
  id: string;
  object: string;
  type: string;
  occurred_at: string;
  api_version: string;
  seq: number;
  actor: { type: string; id: string | null } | null;
  data: { object: Record<string, unknown>; previous: Record<string, unknown> | null };
  environment: string;
}

interface EventList {
  object: string;
  data: EventBody[];
  has_more: boolean;
}

describe('GET /v1/events', () => {
  let h: Harness;
  let token: string;
  let bookingId: string;
  let serviceId: string;
  let projectId: string;

  const from = nextMonday();
  const to = plusDays(from, 1);

  beforeAll(async () => {
    h = createHarness();
    const project = await h.bootstrap('Events');
    token = project.testKey;
    projectId = project.projectId;
    const scenario = await buildScenario(h, token, { resources: 2 });
    serviceId = scenario.serviceId;
    const slot = await firstSlot(h, token, serviceId, from, to);
    const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
      token,
      body: { service_id: serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    bookingId = created.body.id;
    await h.call('POST', `/v1/bookings/${bookingId}/check_in`, { token });
    // A booking cannot be completed before it starts, so the clock has to have caught up with
    // it: the fixture ages the row, which is the only difference between it and one that has
    // actually happened.
    await ageBooking(h, bookingId);
    await h.call('POST', `/v1/bookings/${bookingId}/complete`, { token });
    // The list answers from below the horizon, and the horizon is a property of the whole
    // Postgres cluster: a write transaction open in another test database, in another
    // package's suite or in an autovacuum worker keeps the three events this fixture just
    // wrote out of every list below until it finishes. The tests state what the list contains,
    // so the fixture is not ready until the list can contain it.
    await settleEventLog(h);
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers with the documented event envelope', async () => {
    const list = await h.call<EventList>('GET', `/v1/events?object_id=${bookingId}`, { token });
    expect(list.status).toBe(200);
    expect(list.body.object).toBe('list');
    const types = list.body.data.map((event) => event.type);
    expect(types).toEqual(['booking.created', 'booking.checked_in', 'booking.completed']);

    const checkedIn = list.body.data[1]!;
    expect(checkedIn.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(checkedIn.object).toBe('event');
    expect(checkedIn.api_version).toBe('2026-09-01');
    expect(checkedIn.environment).toBe('test');
    expect(typeof checkedIn.occurred_at).toBe('string');
    expect(checkedIn.actor).toMatchObject({ type: 'api' });
    expect(checkedIn.actor?.id).toMatch(/^key_[0-9a-f]{32}$/);
    expect(checkedIn.data.object).toMatchObject({
      id: bookingId,
      object: 'booking',
      status: 'in_progress',
    });
    expect(checkedIn.data.previous).toMatchObject({ status: 'confirmed' });

    // A creation has no previous state, and says so with `null` rather than with `{}`.
    expect(list.body.data[0]!.data.previous).toBeNull();
  });

  it('reads one event by id, and 404s on one that is not there', async () => {
    const list = await h.call<EventList>('GET', `/v1/events?object_id=${bookingId}`, { token });
    const wanted = list.body.data[0]!;
    const one = await h.call<EventBody>('GET', `/v1/events/${wanted.id}`, { token });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(wanted);

    const missing = await h.call<ErrorBody>(
      'GET',
      '/v1/events/evt_00000000000000000000000000000000',
      { token },
    );
    expect(missing.status).toBe(404);

    const malformed = await h.call<ErrorBody>('GET', '/v1/events/bk_deadbeef', { token });
    expect(malformed.status).toBe(404);
  });

  it('paginates on seq, in the order the events happened', async () => {
    const page = await h.call<EventList>('GET', '/v1/events?limit=2', { token });
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.has_more).toBe(true);
    expect(page.body.data[1]!.seq).toBeGreaterThan(page.body.data[0]!.seq);

    const next = await h.call<EventList>(
      `GET`,
      `/v1/events?limit=50&starting_after=${page.body.data[1]!.id}`,
      { token },
    );
    expect(next.body.data[0]!.seq).toBeGreaterThan(page.body.data[1]!.seq);
    // No overlap: a cursor is a position, and every row is returned exactly once.
    const seen = new Set(page.body.data.map((event) => event.id));
    expect(next.body.data.some((event) => seen.has(event.id))).toBe(false);
  });

  it('filters by type, by object_id and by occurred_at', async () => {
    const byType = await h.call<EventList>('GET', '/v1/events?type=booking.completed', { token });
    expect(byType.body.data.every((event) => event.type === 'booking.completed')).toBe(true);
    expect(byType.body.data.length).toBeGreaterThan(0);

    const byObject = await h.call<EventList>('GET', `/v1/events?object_id=${bookingId}`, { token });
    expect(byObject.body.data.every((event) => event.data.object.id === bookingId)).toBe(true);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await h.call<EventList>('GET', `/v1/events?from=${future}`, { token });
    expect(none.body.data).toEqual([]);

    const all = await h.call<EventList>('GET', '/v1/events?limit=100', { token });
    const since = await h.call<EventList>(
      'GET',
      `/v1/events?limit=100&from=${new Date(Date.now() - 3_600_000).toISOString()}`,
      { token },
    );
    expect(since.body.data.length).toBe(all.body.data.length);
  });

  it('filters by several types at once, with `type[]` or a repeated `type`', async () => {
    const wanted = ['booking.created', 'booking.completed'];
    const bracketed = await h.call<EventList>(
      'GET',
      `/v1/events?limit=100&${wanted.map((type) => `type[]=${type}`).join('&')}`,
      { token },
    );
    expect(bracketed.status).toBe(200);
    expect(bracketed.body.data.length).toBeGreaterThan(1);
    expect(bracketed.body.data.every((event) => wanted.includes(event.type))).toBe(true);
    // Both types are actually present, so the filter is a union and not the first value.
    expect(new Set(bracketed.body.data.map((event) => event.type))).toEqual(new Set(wanted));

    // The bare repeated spelling, which is what a person types by hand.
    const repeated = await h.call<EventList>(
      'GET',
      `/v1/events?limit=100&${wanted.map((type) => `type=${type}`).join('&')}`,
      { token },
    );
    expect(repeated.body.data.map((event) => event.id)).toEqual(
      bracketed.body.data.map((event) => event.id),
    );

    // One value still behaves exactly as before, in either spelling.
    const single = await h.call<EventList>('GET', '/v1/events?limit=100&type=booking.completed', {
      token,
    });
    const singleBracketed = await h.call<EventList>(
      'GET',
      '/v1/events?limit=100&type[]=booking.completed',
      { token },
    );
    expect(singleBracketed.body.data.map((event) => event.id)).toEqual(
      single.body.data.map((event) => event.id),
    );
    expect(single.body.data.length).toBeLessThan(bracketed.body.data.length);

    // A type nobody ever wrote narrows the union rather than widening it.
    const withUnknown = await h.call<EventList>(
      'GET',
      '/v1/events?limit=100&type[]=booking.completed&type[]=payment.refunded',
      { token },
    );
    expect(withUnknown.body.data.map((event) => event.id)).toEqual(
      single.body.data.map((event) => event.id),
    );

    // The ordering is still `(txid, seq)`: a filtered page is a subsequence of the full one.
    const all = await h.call<EventList>('GET', '/v1/events?limit=100', { token });
    const positions = bracketed.body.data.map((event) =>
      all.body.data.findIndex((row) => row.id === event.id),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('refuses an empty or oversized `type[]`', async () => {
    const empty = await h.call<ErrorBody>('GET', '/v1/events?type[]=', { token });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('parameter_invalid');

    const many = Array.from({ length: 51 }, (_, i) => `type[]=booking.x${String(i)}`).join('&');
    const tooMany = await h.call<ErrorBody>('GET', `/v1/events?${many}`, { token });
    expect(tooMany.status).toBe(400);
  });

  it('refuses a malformed cursor, a bad limit and an unparseable instant', async () => {
    // An unknown query parameter is ignored, exactly as `GET /v1/bookings` ignores one: the
    // list schemas of this API are not `.strict()`, because `limit` and `starting_after` are
    // read by `parseListParams` and would be unknown to every one of them.
    expect((await h.call('GET', '/v1/events?nope=1', { token })).status).toBe(200);

    const badLimit = await h.call<ErrorBody>('GET', '/v1/events?limit=0', { token });
    expect(badLimit.status).toBe(400);
    const badInstant = await h.call<ErrorBody>('GET', '/v1/events?from=yesterday', { token });
    expect(badInstant.status).toBe(400);

    const cursor = await h.call<ErrorBody>('GET', '/v1/events?starting_after=bk_ff', { token });
    expect(cursor.status).toBe(400);
    expect(cursor.body.error.param).toBe('starting_after');
  });

  it('shows a project only its own events, and test only its own environment', async () => {
    const other = await h.bootstrap('Events other');
    const foreign = await h.call<EventList>('GET', '/v1/events?limit=100', {
      token: other.testKey,
    });
    expect(foreign.body.data).toEqual([]);

    // The live key of the same project sees nothing either: the events above are all `test`.
    const live = (await h.bootstrap('Events live')).liveKey;
    const liveList = await h.call<EventList>('GET', '/v1/events?limit=100', { token: live });
    expect(liveList.body.data).toEqual([]);
  });

  it('is read only: there is no way to write, amend or delete an event', async () => {
    const list = await h.call<EventList>('GET', '/v1/events?limit=1', { token });
    const id = list.body.data[0]!.id;
    for (const [method, path] of [
      ['POST', '/v1/events'],
      ['PATCH', `/v1/events/${id}`],
      ['DELETE', `/v1/events/${id}`],
    ] as const) {
      const response = await h.call<ErrorBody>(method, path, { token, body: {} });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_endpoint');
    }
  });

  it('never lets the cursor step over an event that commits late', async () => {
    // The scenario of the review. `seq` is handed out at the INSERT and not at the
    // COMMIT, so two transactions committing in the opposite order leave a hole. Without the
    // horizon a reader would page past the slow one and never come back to it.
    const adminUrl = resolveDatabaseUrls({ databaseName: TEST_DB_NAME }).app;
    const slow = new Client({ connectionString: adminUrl });
    const fast = new Client({ connectionString: adminUrl });
    const bare = decodeId('project', projectId) ?? projectId;
    await slow.connect();
    await fast.connect();
    try {
      const insert = async (client: Client, type: string): Promise<void> => {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.project_id', $1, true),
                                   set_config('app.environment', 'test', true)`,
          [bare],
        );
        await client.query(
          `INSERT INTO events (id, project_id, environment, type, data)
           VALUES (gen_random_uuid(), $1, 'test', $2, '{"id":"cursor_probe"}'::jsonb)`,
          [bare, type],
        );
      };

      // The slow transaction takes the lower `seq` and does not commit; the fast one takes the
      // higher and commits immediately.
      await insert(slow, 'review.slow');
      await insert(fast, 'review.fast');
      await fast.query('COMMIT');

      const during = await h.call<EventList>('GET', '/v1/events?object_id=cursor_probe', {
        token,
      });
      // `review.fast` is committed and visible to plain MVCC, and the horizon holds it back
      // anyway: returning it would move a cursor past a `seq` that is still unwritten.
      expect(during.body.data).toEqual([]);

      await slow.query('COMMIT');
      // Both are committed now, and both become listable when the horizon passes them, which
      // is the whole claim of this test. Nothing here is settled before `during`: that
      // assertion is about an event the horizon is deliberately holding back.
      await settleEventLog(h);

      const after = await h.call<EventList>('GET', '/v1/events?object_id=cursor_probe', {
        token,
      });
      expect(after.body.data.map((event) => event.type)).toEqual(['review.slow', 'review.fast']);

      // And paging through them one at a time reaches both, in that order, with no gap.
      const first = await h.call<EventList>('GET', '/v1/events?object_id=cursor_probe&limit=1', {
        token,
      });
      expect(first.body.data.map((e) => e.type)).toEqual(['review.slow']);
      expect(first.body.has_more).toBe(true);
      const second = await h.call<EventList>(
        'GET',
        `/v1/events?object_id=cursor_probe&limit=1&starting_after=${first.body.data[0]!.id}`,
        { token },
      );
      expect(second.body.data.map((e) => e.type)).toEqual(['review.fast']);
    } finally {
      await slow.query('ROLLBACK').catch(() => undefined);
      await fast.query('ROLLBACK').catch(() => undefined);
      await slow.end();
      await fast.end();
    }
  });

  it('answers a direct lookup even for an event still behind the horizon', async () => {
    // The horizon protects a **cursor**; a lookup by id has no cursor to step over, and
    // refusing it would be a promise about ordering answered with a 404.
    const list = await h.call<EventList>('GET', '/v1/events?limit=1', { token });
    const one = await h.call<EventBody>('GET', `/v1/events/${list.body.data[0]!.id}`, { token });
    expect(one.status).toBe(200);
  });

  it('records a cancellation with its actor, its reason and its previous state', async () => {
    const slots = await slotsFor(h, token, serviceId, from, to);
    const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
      token,
      body: { service_id: serviceId, start: slots[0]!.start },
    });
    const id = created.body.id;
    await h.call('POST', `/v1/bookings/${id}/cancel`, {
      token,
      body: { reason: 'rain', by: 'provider' },
    });
    await settleEventLog(h);

    const list = await h.call<EventList>('GET', `/v1/events?object_id=${id}`, { token });
    const cancelled = list.body.data.find((event) => event.type === 'booking.cancelled')!;
    expect(cancelled.data.object).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'provider',
      cancellation_reason: 'rain',
      refund_percent: 100,
    });
    expect(cancelled.data.previous).toMatchObject({
      status: 'confirmed',
      cancelled_by: null,
      refund_percent: null,
    });
  });
});
