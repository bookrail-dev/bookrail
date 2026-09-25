/**
 * `/v1/webhooks`: the CRUD, the secret that is shown once, and `POST /{id}/test`.
 *
 * Everything goes through HTTP: half of what is being tested is the contract, and a test that
 * inserted a `webhooks` row directly would exercise none of the validation that makes
 * registering `http://169.254.169.254/` impossible in the first place.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeId, EMITTED_EVENT_TYPES, uuidv7, verifySignature } from '@bookrail/shared';
import { createHarness, WEBHOOK_SECRET_KEY, type Harness } from './harness.js';
import { startReceiver, type TestReceiver } from './webhook-receiver.js';
import { quiesceWebhooks } from './webhook-fixtures.js';
import { settleEventLog } from './event-horizon.js';
import { decryptWebhookSecret } from '../src/webhooks/secrets.js';
import type { ErrorBody } from './booking-fixtures.js';

interface WebhookBody {
  id: string;
  object: string;
  url: string;
  events: string[];
  status: string;
  description: string | null;
  metadata: Record<string, unknown>;
  environment: string;
  secret?: string;
}

interface DeliveryBody {
  id: string;
  object: string;
  webhook_id: string;
  event_id: string;
  event_type?: string | null;
  status: string;
  attempt: number;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
}

interface ListBody<T> {
  object: string;
  data: T[];
  has_more: boolean;
}

describe('/v1/webhooks', () => {
  let h: Harness;
  let token: string;
  let liveToken: string;
  let receiver: TestReceiver;

  beforeAll(async () => {
    h = createHarness({ allowPrivateWebhookTargets: true });
    const project = await h.bootstrap('Webhooks CRUD');
    token = project.testKey;
    liveToken = project.liveKey;
    receiver = await startReceiver();
  });

  afterAll(async () => {
    // The database is shared with the suites that start a real worker; leave it quiet.
    await quiesceWebhooks(h);
    await receiver.close();
    await h.close();
  });

  it('creates an endpoint and shows the secret exactly once', async () => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url, events: ['booking.created', 'booking.cancelled'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^wh_[0-9a-f]{32}$/);
    expect(created.body.object).toBe('webhook');
    expect(created.body.status).toBe('active');
    expect(created.body.events).toEqual(['booking.created', 'booking.cancelled']);
    expect(created.body.environment).toBe('test');
    const secret = created.body.secret;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    // And never again: not from GET, not from LIST, not from PATCH.
    const read = await h.call<WebhookBody>('GET', `/v1/webhooks/${created.body.id}`, { token });
    expect(read.status).toBe(200);
    expect(read.body.secret).toBeUndefined();
    expect(JSON.stringify(read.body)).not.toContain(secret);

    const list = await h.call<ListBody<WebhookBody>>('GET', '/v1/webhooks', { token });
    expect(JSON.stringify(list.body)).not.toContain(secret);

    const patched = await h.call<WebhookBody>('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: { description: 'production receiver' },
    });
    expect(patched.body.secret).toBeUndefined();
  });

  it('stores the secret encrypted, not in the clear and not hashed', async () => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    const secret = created.body.secret ?? '';
    const id = decodeId('webhook', created.body.id) ?? '';
    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ secret: string }>(sql`
      SELECT secret FROM webhooks WHERE id = ${id}
    `);
    const stored = rows[0]?.secret ?? '';
    expect(stored).not.toBe(secret);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith('v1.')).toBe(true);
    // And it decrypts back, which a hash could not: a signature has to be produced again on
    // every delivery.
    expect(decryptWebhookSecret(stored, WEBHOOK_SECRET_KEY, id)).toBe(secret);
    // The ciphertext is bound to this webhook's id, so it cannot be transplanted.
    expect(() =>
      decryptWebhookSecret(stored, WEBHOOK_SECRET_KEY, '00000000-0000-0000-0000-000000000000'),
    ).toThrow();
  });

  it('defaults to every event type', async () => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    expect(created.body.events).toEqual(['*']);
  });

  it('refuses an event type nobody will ever send', async () => {
    const bad = await h.call<ErrorBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url, events: ['booking.canceled'] },
    });
    expect(bad.status).toBe(400);
    const empty = await h.call<ErrorBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url, events: [] },
    });
    expect(empty.status).toBe(400);
    // The internal ones are not subscribable: an endpoint hearing about webhooks is a loop.
    const internal = await h.call<ErrorBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url, events: ['webhook.failing'] },
    });
    expect(internal.status).toBe(400);
  });

  it('refuses a URL that points inside the network, with param: url', async () => {
    // This harness allows private targets so that the delivery tests can reach 127.0.0.1; the
    // literal metadata address is still refused, because the guard is about the address and
    // not about the host being local. A second harness with the guard on covers the rest, in
    // `webhook-ssrf.test.ts`.
    const bad = await h.call<ErrorBody>('POST', '/v1/webhooks', {
      token,
      body: { url: 'ftp://example.com/hook' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe('url');
    expect(bad.body.error.code).toBe('invalid_webhook_url');
  });

  it('refuses http on a live key', async () => {
    const bad = await h.call<ErrorBody>('POST', '/v1/webhooks', {
      token: liveToken,
      body: { url: 'http://example.com/hook' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/https/i);
  });

  it('patches url, events, status, description and metadata', async () => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    const patched = await h.call<WebhookBody>('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: {
        events: ['booking.created'],
        status: 'disabled',
        description: 'paused',
        metadata: { owner: 'ada' },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.events).toEqual(['booking.created']);
    expect(patched.body.status).toBe('disabled');
    expect(patched.body.description).toBe('paused');
    expect(patched.body.metadata).toEqual({ owner: 'ada' });

    // `failing` is an observation, not a state a customer may assert.
    const forbidden = await h.call<ErrorBody>('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: { status: 'failing' },
    });
    expect(forbidden.status).toBe(400);

    const empty = await h.call<ErrorBody>('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: {},
    });
    expect(empty.status).toBe(400);
  });

  it('deletes an endpoint, and 404s on one that is not there', async () => {
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    const deleted = await h.call<{ deleted: boolean }>(
      'DELETE',
      `/v1/webhooks/${created.body.id}`,
      { token },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const gone = await h.call<ErrorBody>('GET', `/v1/webhooks/${created.body.id}`, { token });
    expect(gone.status).toBe(404);
    const missing = await h.call<ErrorBody>(
      'DELETE',
      '/v1/webhooks/wh_00000000000000000000000000000000',
      { token },
    );
    expect(missing.status).toBe(404);
  });

  it('shows a project only its own endpoints', async () => {
    const other = await h.bootstrap('Webhooks other');
    const mine = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    const foreign = await h.call<ErrorBody>('GET', `/v1/webhooks/${mine.body.id}`, {
      token: other.testKey,
    });
    expect(foreign.status).toBe(404);
    const list = await h.call<ListBody<WebhookBody>>('GET', '/v1/webhooks', {
      token: other.testKey,
    });
    expect(list.body.data).toEqual([]);
  });

  describe('POST /v1/webhooks/{id}/test', () => {
    it('delivers a synthetic event whose signature verifies with the secret shown once', async () => {
      receiver.reset();
      const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const secret = created.body.secret ?? '';

      const tested = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
        token,
      });
      expect(tested.status).toBe(200);
      expect(tested.body.object).toBe('webhook_delivery');
      expect(tested.body.status).toBe('succeeded');
      expect(tested.body.response_status).toBe(200);
      expect(tested.body.attempt).toBe(1);
      expect(tested.body.event_type).toBe('webhook.test');
      expect(tested.body.duration_ms).toBeGreaterThanOrEqual(0);

      const request = receiver.last;
      expect(request).toBeDefined();
      expect(request?.method).toBe('POST');
      expect(request?.headers['content-type']).toMatch(/application\/json/);
      expect(request?.headers['user-agent']).toMatch(/^Bookrail-Webhooks\//);
      expect(request?.headers['bookrail-webhook-id']).toBe(created.body.id);
      expect(request?.headers['bookrail-event-id']).toBe(tested.body.event_id);
      expect(request?.headers['bookrail-delivery-id']).toBe(tested.body.id);

      // The signature verifies with the public function, over the raw body.
      expect(
        verifySignature(request?.body ?? '', request?.headers['bookrail-signature'], secret),
      ).toBe(true);
      expect(
        verifySignature(request?.body ?? '', request?.headers['bookrail-signature'], 'nope'),
      ).toBe(false);

      const payload = JSON.parse(request?.body ?? '{}') as {
        id: string;
        object: string;
        type: string;
        data: { object: Record<string, unknown> };
      };
      expect(payload.object).toBe('event');
      expect(payload.type).toBe('webhook.test');
      expect(payload.id).toBe(tested.body.event_id);
      expect(payload.data.object).toMatchObject({ id: created.body.id, object: 'webhook' });
    });

    it('records a failing endpoint without retrying it', async () => {
      receiver.reset();
      receiver.status = 503;
      receiver.bodyText = 'nope';
      const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const tested = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
        token,
      });
      expect(tested.status).toBe(200);
      expect(tested.body.status).toBe('failed');
      expect(tested.body.response_status).toBe(503);
      expect(tested.body.response_body).toBe('nope');
      // No ladder: `next_attempt_at` is null, so no sweep will ever pick it up.
      expect(tested.body.next_attempt_at).toBeNull();
      // And the endpoint is not marked failing by a test the customer asked for.
      const after = await h.call<WebhookBody>('GET', `/v1/webhooks/${created.body.id}`, { token });
      expect(after.body.status).toBe('active');
      receiver.reset();
    });

    it('is not fanned out to the other endpoints of the project', async () => {
      receiver.reset();
      const listener = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url, events: ['*'] },
      });
      const target = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      await h.call('POST', `/v1/webhooks/${target.body.id}/test`, { token });

      const { runWebhookOutbox } = await import('../src/webhooks/outbox.js');
      // A tick only converts what is below the horizon, and the horizon is a property of the
      // whole cluster. Without the wait the tick can convert nothing at all, and an assertion
      // that no delivery carries `webhook.test` would hold for the wrong reason.
      await settleEventLog(h);
      await runWebhookOutbox({
        db: createDatabase(h.pools.app),
        logger: h.logger,
      });

      const deliveries = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${listener.body.id}/deliveries?limit=100`,
        { token },
      );
      expect(deliveries.body.data.every((d) => d.event_type !== 'webhook.test')).toBe(true);
    });

    it('404s on an endpoint that does not exist', async () => {
      const missing = await h.call<ErrorBody>(
        'POST',
        '/v1/webhooks/wh_00000000000000000000000000000000/test',
        { token },
      );
      expect(missing.status).toBe(404);
    });
  });

  describe('deliveries', () => {
    it('lists the deliveries of one endpoint, newest first, and replays one', async () => {
      receiver.reset();
      const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const first = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
        token,
      });
      const second = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
        token,
      });

      const list = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${created.body.id}/deliveries`,
        { token },
      );
      expect(list.status).toBe(200);
      expect(list.body.data.map((d) => d.id)).toEqual([second.body.id, first.body.id]);
      expect(list.body.data[0]?.webhook_id).toBe(created.body.id);

      const filtered = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${created.body.id}/deliveries?status=failed`,
        { token },
      );
      expect(filtered.body.data).toEqual([]);

      const byEvent = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${created.body.id}/deliveries?event_id=${first.body.event_id}`,
        { token },
      );
      expect(byEvent.body.data.map((d) => d.id)).toEqual([first.body.id]);

      // Paging is descending on a v7 id, so it is descending on creation.
      const page = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${created.body.id}/deliveries?limit=1`,
        { token },
      );
      expect(page.body.has_more).toBe(true);
      const next = await h.call<ListBody<DeliveryBody>>(
        'GET',
        `/v1/webhooks/${created.body.id}/deliveries?limit=1&starting_after=${page.body.data[0]?.id ?? ''}`,
        { token },
      );
      expect(next.body.data.map((d) => d.id)).toEqual([first.body.id]);

      const replayed = await h.call<DeliveryBody>(
        'POST',
        `/v1/webhooks/${created.body.id}/deliveries/${first.body.id}/retry`,
        { token },
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body.status).toBe('pending');
      // A replay is a fresh decision, so it gets a fresh ladder rather than the exhausted one.
      expect(replayed.body.attempt).toBe(0);
      expect(replayed.body.next_attempt_at).not.toBeNull();
      expect(replayed.body.response_status).toBeNull();
      expect(replayed.body.delivered_at).toBeNull();
    });

    it('refuses a replay of a delivery older than the thirty day window', async () => {
      receiver.reset();
      const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const delivery = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
        token,
      });
      const adminDb = createDatabase(h.pools.admin);
      await adminDb.execute(sql`
        UPDATE webhook_deliveries SET created_at = now() - interval '31 days'
         WHERE id = ${decodeId('webhook_delivery', delivery.body.id)}
      `);
      const refused = await h.call<ErrorBody>(
        'POST',
        `/v1/webhooks/${created.body.id}/deliveries/${delivery.body.id}/retry`,
        { token },
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('delivery_too_old');
    });

    it('404s on a delivery that belongs to another endpoint', async () => {
      const a = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const b = await h.call<WebhookBody>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url },
      });
      const delivery = await h.call<DeliveryBody>('POST', `/v1/webhooks/${a.body.id}/test`, {
        token,
      });
      const crossed = await h.call<ErrorBody>(
        'POST',
        `/v1/webhooks/${b.body.id}/deliveries/${delivery.body.id}/retry`,
        { token },
      );
      expect(crossed.status).toBe(404);
    });
  });

  it('never writes a secret to idempotency_keys either', async () => {
    // The blocking finding of the independent review. `POST /v1/webhooks` is the only POST
    // of `/v1` that returns a secret, and the `Idempotency-Key` middleware persists the body of
    // every POST of `/v1` for 24 hours. Without a route that nominates what to remember, a
    // client sending the header (which is exactly what an SDK with a retry policy does) wrote
    // `whsec_…` in the clear into the database.
    const key = `webhook-secret-leak-${uuidv7()}`;
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
      headers: { 'idempotency-key': key },
    });
    expect(created.status).toBe(201);
    const secret = created.body.secret ?? '';
    expect(secret).toMatch(/^whsec_/);

    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ body: string }>(sql`
      SELECT response_body::text AS body FROM idempotency_keys WHERE key = ${key}
    `);
    const stored = rows[0]?.body ?? '';
    expect(stored).not.toBe('');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('whsec_');
    // What is stored is the endpoint itself, so a replay is still useful.
    expect(stored).toContain(created.body.id);

    // And the replay returns the endpoint **without** the secret: the first response was the
    // one time it is shown; a replay is not another one.
    const replayed = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
      headers: { 'idempotency-key': key },
    });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.body.id).toBe(created.body.id);
    expect(replayed.body.secret).toBeUndefined();
  });

  it('refuses /test and /retry on a disabled endpoint', async () => {
    receiver.reset();
    const created = await h.call<WebhookBody>('POST', '/v1/webhooks', {
      token,
      body: { url: receiver.url },
    });
    const delivery = await h.call<DeliveryBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
      token,
    });
    expect(delivery.status).toBe(200);
    const before = receiver.requests.length;

    await h.call('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: { status: 'disabled' },
    });

    const tested = await h.call<ErrorBody>('POST', `/v1/webhooks/${created.body.id}/test`, {
      token,
    });
    expect(tested.status).toBe(409);
    expect(tested.body.error.code).toBe('webhook_disabled');

    const replayed = await h.call<ErrorBody>(
      'POST',
      `/v1/webhooks/${created.body.id}/deliveries/${delivery.body.id}/retry`,
      { token },
    );
    expect(replayed.status).toBe(409);
    expect(replayed.body.error.code).toBe('webhook_disabled');

    // Nothing left the process while the endpoint was disabled.
    expect(receiver.requests).toHaveLength(before);

    // Re-enabling makes both work again.
    await h.call('PATCH', `/v1/webhooks/${created.body.id}`, {
      token,
      body: { status: 'active' },
    });
    expect((await h.call('POST', `/v1/webhooks/${created.body.id}/test`, { token })).status).toBe(
      200,
    );
  });

  it('keeps EMITTED_EVENT_TYPES equal to what the engine actually writes', async () => {
    // `@bookrail/shared` claims to list the types the system emits, and a list like that is
    // right the day it is written and wrong the first time somebody adds an event. So it is
    // compared with the literals in the engine's own source: adding `booking.paused` there
    // without adding it here fails this test instead of silently producing an event no
    // endpoint can subscribe to.
    const dir = fileURLToPath(new URL('../../engine/src/booking/', import.meta.url));
    const found = new Set<string>();
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = await readFile(`${dir}${name}`, 'utf8');
      for (const match of source.matchAll(/'((?:booking|hold)\.[a-z_]+)'/g)) {
        found.add(match[1] ?? '');
      }
    }
    // The engine is no longer the only thing that writes events. `/v1/stripe` writes the two
    // `stripe.*` ones and the incoming webhook receiver writes the three `payment.*` ones, so
    // the scan covers both routes: the property being checked is still "the list in
    // `@bookrail/shared` is exactly what the source emits", not "the engine emits everything".
    // And the plan: `plan.usage_warning` is written by the engine's plan counter, which lives
    // beside the booking transaction rather than inside it.
    const planSource = await readFile(
      fileURLToPath(new URL('../../engine/src/plan/usage.ts', import.meta.url)),
      'utf8',
    );
    for (const match of planSource.matchAll(/'(plan\.[a-z_]+)'/g)) found.add(match[1] ?? '');
    // And `plan.changed`, which the database writes itself, in the transaction that changes the
    // plan of an account (migration 0027), for a signed Stripe Billing event or `bookrail-plan`.
    const billingMigration = await readFile(
      fileURLToPath(new URL('../../db/migrations/0027_billing.sql', import.meta.url)),
      'utf8',
    );
    for (const match of billingMigration.matchAll(/'(plan\.[a-z_]+)'/g)) found.add(match[1] ?? '');
    for (const file of ['../src/routes/stripe.ts', '../src/routes/stripe-webhook.ts']) {
      const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      for (const match of source.matchAll(/'((?:stripe|payment)\.[a-z_]+)'/g)) {
        found.add(match[1] ?? '');
      }
    }
    expect([...found].sort()).toEqual([...EMITTED_EVENT_TYPES].sort());
  });

  it('never writes a secret to the log', async () => {
    const lines: string[] = [];
    const noisy = createHarness({
      allowPrivateWebhookTargets: true,
      logger: {
        debug: (m, f) => lines.push(JSON.stringify({ m, f })),
        info: (m, f) => lines.push(JSON.stringify({ m, f })),
        warn: (m, f) => lines.push(JSON.stringify({ m, f })),
        error: (m, f) => lines.push(JSON.stringify({ m, f })),
        child() {
          return this;
        },
      },
    });
    try {
      const project = await noisy.bootstrap('Webhooks logging');
      const created = await noisy.call<WebhookBody>('POST', '/v1/webhooks', {
        token: project.testKey,
        body: { url: receiver.url },
      });
      const secret = created.body.secret ?? '';
      await noisy.call('POST', `/v1/webhooks/${created.body.id}/test`, { token: project.testKey });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes(secret))).toBe(false);
      expect(lines.some((line) => line.includes('whsec_'))).toBe(false);
    } finally {
      await noisy.close();
    }
  });
});
