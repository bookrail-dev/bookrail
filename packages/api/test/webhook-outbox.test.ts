/**
 * The outbox: events become deliveries exactly once, and no event is ever stepped over.
 *
 * The two tests that matter here are the last two. One reproduces the scenario that broke the
 * first cursor: two transactions insert an event each and commit in the
 * opposite order, leaving a hole a `seq` cursor would pass and never return to. The other
 * interrupts the job between the inserts and the cursor advance, and between the cursor advance
 * and the next tick, and checks that neither leaves an event lost or an endpoint called twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createDatabase, resolveDatabaseUrls, sql, withProjectContext } from '@bookrail/db';
import { decodeId } from '@bookrail/shared';
import { createHarness, type Harness } from './harness.js';
import { TEST_DB_NAME } from './db-name.js';
import { startReceiver, type TestReceiver } from './webhook-receiver.js';
import { quiesceWebhooks } from './webhook-fixtures.js';
import { settleEventLog } from './event-horizon.js';
import { runWebhookOutbox } from '../src/webhooks/outbox.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type Scenario,
} from './booking-fixtures.js';

interface WebhookBody {
  id: string;
  events: string[];
  status: string;
  secret?: string;
}

interface DeliveryBody {
  id: string;
  event_id: string;
  event_type?: string | null;
  status: string;
  attempt: number;
}

interface ListBody<T> {
  data: T[];
  has_more: boolean;
}

describe('webhook outbox', () => {
  let h: Harness;
  let token: string;
  let projectId: string;
  let bareProjectId: string;
  let receiver: TestReceiver;
  let scenario: Scenario;
  const monday = nextMonday();

  const outboxWithoutSettling = async (
    options: Parameters<typeof runWebhookOutbox>[1] = {},
  ): ReturnType<typeof runWebhookOutbox> =>
    runWebhookOutbox(
      {
        db: createDatabase(h.pools.app),
        logger: h.logger,
      },
      options,
    );

  /**
   * One tick, over a log that has settled.
   *
   * Every test below except the late commit one writes its events and then expects this tick
   * to have converted them, and that holds only once the horizon has passed them. The horizon
   * is a property of the whole Postgres cluster, so a write transaction open in another test
   * database, in another package's suite, or in an autovacuum worker leaves the tail of the
   * log unconverted and the test short of a delivery it has every right to expect. The late
   * commit test is the exception on purpose: its subject **is** an event held behind the
   * horizon, so it calls `outboxWithoutSettling` and asserts that the tick converts nothing.
   */
  const outbox = async (
    options: Parameters<typeof runWebhookOutbox>[1] = {},
  ): ReturnType<typeof runWebhookOutbox> => {
    await settleEventLog(h);
    return outboxWithoutSettling(options);
  };

  const createWebhook = async (events?: string[]): Promise<WebhookBody> => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url, ...(events === undefined ? {} : { events }) },
    });
    expect(created.status).toBe(201);
    return created.body;
  };

  const deliveriesOf = async (webhookId: string): Promise<DeliveryBody[]> => {
    const list = await h.call<ListBody<DeliveryBody>>(
      'GET',
      `/v1/webhooks/${webhookId}/deliveries?limit=100`,
      { token },
    );
    expect(list.status).toBe(200);
    return list.body.data;
  };

  const cursor = async (): Promise<{ last_txid: string; last_seq: string } | undefined> => {
    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ last_txid: string; last_seq: string }>(sql`
      SELECT last_txid::text AS last_txid, last_seq::text AS last_seq
        FROM outbox_cursor WHERE project_id = ${bareProjectId} AND environment = 'test'
    `);
    return rows[0];
  };

  const rewindCursor = async (txid: string, seq: string): Promise<void> => {
    const adminDb = createDatabase(h.pools.admin);
    await adminDb.execute(sql`
      UPDATE outbox_cursor SET last_txid = ${txid}::xid8, last_seq = ${seq}::bigint
       WHERE project_id = ${bareProjectId} AND environment = 'test'
    `);
  };

  /**
   * Books a slot and returns the booking id. Every booking writes a `booking.created`, which is
   * the only honest way to get an event into the log: written by the real transaction, in the
   * real shape a consumer will parse.
   */
  const book = async (): Promise<string> => {
    for (let day = 0; day < 7; day += 1) {
      const from = plusDays(monday, day);
      const slots = await slotsFor(h, token, scenario.serviceId, from, plusDays(from, 1));
      for (const slot of slots) {
        const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
          token,
          body: { service_id: scenario.serviceId, start: slot.start },
        });
        if (created.status === 201) return created.body.id;
      }
    }
    throw new Error('no bookable slot left in the fixture');
  };

  beforeAll(async () => {
    h = createHarness({ allowPrivateWebhookTargets: true });
    const project = await h.bootstrap('Webhook outbox');
    token = project.testKey;
    projectId = project.projectId;
    bareProjectId = decodeId('project', projectId) ?? projectId;
    receiver = await startReceiver();
    scenario = await buildScenario(h, token, { resources: 4, capacity: 4 });
    // The events written before any endpoint exists are what the "no history" test needs.
    await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
  });

  afterAll(async () => {
    // The database is shared with the suites that start a real worker; leave it quiet.
    await quiesceWebhooks(h);
    await receiver.close();
    await h.close();
  });

  it('creates one delivery per subscribing endpoint, and none for the others', async () => {
    const everything = await createWebhook(['*']);
    const cancellations = await createWebhook(['booking.cancelled']);
    const disabled = await createWebhook(['*']);
    await h.call('PATCH', `/v1/webhooks/${disabled.id}`, { token, body: { status: 'disabled' } });

    const bookingId = await book();
    await h.call('POST', `/v1/bookings/${bookingId}/cancel`, { token, body: { reason: 'test' } });

    await outbox();

    const all = await deliveriesOf(everything.id);
    const types = all.map((d) => d.event_type);
    expect(types).toContain('booking.created');
    expect(types).toContain('booking.cancelled');

    const only = await deliveriesOf(cancellations.id);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((d) => d.event_type === 'booking.cancelled')).toBe(true);

    expect(await deliveriesOf(disabled.id)).toEqual([]);
  });

  it('does not send an endpoint the history that predates it', async () => {
    const bookingId = await book();
    await outbox();
    const late = await createWebhook(['*']);
    await outbox();
    const delivered = await deliveriesOf(late.id);
    expect(delivered.every((d) => d.event_id !== bookingId)).toBe(true);
    // Concretely: nothing at all, because the only events so far are older than the endpoint.
    expect(delivered).toEqual([]);
  });

  it('keeps queueing for a failing endpoint, and stops for a disabled one', async () => {
    const failing = await createWebhook(['*']);
    const adminDb = createDatabase(h.pools.admin);
    await adminDb.execute(sql`
      UPDATE webhooks SET status = 'failing' WHERE id = ${decodeId('webhook', failing.id)}
    `);
    await book();
    await outbox();
    expect((await deliveriesOf(failing.id)).length).toBeGreaterThan(0);

    const before = (await deliveriesOf(failing.id)).length;
    await h.call('PATCH', `/v1/webhooks/${failing.id}`, { token, body: { status: 'disabled' } });
    await book();
    await outbox();
    expect(await deliveriesOf(failing.id)).toHaveLength(before);
  });

  /**
   * A project of its own, with an endpoint and events written straight into the log.
   *
   * Events are inserted with the application role and an explicit RLS context rather than by
   * making bookings: these two tests are about *the cursor*, and a scenario plus four API calls
   * per event would add nothing but time.
   */
  const isolatedProject = async (
    name: string,
  ): Promise<{
    token: string;
    bare: string;
    webhook: WebhookBody;
    writeEvents: (n: number) => Promise<void>;
    cursor: () => Promise<{ last_txid: string; last_seq: string } | undefined>;
    deliveries: () => Promise<DeliveryBody[]>;
  }> => {
    const project = await h.bootstrap(name);
    const own = project.testKey;
    const bare = decodeId('project', project.projectId) ?? project.projectId;
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token: own,
      body: { url: receiver.url, events: ['*'] },
    });
    expect(created.status).toBe(201);
    const adminDb = createDatabase(h.pools.admin);
    const appDb = createDatabase(h.pools.app);
    return {
      token: own,
      bare,
      webhook: created.body,
      writeEvents: async (n: number): Promise<void> => {
        await withProjectContext(appDb, { projectId: bare, environment: 'test' }, async (tx) => {
          for (let i = 0; i < n; i += 1) {
            await tx.execute(sql`
              INSERT INTO events (id, project_id, environment, type, data, api_version)
              VALUES (gen_random_uuid(), ${bare}, 'test', 'booking.confirmed',
                      ${JSON.stringify({ id: `probe_${name}_${String(i)}`, object: 'booking' })}::jsonb,
                      '2026-09-01')
            `);
          }
        });
      },
      cursor: async () => {
        const { rows } = await adminDb.execute<{ last_txid: string; last_seq: string }>(sql`
          SELECT last_txid::text AS last_txid, last_seq::text AS last_seq
            FROM outbox_cursor WHERE project_id = ${bare} AND environment = 'test'
        `);
        return rows[0];
      },
      deliveries: async () => {
        const list = await h.call<ListBody<DeliveryBody>>(
          'GET',
          `/v1/webhooks/${created.body.id}/deliveries?limit=100`,
          { token: own },
        );
        return list.body.data;
      },
    };
  };

  it('advances the cursor even when every endpoint of the project is disabled', async () => {
    // The review's I4. Discovery used to skip a scope with no enabled endpoint, so its cursor
    // froze; re-enabling an endpoint a month later then fired a month of deliveries at it, and
    // whether that happened depended on whether the project happened to have *another*, active
    // endpoint. The same gesture with two opposite outcomes.
    const project = await isolatedProject('Outbox disabled scope');
    await h.call('PATCH', `/v1/webhooks/${project.webhook.id}`, {
      token: project.token,
      body: { status: 'disabled' },
    });

    const before = await project.cursor();
    await project.writeEvents(3);
    await outbox();

    const after = await project.cursor();
    expect(after).toBeDefined();
    expect(after?.last_seq).not.toBe(before?.last_seq);
    expect(await project.deliveries()).toEqual([]);

    // Re-enabling does not replay what happened while it was off.
    await h.call('PATCH', `/v1/webhooks/${project.webhook.id}`, {
      token: project.token,
      body: { status: 'active' },
    });
    await outbox();
    expect(await project.deliveries()).toEqual([]);

    // And it does receive what happens next.
    await project.writeEvents(1);
    await outbox();
    expect(await project.deliveries()).toHaveLength(1);
  });

  it('rotates over the scopes, so no project is starved by the ones before it', async () => {
    // The review's I5. `SELECT … FROM webhooks ORDER BY project_id LIMIT 200` over a set that
    // never drains meant the projects sorting after the 200th never had their outbox run at
    // all. The discovery is now ordered by `outbox_cursor.updated_at`, and every visited scope
    // is stamped whether or not it converted anything, which is what makes it a rotation.
    const projects = [
      await isolatedProject('Outbox rotation A'),
      await isolatedProject('Outbox rotation B'),
      await isolatedProject('Outbox rotation C'),
    ];
    for (const project of projects) await project.writeEvents(1);

    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (SELECT DISTINCT project_id, environment FROM webhooks) s
    `);
    const totalScopes = rows[0]?.n ?? 0;
    expect(totalScopes).toBeGreaterThan(3);

    // One scope per tick: with a fixed order this loop would visit the same scope every time
    // and the three below it would never be reached.
    for (let tick = 0; tick < totalScopes + 3; tick += 1) {
      await outbox({ scopeLimit: 1 });
    }

    for (const project of projects) {
      expect(await project.deliveries(), 'every scope was reached').toHaveLength(1);
    }
  }, 60_000);

  it('is idempotent: running it again creates nothing and moves nothing', async () => {
    const endpoint = await createWebhook(['*']);
    await book();
    const first = await outbox();
    expect(first.deliveries).toBeGreaterThan(0);
    const after = await deliveriesOf(endpoint.id);
    const position = await cursor();

    const second = await outbox();
    expect(second.deliveries).toBe(0);
    expect(second.events).toBe(0);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(after.length);
    expect(await cursor()).toEqual(position);
  });

  it('creates no duplicate when the cursor advance is lost and the window is replayed', async () => {
    // The half of a crash the transaction cannot produce by itself: the deliveries committed
    // and the cursor did not. Reproduced by rewinding the cursor, which is also what a restore
    // of an older backup of that one row would do.
    const endpoint = await createWebhook(['*']);
    await book();
    const before = await cursor();
    expect(before).toBeDefined();
    await outbox();
    const delivered = await deliveriesOf(endpoint.id);
    expect(delivered.length).toBeGreaterThan(0);

    await rewindCursor(before?.last_txid ?? '2', before?.last_seq ?? '0');
    const replay = await outbox();
    expect(replay.events).toBeGreaterThan(0);
    // Every event was read again and every insert was refused by the unique constraint.
    expect(replay.deliveries).toBe(0);
    const after = await deliveriesOf(endpoint.id);
    expect(after.map((d) => d.id).sort()).toEqual(delivered.map((d) => d.id).sort());
  });

  it('loses nothing when the job dies between the inserts and the cursor advance', async () => {
    const endpoint = await createWebhook(['*']);
    await book();
    const before = await cursor();

    const crashed = await outbox({
      onBeforeCursorAdvance: () => {
        throw new Error('worker killed');
      },
    });
    expect(crashed.failed).toBeGreaterThan(0);
    // The transaction took the inserts with it, and the cursor never moved.
    expect(await deliveriesOf(endpoint.id)).toEqual([]);
    expect(await cursor()).toEqual(before);

    // The next tick does the work exactly once.
    await outbox();
    const delivered = await deliveriesOf(endpoint.id);
    expect(delivered.length).toBeGreaterThan(0);
    const eventIds = delivered.map((d) => d.event_id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it('never steps over an event whose transaction commits late', async () => {
    // The late commit scenario, applied to the outbox: `seq` is handed out at the
    // INSERT, so the transaction that took the *lower* number may commit *second*. Without the
    // horizon the outbox would dispatch the fast one, move its cursor past both, and never
    // deliver the slow one.
    const endpoint = await createWebhook(['*']);
    const appUrl = resolveDatabaseUrls({ databaseName: TEST_DB_NAME }).app;
    const slow = new Client({ connectionString: appUrl });
    const fast = new Client({ connectionString: appUrl });
    await slow.connect();
    await fast.connect();
    try {
      const insert = async (client: Client, type: string, marker: string): Promise<void> => {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.project_id', $1, true),
                  set_config('app.environment', 'test', true)`,
          [bareProjectId],
        );
        await client.query(
          `INSERT INTO events (id, project_id, environment, type, data, api_version)
           VALUES (gen_random_uuid(), $1, 'test', $2, $3::jsonb, '2026-09-01')`,
          [bareProjectId, type, JSON.stringify({ id: marker, object: 'booking' })],
        );
      };

      // The slow transaction takes the lower `seq` and holds; the fast one takes the higher and
      // commits at once.
      await insert(slow, 'booking.confirmed', 'outbox_probe_slow');
      await insert(fast, 'booking.completed', 'outbox_probe_fast');
      await fast.query('COMMIT');

      const during = await outboxWithoutSettling();
      expect(during.deliveries).toBe(0);
      const midway = await deliveriesOf(endpoint.id);
      expect(midway).toEqual([]);

      await slow.query('COMMIT');
      await outbox();

      const after = await deliveriesOf(endpoint.id);
      const types = after.map((d) => d.event_type);
      // Both arrived, each exactly once. The list is newest first, so the slow one, which took
      // the lower (txid, seq), is last.
      expect(types.filter((t) => t === 'booking.confirmed')).toHaveLength(1);
      expect(types.filter((t) => t === 'booking.completed')).toHaveLength(1);
      expect(types.slice(0, 2)).toEqual(['booking.completed', 'booking.confirmed']);
      expect(new Set(after.map((d) => d.event_id)).size).toBe(after.length);
    } finally {
      await slow.query('ROLLBACK').catch(() => undefined);
      await fast.query('ROLLBACK').catch(() => undefined);
      await slow.end();
      await fast.end();
    }
  });

  it('walks a backlog in batches without skipping anything', async () => {
    const endpoint = await createWebhook(['*']);
    const bookings: string[] = [];
    for (let i = 0; i < 5; i += 1) bookings.push(await book());

    let guard = 0;
    let report = await outbox({ batchSize: 2 });
    while (report.more && guard < 20) {
      report = await outbox({ batchSize: 2 });
      guard += 1;
    }
    const delivered = await deliveriesOf(endpoint.id);
    const eventIds = delivered.map((d) => d.event_id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(delivered.filter((d) => d.event_type === 'booking.created').length).toBe(
      bookings.length,
    );
  });

  it('leaves `events` untouched: the outbox only ever reads it', async () => {
    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events
       WHERE project_id = ${bareProjectId} AND updated_at <> created_at
    `);
    expect(rows[0]?.n).toBe(0);
  });
});
