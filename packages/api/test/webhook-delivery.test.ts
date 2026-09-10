/**
 * The delivery worker, against a real HTTP server on 127.0.0.1.
 *
 * Three things are being proved here and nowhere else. That what arrives at the endpoint is
 * what the documented contract promises: the envelope, the headers, and a signature that
 * `verifySignature` accepts and a wrong secret does not. That the retry ladder is
 * **exactly** 3s, 30s, 5m, 30m, 2h, 12h, 24h, which is asserted by injecting the clock rather
 * than by waiting thirty-nine hours. And that the eighth failure marks the endpoint `failing`,
 * writes `webhook.failing`, and does not deliver that event to anybody.
 *
 * The clock is a parameter of `runWebhookDeliveries` for the same reason it is a parameter of
 * the transition scheduler: a tick is one instant, and a test that had to wait for
 * it would be a test nobody runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, resolveDatabaseUrls, sql } from '@bookrail/db';
import { verifySignature } from '@bookrail/shared';
import { createHarness, type Harness } from './harness.js';
import { TEST_DB_NAME } from './db-name.js';
import { peakOverlap, startReceiver, type TestReceiver } from './webhook-receiver.js';
import { quiesceWebhooks } from './webhook-fixtures.js';
import { settleEventLog } from './event-horizon.js';
import { until } from './until.js';
import { runWebhookOutbox } from '../src/webhooks/outbox.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  runWebhookDeliveries,
  WEBHOOK_RETRY_DELAYS_SECONDS,
} from '../src/webhooks/dispatch.js';
import { startWorker, type Worker } from '../src/jobs/index.js';
import {
  buildScenario,
  nextMonday,
  plusDays,
  slotsFor,
  type Scenario,
} from './booking-fixtures.js';

interface WebhookBody {
  id: string;
  status: string;
  secret?: string;
}
interface DeliveryBody {
  id: string;
  event_id: string;
  event_type?: string | null;
  status: string;
  attempt: number;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  leased_until: string | null;
  delivered_at: string | null;
}
interface ListBody<T> {
  data: T[];
  has_more: boolean;
}
interface EventBody {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

describe('webhook delivery', () => {
  let h: Harness;
  let token: string;
  let receiver: TestReceiver;
  let scenario: Scenario;
  const monday = nextMonday();

  const deps = () => ({
    db: createDatabase(h.pools.app),
    logger: h.logger,
    webhookSecretKey: h.webhookSecretKey,
  });

  /**
   * One outbox tick, over a log that has settled.
   *
   * Every test here writes its events and then expects the very next tick to have queued them,
   * and that is true only once the horizon has moved past them. The horizon is a property of
   * the whole Postgres cluster, so a write transaction open in another suite, in another test
   * database, or in an autovacuum worker is enough to leave the last booking of a fixture
   * unconverted and the test short of one delivery. `settleEventLog` waits for that condition
   * instead of hoping for it; what follows it is asserted once, exactly as before.
   */
  const outbox = async (): ReturnType<typeof runWebhookOutbox> => {
    await settleEventLog(h);
    return runWebhookOutbox(deps());
  };

  /**
   * A tick. `now` says what is due; `signingNow` pins the instant that signs and that schedules
   * the next attempt, which in production is `Date.now()` at the moment each POST leaves. The
   * ladder is measured against that instant, so the test fixes the two together, and a separate
   * test below proves that, left alone, they really are the wall clock of each POST.
   */
  const dispatch = (now: number) =>
    runWebhookDeliveries(deps(), {
      now,
      signingNow: () => now,
      allowPrivateTargets: true,
      allowAnyPort: true,
      timeoutMs: 3000,
    });

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
    return list.body.data;
  };

  const oneDelivery = async (webhookId: string): Promise<DeliveryBody> => {
    const all = await deliveriesOf(webhookId);
    expect(all).toHaveLength(1);
    return all[0]!;
  };

  /**
   * A project nobody else in this file writes to.
   *
   * The two timing tests below measure how long a tick takes, and the delivery sweep is
   * cross-project by design: an endpoint subscribed to `*` left behind by an earlier test in
   * this same project multiplies the deliveries of every later booking, and the measurement
   * stops meaning anything. So they get their own project, their own endpoints, and therefore
   * exactly the deliveries they created.
   */
  const freshProject = async (
    name: string,
  ): Promise<{
    token: string;
    book: () => Promise<string>;
    endpoint: (n?: string[]) => Promise<WebhookBody>;
  }> => {
    const project = await h.bootstrap(name);
    const own = project.testKey;
    const scenario = await buildScenario(h, own, { resources: 4, capacity: 4 });
    const bookOne = async (): Promise<string> => {
      for (let day = 0; day < 7; day += 1) {
        const from = plusDays(monday, day);
        const slots = await slotsFor(h, own, scenario.serviceId, from, plusDays(from, 1));
        for (const slot of slots) {
          const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
            token: own,
            body: { service_id: scenario.serviceId, start: slot.start },
          });
          if (created.status === 201) return created.body.id;
        }
      }
      throw new Error('no bookable slot left in the fixture');
    };
    const endpoint = async (events?: string[]): Promise<WebhookBody> => {
      const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token: own,
        body: { url: receiver.url, ...(events === undefined ? {} : { events }) },
      });
      expect(created.status).toBe(201);
      return created.body;
    };
    return { token: own, book: bookOne, endpoint };
  };

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
    await h.bootstrap('Webhook delivery').then((p) => {
      token = p.testKey;
    });
    receiver = await startReceiver();
    scenario = await buildScenario(h, token, { resources: 4, capacity: 4 });
  });

  afterAll(async () => {
    // The database is shared with the suites that start a real worker; leave it quiet.
    await quiesceWebhooks(h);
    await receiver.close();
    await h.close();
  });

  it('delivers a real booking event, signed, in the documented envelope', async () => {
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    const secret = endpoint.secret ?? '';
    const bookingId = await book();
    await outbox();

    const before = await oneDelivery(endpoint.id);
    expect(before.status).toBe('pending');
    expect(before.attempt).toBe(0);

    const report = await dispatch(Date.now());
    expect(report.attempted).toBeGreaterThan(0);

    const request = receiver.requests.find((r) => r.headers['bookrail-webhook-id'] === endpoint.id);
    expect(request).toBeDefined();
    expect(request?.method).toBe('POST');
    expect(request?.headers['bookrail-event-id']).toBe(before.event_id);
    expect(request?.headers['bookrail-delivery-id']).toBe(before.id);
    expect(request?.headers['user-agent']).toMatch(/^Bookrail-Webhooks\//);

    // The signature verifies over the exact bytes that arrived, with the secret shown once.
    expect(
      verifySignature(request?.body ?? '', request?.headers['bookrail-signature'], secret),
    ).toBe(true);
    expect(
      verifySignature(request?.body ?? '', request?.headers['bookrail-signature'], 'whsec_wrong'),
    ).toBe(false);
    // And a tampered body does not.
    expect(
      verifySignature(`${request?.body ?? ''} `, request?.headers['bookrail-signature'], secret),
    ).toBe(false);

    const payload = JSON.parse(request?.body ?? '{}') as EventBody & {
      object: string;
      type: string;
      api_version: string;
      data: { object: Record<string, unknown>; previous: unknown };
    };
    expect(payload.object).toBe('event');
    expect(payload.type).toBe('booking.created');
    expect(payload.api_version).toBe('2026-09-01');
    expect(payload.data.object).toMatchObject({ id: bookingId, object: 'booking' });
    expect(payload.data.previous).toBeNull();

    // The payload is byte for byte the object `GET /v1/events/{id}` answers with, so a client
    // that polls and a client that receives can use one parser.
    const polled = await h.call<EventBody>('GET', `/v1/events/${before.event_id}`, { token });
    expect(JSON.parse(request?.body ?? '{}')).toEqual(polled.body);

    const after = await oneDelivery(endpoint.id);
    expect(after.status).toBe('succeeded');
    expect(after.attempt).toBe(1);
    expect(after.response_status).toBe(200);
    expect(after.response_body).toBe('{"ok":true}');
    expect(after.error).toBeNull();
    expect(after.next_attempt_at).toBeNull();
    expect(after.delivered_at).not.toBeNull();
    expect(after.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('retries on exactly 3s, 30s, 5m, 30m, 2h, 12h, 24h and then gives up', async () => {
    receiver.reset();
    receiver.status = 500;
    receiver.bodyText = 'boom';
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();

    // A ladder is a sequence of instants, so the test walks it with an injected clock instead
    // of waiting the thirty-nine hours the real one takes.
    let now = Date.now();
    for (const [index, expected] of WEBHOOK_RETRY_DELAYS_SECONDS.entries()) {
      const report = await dispatch(now);
      expect(report.attempted, `attempt ${String(index + 1)}`).toBeGreaterThan(0);
      const row = await oneDelivery(endpoint.id);
      expect(row.attempt, `attempt counter ${String(index + 1)}`).toBe(index + 1);
      expect(row.status).toBe('pending');
      expect(row.response_status).toBe(500);
      expect(row.response_body).toBe('boom');
      expect(row.error).toMatch(/500/);
      const delaySeconds = (Date.parse(row.next_attempt_at ?? '') - now) / 1000;
      expect(delaySeconds, `delay after attempt ${String(index + 1)}`).toBe(expected);

      // Nothing is due before then: a tick one second early does not touch it. Counted on
      // this endpoint only, because the sweep is cross-project by design and other endpoints
      // of the suite point at the same receiver.
      const mine = (): number =>
        receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id).length;
      const sent = mine();
      await dispatch(now + expected * 1000 - 1000);
      expect(mine(), `nothing due before ${String(expected)}s`).toBe(sent);

      now += expected * 1000;
    }

    // The eighth attempt is the last one.
    const last = await dispatch(now);
    expect(last.exhausted).toBeGreaterThan(0);
    const dead = await oneDelivery(endpoint.id);
    expect(dead.attempt).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(dead.status).toBe('failed');
    expect(dead.next_attempt_at).toBeNull();

    // The endpoint is marked failing, and says so in the event log.
    const marked = await h.call<WebhookBody>('GET', `/v1/webhooks/${endpoint.id}`, { token });
    expect(marked.body.status).toBe('failing');
    // `webhook.failing` was written by the tick that just ran, and the list answers from below
    // the horizon, so it becomes readable only once every write transaction older than it has
    // finished anywhere in the cluster.
    await settleEventLog(h);
    const events = await h.call<{ data: EventBody[] }>(
      'GET',
      `/v1/events?type=webhook.failing&limit=100`,
      { token },
    );
    const mine = events.body.data.filter((e) => e.data.object.id === endpoint.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data.object).toMatchObject({ status: 'failing', object: 'webhook' });

    // And nothing further is due: a `failed` delivery is not retried by any sweep.
    const quiet = await dispatch(now + 86_400_000);
    expect(quiet.attempted).toBe(0);
    receiver.reset();
  });

  it('replays a dead delivery and brings the endpoint back to active', async () => {
    receiver.reset();
    receiver.status = 500;
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();
    const delivery = await oneDelivery(endpoint.id);

    let now = Date.now();
    for (const delay of WEBHOOK_RETRY_DELAYS_SECONDS) {
      await dispatch(now);
      now += delay * 1000;
    }
    await dispatch(now);
    expect((await oneDelivery(endpoint.id)).status).toBe('failed');
    expect(
      (await h.call<WebhookBody>('GET', `/v1/webhooks/${endpoint.id}`, { token })).body.status,
    ).toBe('failing');

    // The customer fixes their endpoint and replays.
    receiver.status = 200;
    const replayed = await h.call<DeliveryBody>(
      'POST',
      `/v1/webhooks/${endpoint.id}/deliveries/${delivery.id}/retry`,
      { token },
    );
    expect(replayed.status).toBe(200);
    expect(replayed.body.status).toBe('pending');
    expect(replayed.body.attempt).toBe(0);

    await dispatch(Date.now());
    const healed = await oneDelivery(endpoint.id);
    expect(healed.status).toBe('succeeded');
    expect(healed.attempt).toBe(1);
    // A delivery that works again is an endpoint that works again.
    expect(
      (await h.call<WebhookBody>('GET', `/v1/webhooks/${endpoint.id}`, { token })).body.status,
    ).toBe('active');
    receiver.reset();
  });

  it('never delivers webhook.failing to anybody', async () => {
    const listener = await createWebhook(['*']);
    await outbox();
    const delivered = await deliveriesOf(listener.id);
    expect(delivered.some((d) => (d.event_type ?? '').startsWith('webhook.'))).toBe(false);
  });

  it('records a timeout as a failure, with no status and a reason', async () => {
    receiver.reset();
    receiver.delayMs = 1500;
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();
    await runWebhookDeliveries(deps(), {
      now: Date.now(),
      allowPrivateTargets: true,
      allowAnyPort: true,
      timeoutMs: 120,
    });
    const row = await oneDelivery(endpoint.id);
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(row.response_status).toBeNull();
    expect(row.error).toMatch(/timed out/i);
    expect(row.duration_ms).toBeGreaterThanOrEqual(100);
    receiver.reset();
  });

  it('does not deliver the same event to one endpoint twice, whatever the outbox does', async () => {
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    const bookingId = await book();
    await outbox();
    await outbox();
    await dispatch(Date.now());
    await dispatch(Date.now());

    const sent = receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id);
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]?.body ?? '{}') as EventBody;
    expect(payload.data.object.id).toBe(bookingId);
    expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
  });

  it('takes each delivery once when two workers sweep together', async () => {
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    for (let i = 0; i < 4; i += 1) await book();
    await outbox();
    const pending = await deliveriesOf(endpoint.id);
    expect(pending).toHaveLength(4);

    const now = Date.now();
    // Four sweeps at once, on distinct connections of the pool. `FOR UPDATE SKIP LOCKED` is
    // what makes this one attempt per delivery rather than four.
    await Promise.all([dispatch(now), dispatch(now), dispatch(now), dispatch(now)]);

    const sent = receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((r) => r.headers['bookrail-event-id'])).size).toBe(4);
    const after = await deliveriesOf(endpoint.id);
    expect(after.every((d) => d.status === 'succeeded')).toBe(true);
    expect(after.every((d) => d.attempt === 1)).toBe(true);
  });

  it('runs the outbox and the delivery on its own, through pg-boss', async () => {
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: h.cache,
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        {
          connectionString: urls.admin,
          // One second, not sixty. The queue's `short` policy admits a single job per name in
          // the `created` state, so a worker that stops after re-arming its hold sweep sixty
          // seconds out leaves a job that **swallows** the immediate re-arm of the next
          // worker started against the same database, which is the API suite's shared one.
          // The same property is why the delivery retry ladder lives in `next_attempt_at` and
          // not in `startAfter` (`src/webhooks/dispatch.ts`).
          intervalSeconds: 1,
          transitionsIntervalSeconds: 1,
          webhookOutboxIntervalSeconds: 1,
          webhookDeliveryIntervalSeconds: 1,
          maxConnections: 2,
          schedule: false,
          allowPrivateWebhookTargets: true,
        },
      );

      const bookingId = await book();
      const deadline = Date.now() + 25_000;
      let arrived = false;
      while (Date.now() < deadline && !arrived) {
        arrived = receiver.requests.some((r) => r.headers['bookrail-webhook-id'] === endpoint.id);
        if (!arrived) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(arrived).toBe(true);
      const payload = JSON.parse(
        receiver.requests.find((r) => r.headers['bookrail-webhook-id'] === endpoint.id)?.body ??
          '{}',
      ) as EventBody;
      expect(payload.data.object.id).toBe(bookingId);
      expect((await oneDelivery(endpoint.id)).status).toBe('succeeded');
    } finally {
      if (worker) await worker.stop();
    }
  }, 60_000);

  it('leaves the delivery pending, unsigned and unsent when no key is configured', async () => {
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();
    const report = await runWebhookDeliveries(
      { ...deps(), webhookSecretKey: undefined },
      { now: Date.now(), allowPrivateTargets: true, allowAnyPort: true },
    );
    expect(report.attempted).toBeGreaterThan(0);
    const row = await oneDelivery(endpoint.id);
    expect(row.status).toBe('pending');
    expect(row.error).toMatch(/WEBHOOK_SECRET_KEY/);
    expect(
      receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id),
    ).toHaveLength(0);
  });

  it('stamps each POST with its own clock, not with the start of the tick', async () => {
    // The independent review's I1. A tick is not an instant: with one `now` for the whole tick,
    // the last deliveries of a slow tick carried a `t` older than the ±300 s tolerance of our
    // own verifier, and the receiver saw an invalid signature rather than a late one.
    const project = await freshProject('Webhook delivery clock');
    receiver.reset();
    receiver.delayMs = 1100;
    const first = await project.endpoint(['booking.created']);
    const second = await project.endpoint(['booking.created']);
    await project.book();
    await outbox();

    // Concurrency 1 forces the two POSTs to be sequential, which is the shape that produced the
    // bug; with the default fan-out they would overlap and the point would be untestable.
    await runWebhookDeliveries(deps(), {
      now: Date.now(),
      allowPrivateTargets: true,
      allowAnyPort: true,
      concurrency: 1,
      timeoutMs: 5000,
    });
    receiver.delayMs = 0;

    const stamps = receiver.requests
      .filter((r) => [first.id, second.id].includes(r.headers['bookrail-webhook-id'] ?? ''))
      .map((r) => Number(/t=(\d+)/.exec(r.headers['bookrail-signature'] ?? '')?.[1] ?? '0'));
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0]!);

    // Both signatures verify against a verifier whose tolerance is one second: with the old
    // single stamp the second one would already be outside it.
    for (const request of receiver.requests.filter((r) =>
      [first.id, second.id].includes(r.headers['bookrail-webhook-id'] ?? ''),
    )) {
      const endpoint = request.headers['bookrail-webhook-id'] === first.id ? first : second;
      const stamp = Number(/t=(\d+)/.exec(request.headers['bookrail-signature'] ?? '')?.[1] ?? '0');
      expect(
        verifySignature(
          request.body,
          request.headers['bookrail-signature'],
          endpoint.secret ?? '',
          1,
          stamp,
        ),
      ).toBe(true);
    }
  }, 30_000);

  it('sends the deliveries of a tick in parallel, so one slow receiver holds nobody', async () => {
    // The review's I2: every delivery of every project used to be one `await` chain, so a single
    // endpoint in timeout blocked the webhooks of the whole estate.
    const project = await freshProject('Webhook delivery fanout');
    receiver.reset();
    receiver.delayMs = 400;
    const endpoint = await project.endpoint(['booking.created']);
    for (let i = 0; i < 4; i += 1) await project.book();
    await outbox();
    const queued = await h.call<ListBody<DeliveryBody>>(
      'GET',
      `/v1/webhooks/${endpoint.id}/deliveries?limit=100`,
      { token: project.token },
    );
    expect(queued.body.data).toHaveLength(4);

    await dispatch(Date.now());
    receiver.delayMs = 0;

    const sent = receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id);
    expect(sent).toHaveLength(4);
    // The four POSTs were open at the same instant. This used to be a stopwatch on the tick
    // ("under 1200 ms, where sequentially it would be 1600"), which asks how fast the machine
    // is as much as it asks whether the deliveries overlap: on a two core runner the database
    // work alone can eat the margin, and the test would go red for being slow rather than for
    // being sequential. The overlap of the intervals the receiver observed answers the real
    // question and answers it at any speed: held for 400 ms each, four at once is a fan out
    // and one at a time is the `await` chain the fan out replaced.
    expect(peakOverlap(sent)).toBe(4);
    const after = await h.call<ListBody<DeliveryBody>>(
      'GET',
      `/v1/webhooks/${endpoint.id}/deliveries?limit=100`,
      { token: project.token },
    );
    expect(after.body.data.every((d) => d.status === 'succeeded')).toBe(true);
  }, 30_000);

  it('stops delivering what is already queued when the endpoint is disabled', async () => {
    // `disabled` stops all the traffic towards an endpoint. It used to stop only the
    // outbox, so a customer who disabled an endpoint because its URL had leaked kept sending it
    // signed payloads for the 39 hours of the ladder.
    receiver.reset();
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();
    expect((await oneDelivery(endpoint.id)).status).toBe('pending');

    await h.call('PATCH', `/v1/webhooks/${endpoint.id}`, { token, body: { status: 'disabled' } });
    await dispatch(Date.now());
    expect(
      receiver.requests.filter((r) => r.headers['bookrail-webhook-id'] === endpoint.id),
    ).toHaveLength(0);
    // The row is untouched: not consumed, not failed, still due.
    const held = await oneDelivery(endpoint.id);
    expect(held.status).toBe('pending');
    expect(held.attempt).toBe(0);

    // And it resumes when the endpoint comes back, which is what makes `disabled` a pause.
    await h.call('PATCH', `/v1/webhooks/${endpoint.id}`, { token, body: { status: 'active' } });
    await dispatch(Date.now());
    expect((await oneDelivery(endpoint.id)).status).toBe('succeeded');
  });

  it('keeps the lease out of next_attempt_at while an attempt is in flight', async () => {
    // The review's M4: `next_attempt_at` is the ladder a customer reads, and it used to carry
    // `now + 120 s`, a value belonging to no rung, for the duration of every attempt.
    receiver.reset();
    receiver.delayMs = 600;
    const endpoint = await createWebhook(['booking.created']);
    await book();
    await outbox();

    const tick = dispatch(Date.now());
    // Wait for the attempt to be taken, not for a quarter of a second to pass. The receiver
    // holds each POST for 600 ms, so there is a window in which the row is leased and not yet
    // answered; a fixed sleep aimed at the middle of that window is a bet on how fast the
    // machine gets there, and a slower one loses it. The condition is the lease itself.
    const inFlight = await until(
      () => oneDelivery(endpoint.id),
      (row) => row.leased_until !== null,
      'the delivery to be leased by the tick in flight',
    );
    expect(inFlight.status).toBe('pending');
    expect(inFlight.attempt).toBe(1);
    expect(inFlight.leased_until).not.toBeNull();
    // The ladder column still holds the rung the delivery was due at, never the lease.
    expect(Date.parse(inFlight.next_attempt_at ?? '')).toBeLessThanOrEqual(Date.now());

    await tick;
    receiver.delayMs = 0;
    const done = await oneDelivery(endpoint.id);
    expect(done.status).toBe('succeeded');
    expect(done.leased_until).toBeNull();
  }, 30_000);

  it('leaves `events` append only: no row is ever updated by the delivery path', async () => {
    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events WHERE updated_at <> created_at
    `);
    expect(rows[0]?.n).toBe(0);
  });
});
