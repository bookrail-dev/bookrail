/**
 * `/v1/stripe`, the client underneath it, and the one thing neither of them may ever do.
 *
 * Nothing is mocked. A fake Stripe listens on 127.0.0.1 over a real socket
 * (`test/stripe-server.ts`), the API is the real app on the real Postgres named by
 * `DATABASE_URL`, and the callback is driven exactly as a browser would drive it: a `GET` with
 * a query string and no `Authorization` header at all.
 *
 * The assertions that matter most are the negative ones. The same `state` twice writes once.
 * A `state` that has expired writes nothing. An authorisation granted in the wrong mode writes
 * nothing. And no platform key, in any form, appears in any log line or in any error the suite
 * produces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@bookrail/db';
import { decodeId, type Logger } from '@bookrail/shared';
import { createHash } from 'node:crypto';
import type { StripePlatformConfig } from '../src/config.js';
import {
  encodeStripeForm,
  StripeApiError,
  StripeClient,
  StripeUnreachableError,
  STRIPE_API_VERSION,
} from '../src/stripe/client.js';
import { settleEventLog } from './event-horizon.js';
import { createHarness, type Harness } from './harness.js';
import { startFakeStripe, type FakeStripe } from './stripe-server.js';

/** Obviously fake, and shaped like the real thing so that the log scanner has something to find. */
const PLATFORM_TEST_KEY = 'rk_test_platformKeyForTestsOnly';
const PLATFORM_LIVE_KEY = 'rk_live_platformKeyForTestsOnly';

/**
 * A platform with its two OAuth applications, one per mode, which is what Stripe requires.
 *
 * `clientIds` come from the fake, so that the codes it mints are bound to applications it owns.
 * `sharedClientId` builds the configuration that used to exist, one `ca_` for both modes, and
 * exists for the one test that shows what that costs.
 */
function stripeConfig(
  stripe: FakeStripe,
  options: { live?: boolean; sharedClientId?: string } = {},
): StripePlatformConfig {
  const clientId = (mode: 'test' | 'live'): string =>
    options.sharedClientId ?? stripe.clientIds[mode];
  return {
    redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
    environments: {
      test: {
        clientId: clientId('test'),
        secretKey: PLATFORM_TEST_KEY,
        publishableKey: 'pk_test_platform',
      },
      live:
        options.live === true
          ? {
              clientId: clientId('live'),
              secretKey: PLATFORM_LIVE_KEY,
              publishableKey: 'pk_live_platform',
            }
          : null,
    },
    // Belongs to the incoming webhook receiver, which nothing here exercises: `null` is a
    // deployment that has platform keys and has not registered an endpoint yet.
    webhookSecrets: { test: null, live: null },
    apiBase: stripe.url,
    connectBase: stripe.url,
  };
}

interface ConnectionBody {
  object: string;
  status: string;
  environment: string;
  id: string | null;
  account_id: string | null;
  publishable_key: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  disconnect_reason: string | null;
  charges_enabled: boolean | null;
}

interface ConnectLinkBody {
  object: string;
  url: string;
  expires_at: string;
  environment: string;
}

/** `bootstrap` hands back the public `proj_...` id; a raw statement needs the bare UUID. */
function uuidOf(projectId: string): string {
  const decoded = decodeId('project', projectId);
  if (decoded === null) throw new Error(`not a project id: ${projectId}`);
  return decoded;
}

interface ErrorBody {
  error: { type: string; code: string; message: string; fix?: string };
}

// --- The client --------------------------------------------------------------------------

describe('the form encoder', () => {
  it('uses the bracket notation Stripe expects for nested values', () => {
    expect(
      encodeStripeForm({
        amount: 2500,
        metadata: { bookrail_booking_id: 'bk_1', nested: { deep: 'yes' } },
        expand: ['latest_charge'],
        description: null,
        absent: undefined,
      }),
    ).toBe(
      'amount=2500&metadata%5Bbookrail_booking_id%5D=bk_1&metadata%5Bnested%5D%5Bdeep%5D=yes' +
        '&expand%5B0%5D=latest_charge&description=',
    );
  });
});

describe('the Stripe client', () => {
  let stripe: FakeStripe;
  let client: StripeClient;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    client = new StripeClient({
      secretKey: PLATFORM_TEST_KEY,
      clientId: stripe.clientIds.test,
      apiBase: stripe.url,
      connectBase: stripe.url,
    });
  });

  afterAll(async () => {
    await stripe.close();
  });

  it('sends the pinned version, the bearer key and the form body', async () => {
    const result = await client.oauthToken({ code: 'ac_test_direct' });
    expect(result).toEqual({ stripeUserId: 'acct_1FakeAccount', livemode: false });

    const request = stripe.of('/oauth/token').at(-1)!;
    expect(request.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(request.headers.authorization).toBe(`Bearer ${PLATFORM_TEST_KEY}`);
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.form.grant_type).toBe('authorization_code');
    expect(request.form.code).toBe('ac_test_direct');
    expect(request.form.client_secret).toBe(PLATFORM_TEST_KEY);
  });

  it('refuses an account identifier that is not an acct_', async () => {
    // A Stripe that answered something unexpected. The value would become a `Stripe-Account`
    // header on every later call and a row the migration's CHECK would refuse anyway.
    stripe.failWith = {
      path: '/oauth/token',
      status: 200,
      body: { stripe_user_id: 'not-an-account', livemode: false },
    };
    try {
      await expect(client.oauthToken({ code: 'ac_test_odd' })).rejects.toBeInstanceOf(
        StripeApiError,
      );
    } finally {
      stripe.failWith = null;
    }
  });

  it('sends Stripe-Account and Idempotency-Key when the caller asks, and not otherwise', async () => {
    await client.retrieveAccount({ stripeUserId: 'acct_plain' });
    const plain = stripe.of('/v1/accounts/acct_plain').at(-1)!;
    expect(plain.headers['stripe-account']).toBeUndefined();
    expect(plain.headers['idempotency-key']).toBeUndefined();
    expect(plain.method).toBe('GET');

    // The positive branch, which is the one every call made for a connected account will take.
    await client.retrieveAccount({
      stripeUserId: 'acct_onbehalf',
      stripeAccount: 'acct_Connected9',
      idempotencyKey: 'idem-abc-123',
    });
    const behalf = stripe.of('/v1/accounts/acct_onbehalf').at(-1)!;
    expect(behalf.headers['stripe-account']).toBe('acct_Connected9');
    expect(behalf.headers['idempotency-key']).toBe('idem-abc-123');
    // The fixed headers are still there next to them.
    expect(behalf.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(behalf.headers.authorization).toBe(`Bearer ${PLATFORM_TEST_KEY}`);
  });

  it('reads the account fields the connection status reports', async () => {
    stripe.chargesEnabled = false;
    const account = await client.retrieveAccount({ stripeUserId: 'acct_read' });
    expect(account).toEqual({
      id: 'acct_read',
      chargesEnabled: false,
      detailsSubmitted: true,
      defaultCurrency: 'eur',
      country: 'IT',
    });
    stripe.chargesEnabled = true;
  });

  it('turns a Stripe error body into a StripeApiError with its request id', async () => {
    stripe.failWith = {
      path: '/oauth/deauthorize',
      status: 401,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_client',
          message: 'No such application.',
        },
      },
    };
    try {
      await client.oauthDeauthorize({ stripeUserId: 'acct_1FakeAccount' });
      expect.unreachable('the deauthorize should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(StripeApiError);
      const api = error as StripeApiError;
      expect(api.status).toBe(401);
      expect(api.type).toBe('invalid_request_error');
      expect(api.code).toBe('invalid_client');
      expect(api.requestId).toBe('req_fake_stripe');
      expect(api.message).toBe('No such application.');
    } finally {
      stripe.failWith = null;
    }
  });

  it('reads the flat error shape the OAuth endpoints use', async () => {
    stripe.failWith = {
      path: '/oauth/token',
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Authorization code already used.' },
    };
    try {
      await client.oauthToken({ code: 'used' });
      expect.unreachable('the exchange should have been refused');
    } catch (error) {
      const api = error as StripeApiError;
      expect(api).toBeInstanceOf(StripeApiError);
      expect(api.code).toBe('invalid_grant');
      expect(api.message).toBe('Authorization code already used.');
    } finally {
      stripe.failWith = null;
    }
  });

  it('never puts the platform key in the message or the stack of either error', async () => {
    stripe.failWith = {
      path: '/oauth/token',
      status: 400,
      // A Stripe error body that echoes the request, which is what one really does.
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_client',
          message: 'No such application.',
          request_body: `client_secret=${PLATFORM_TEST_KEY}`,
        },
      },
    };
    let caught: unknown;
    try {
      await client.oauthToken({ code: 'ac_test_echo' });
    } catch (error) {
      caught = error;
    } finally {
      stripe.failWith = null;
    }
    const api = caught as StripeApiError;
    expect(api).toBeInstanceOf(StripeApiError);
    for (const text of [api.message, api.stack ?? '', JSON.stringify(api)]) {
      expect(text).not.toContain(PLATFORM_TEST_KEY);
      expect(text).not.toContain('rk_test_');
      expect(text).not.toContain('Bearer');
    }
  });

  it('turns a timeout into StripeUnreachableError, without the key or the URL', async () => {
    const impatient = new StripeClient({
      secretKey: PLATFORM_TEST_KEY,
      clientId: stripe.clientIds.test,
      apiBase: stripe.url,
      connectBase: stripe.url,
      timeoutMs: 40,
    });
    stripe.delayMs = 400;
    let caught: unknown;
    try {
      await impatient.retrieveAccount({ stripeUserId: 'acct_slow' });
    } catch (error) {
      caught = error;
    } finally {
      stripe.delayMs = 0;
    }
    expect(caught).toBeInstanceOf(StripeUnreachableError);
    const unreachable = caught as StripeUnreachableError;
    expect(unreachable.message).not.toContain(PLATFORM_TEST_KEY);
    expect(unreachable.message).not.toContain(stripe.url);
    expect(unreachable.stack ?? '').not.toContain(PLATFORM_TEST_KEY);
  });

  it('turns a refused connection into StripeUnreachableError', async () => {
    const nowhere = new StripeClient({
      secretKey: PLATFORM_TEST_KEY,
      clientId: stripe.clientIds.test,
      // Port 1 on loopback: nothing listens there, so the connection is refused at once.
      apiBase: 'http://127.0.0.1:1',
      connectBase: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
    });
    await expect(nowhere.retrieveAccount({ stripeUserId: 'acct_x' })).rejects.toBeInstanceOf(
      StripeUnreachableError,
    );
  });
});

// --- The routes --------------------------------------------------------------------------

/** The log of one harness, as flat text, for the "no key anywhere" assertion. */
const logLines: string[] = [];

const recordingLogger: Logger = {
  debug: (m, f) => logLines.push(JSON.stringify({ m, f })),
  info: (m, f) => logLines.push(JSON.stringify({ m, f })),
  warn: (m, f) => logLines.push(JSON.stringify({ m, f })),
  error: (m, f) => logLines.push(JSON.stringify({ m, f })),
  child() {
    return recordingLogger;
  },
};

describe('the Stripe routes', () => {
  let stripe: FakeStripe;
  let h: Harness;
  let project: Awaited<ReturnType<Harness['bootstrap']>>;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    h = createHarness({ stripe: stripeConfig(stripe, { live: true }), logger: recordingLogger });
    // A name that appears nowhere else on the page: the callback prints the project's own name,
    // read from `projects` inside the transaction, and `Stripe` would have matched the heading.
    project = await h.bootstrap('Acme Bakery');
  }, 60_000);

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  /**
   * Runs the whole flow and returns the callback's HTML, as a browser would see it.
   *
   * The code comes from `stripe.codeFor(link.url)`, not from a literal: at Stripe a code carries
   * the mode of the application that issued it, so a test that made one up would be testing a
   * Stripe in which `client_id` does not exist.
   */
  async function authorise(
    token: string,
    options: { forceLivemode?: boolean; account?: string } = {},
  ): Promise<{ status: number; html: string; state: string }> {
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', { token });
    expect(link.status).toBe(201);
    const state = new URL(link.body.url).searchParams.get('state')!;
    if (options.forceLivemode !== undefined) stripe.forceLivemode = options.forceLivemode;
    if (options.account !== undefined) stripe.stripeUserId = options.account;
    const response = await callback({ state, code: stripe.codeFor(link.body.url) });
    return { ...response, state };
  }

  /** The callback exactly as a browser sends it: a GET, a query string, no Authorization. */
  async function callback(
    query: Record<string, string>,
  ): Promise<{ status: number; html: string; headers: Headers }> {
    const search = new URLSearchParams(query).toString();
    const response = await h.app.request(`/v1/stripe/callback?${search}`, { method: 'GET' });
    return { status: response.status, html: await response.text(), headers: response.headers };
  }

  /**
   * How many connection rows a project has, read on the admin pool.
   *
   * Deliberately not through the API: several of the tests below are about a callback that
   * must write **nothing**, and "the endpoint reports nothing" is a weaker statement than
   * "there is no row", which is the one being made.
   */
  async function countConnections(projectId: string): Promise<number> {
    const { rows } = await h.pools.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM payment_provider_connections WHERE project_id = $1',
      [uuidOf(projectId)],
    );
    return Number(rows[0]?.n ?? '0');
  }

  it('hands back an authorisation URL with the state, the client id and the redirect', async () => {
    const response = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: project.testKey,
    });
    expect(response.status).toBe(201);
    expect(response.body.object).toBe('stripe_connect_link');
    expect(response.body.environment).toBe('test');

    const url = new URL(response.body.url);
    expect(url.origin).toBe(new URL(stripe.url).origin);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    // The application of **this** environment, which is what decides the mode of everything
    // that follows.
    expect(url.searchParams.get('client_id')).toBe(stripe.clientIds.test);
    expect(url.searchParams.get('scope')).toBe('read_write');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.bookrail.dev/v1/stripe/callback',
    );
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Fifteen minutes, give or take the time the request took.
    const ttl = Date.parse(response.body.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(13 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);

    // The clear text state is nowhere in the database: only its digest is.
    const { rows } = await h.pools.admin.query<{ state_hash: Buffer }>(
      'SELECT state_hash FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(project.projectId)],
    );
    expect(rows).toHaveLength(1);
    expect(
      rows[0]!.state_hash.equals(
        createHash('sha256').update(url.searchParams.get('state')!).digest(),
      ),
    ).toBe(true);

    // Clean up: this state is not the one the rest of the file uses.
    await h.pools.admin.query('DELETE FROM stripe_oauth_states WHERE project_id = $1', [
      uuidOf(project.projectId),
    ]);
  });

  it('says not_connected before anything has been authorised', async () => {
    const response = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: project.testKey });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      object: 'stripe_connection',
      status: 'not_connected',
      environment: 'test',
      id: null,
      account_id: null,
      // The platform publishable key is there before anything is connected: a front end can be
      // written first.
      publishable_key: 'pk_test_platform',
      charges_enabled: null,
    });
  });

  it('connects the account the callback comes back with, and records the event', async () => {
    const { status, html } = await authorise(project.testKey, { account: 'acct_Connected1' });
    expect(status).toBe(200);
    expect(html).toContain('Stripe is connected');
    // The project's own name, which is the only thing on that page that can only come from a
    // read of `projects` inside the transaction that wrote the connection.
    expect(html).toContain('Acme Bakery');
    expect(html).toContain('acct_Connected1');
    expect(html).toContain('bookrail stripe status');

    const connection = await h.call<ConnectionBody>('GET', '/v1/stripe', {
      token: project.testKey,
    });
    expect(connection.status).toBe(200);
    expect(connection.body).toMatchObject({
      status: 'connected',
      account_id: 'acct_Connected1',
      charges_enabled: true,
      disconnected_at: null,
      disconnect_reason: null,
    });
    expect(connection.body.id).toMatch(/^pcn_[0-9a-f]{32}$/);

    // `GET /v1/events` answers from below `pg_snapshot_xmin`, which is a property of the whole
    // Postgres cluster: reading right after a write is green on an idle machine and red beside
    // a second suite. Wait for the horizon, then ask once.
    await settleEventLog(h);
    const events = await h.call<{ data: { type: string; actor: { type: string; id: string } }[] }>(
      'GET',
      '/v1/events?type[]=stripe.connected',
      { token: project.testKey },
    );
    expect(events.body.data).toHaveLength(1);
    // The actor is the key that asked for the link: the browser that finished the flow has no
    // credential, and `system` would be claiming nobody asked.
    expect(events.body.data[0]!.actor.type).toBe('api');
    expect(events.body.data[0]!.actor.id).toMatch(/^key_[0-9a-f]{32}$/);
  });

  it('serves the callback with no key, no script and a policy that allows nothing', async () => {
    const response = await callback({ state: 'notavalidstateatall', code: 'x' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.html).not.toContain('<script');
  });

  it('refuses a connect when one account is already connected', async () => {
    const response = await h.call<ErrorBody>('POST', '/v1/stripe/connect', {
      token: project.testKey,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('stripe_already_connected');
    expect(response.body.error.fix).toContain('bookrail stripe disconnect');
  });

  it('disconnects, tells Stripe first, and records the event', async () => {
    const before = stripe.of('/oauth/deauthorize').length;
    const response = await h.call<ConnectionBody>('DELETE', '/v1/stripe', {
      token: project.testKey,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'disconnected',
      disconnect_reason: 'user',
      account_id: 'acct_Connected1',
      charges_enabled: null,
    });
    expect(response.body.disconnected_at).not.toBeNull();

    const deauthorized = stripe.of('/oauth/deauthorize');
    expect(deauthorized.length).toBe(before + 1);
    expect(deauthorized.at(-1)!.form.client_id).toBe(stripe.clientIds.test);
    expect(deauthorized.at(-1)!.form.stripe_user_id).toBe('acct_Connected1');

    await settleEventLog(h);
    const events = await h.call<{ data: { type: string }[] }>(
      'GET',
      '/v1/events?type[]=stripe.disconnected',
      { token: project.testKey },
    );
    expect(events.body.data).toHaveLength(1);
  });

  it('answers 404 on a disconnect with nothing to disconnect', async () => {
    const response = await h.call<ErrorBody>('DELETE', '/v1/stripe', { token: project.testKey });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('resource_missing');
  });

  it('reuses the row when a disconnected project connects again', async () => {
    const before = await countConnections(project.projectId);
    const { status } = await authorise(project.testKey, { account: 'acct_Connected2' });
    expect(status).toBe(200);
    expect(await countConnections(project.projectId)).toBe(before);

    const connection = await h.call<ConnectionBody>('GET', '/v1/stripe', {
      token: project.testKey,
    });
    expect(connection.body).toMatchObject({
      status: 'connected',
      account_id: 'acct_Connected2',
      disconnected_at: null,
      disconnect_reason: null,
    });
  });

  it('refuses a second link once a connection exists, and keeps the first account (B2)', async () => {
    // Two links minted while the project had nothing connected: both `POST /connect` calls
    // succeed, because neither sees a connection. The first authorisation wins; the second must
    // not be able to move the project's money to another account.
    const other = await h.bootstrap('Two links');
    const first = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const second = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    expect(second.status).toBe(201);

    stripe.stripeUserId = 'acct_First';
    const one = await callback({
      state: new URL(first.body.url).searchParams.get('state')!,
      code: stripe.codeFor(first.body.url),
    });
    expect(one.status).toBe(200);

    // Part two of the correction: the surviving links of that project are deleted by the
    // connection that succeeded, so the second one is already gone when it comes back.
    const left = await h.pools.admin.query(
      'SELECT 1 FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(other.projectId)],
    );
    expect(left.rows).toHaveLength(0);

    stripe.stripeUserId = 'acct_Second';
    const two = await callback({
      state: new URL(second.body.url).searchParams.get('state')!,
      code: stripe.codeFor(second.body.url),
    });
    expect(two.status).toBe(400);
    expect(two.html).toContain('already been used');

    expect(await countConnections(other.projectId)).toBe(1);
    const connection = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: other.testKey });
    expect(connection.body.account_id).toBe('acct_First');
  });

  it('refuses a live state even when the row still exists, and says which account (B2)', async () => {
    // The same guard reached from the other side: a state that outlives the deletion above
    // because it was written directly, which is what a replica lagging or a future code path
    // could produce. What is asserted is the `WHERE status = 'disconnected'` of the upsert, not
    // the deletion.
    const other = await h.bootstrap('Late link');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    const hash = createHash('sha256').update(state, 'utf8').digest();

    stripe.stripeUserId = 'acct_Keeper';
    expect((await callback({ state, code: stripe.codeFor(link.body.url) })).status).toBe(200);

    // Put the very same state back, as if it had never been consumed.
    const keyRow = await h.pools.admin.query<{ id: string }>(
      "SELECT id FROM api_keys WHERE project_id = $1 AND environment = 'test' LIMIT 1",
      [uuidOf(other.projectId)],
    );
    await h.pools.admin.query(
      `INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                        expires_at)
       VALUES (gen_random_uuid(), $1, 'test', $2, $3, now() + interval '15 minutes')`,
      [uuidOf(other.projectId), hash, keyRow.rows[0]!.id],
    );

    stripe.stripeUserId = 'acct_Intruder';
    const late = await callback({ state, code: stripe.codeFor(link.body.url) });
    expect(late.status).toBe(409);
    expect(late.html).toContain('already connected');
    expect(late.html).toContain('acct_Keeper');

    expect(await countConnections(other.projectId)).toBe(1);
    const connection = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: other.testKey });
    expect(connection.body.account_id).toBe('acct_Keeper');

    // And no second `stripe.connected` was written for the refusal.
    await settleEventLog(h);
    const events = await h.call<{ data: unknown[] }>('GET', '/v1/events?type[]=stripe.connected', {
      token: other.testKey,
    });
    expect(events.body.data).toHaveLength(1);
  }, 60_000);

  it('refuses a link whose key has been revoked since (B2)', async () => {
    // The escalation the guard closes: somebody who held a key long enough to mint a link keeps
    // it working for fifteen minutes after the key is taken away, because the callback carries
    // no credential of its own. The claim function now refuses, and consumes the row anyway.
    const other = await h.bootstrap('Revoked key');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;

    await h.pools.admin.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = (SELECT api_key_id FROM stripe_oauth_states WHERE project_id = $1 LIMIT 1)',
      [uuidOf(other.projectId)],
    );

    const exchanges = stripe.of('/oauth/token').length;
    stripe.stripeUserId = 'acct_Intruder2';
    const response = await callback({ state, code: stripe.codeFor(link.body.url) });
    expect(response.status).toBe(400);
    // Refused before the code is used for anything at all.
    expect(stripe.of('/oauth/token').length).toBe(exchanges);
    expect(await countConnections(other.projectId)).toBe(0);
    // The row is gone all the same: a refused link is not a link to retry.
    const left = await h.pools.admin.query(
      'SELECT 1 FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(other.projectId)],
    );
    expect(left.rows).toHaveLength(0);
  });

  it('replays the same link for the same Idempotency-Key, and mints no second state', async () => {
    const other = await h.bootstrap('Idempotent connect');
    const headers = { 'idempotency-key': 'connect-once' };
    const first = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
      headers,
    });
    const second = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
      headers,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body.url).toBe(first.body.url);
    expect(second.body.expires_at).toBe(first.body.expires_at);

    const { rows } = await h.pools.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(other.projectId)],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('refuses the same state a second time, and writes nothing', async () => {
    const other = await h.bootstrap('Stripe replay');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    stripe.stripeUserId = 'acct_Replay';

    const first = await callback({ state, code: stripe.codeFor(link.body.url) });
    expect(first.status).toBe(200);
    expect(await countConnections(other.projectId)).toBe(1);

    const exchangesBefore = stripe.of('/oauth/token').length;
    const second = await callback({ state, code: stripe.codeFor(link.body.url) });
    expect(second.status).toBe(400);
    expect(second.html).toContain('already been used');
    // Not one more exchange: the state is checked before the code is used for anything.
    expect(stripe.of('/oauth/token').length).toBe(exchangesBefore);
    expect(await countConnections(other.projectId)).toBe(1);

    const connection = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: other.testKey });
    expect(connection.body.account_id).toBe('acct_Replay');
  });

  it('refuses an expired state, and writes nothing', async () => {
    const other = await h.bootstrap('Stripe expiry');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    // Moved into the past rather than waited out: the expiry is a column, so the test can ask
    // what fifteen minutes from now does without taking fifteen minutes.
    await h.pools.admin.query(
      "UPDATE stripe_oauth_states SET expires_at = now() - interval '1 second' WHERE project_id = $1",
      [uuidOf(other.projectId)],
    );

    const response = await callback({ state, code: stripe.codeFor(link.body.url) });
    expect(response.status).toBe(400);
    expect(response.html).toContain('expired');
    expect(await countConnections(other.projectId)).toBe(0);
    // Consumed all the same: an expired state is rubbish nobody may use.
    const { rows } = await h.pools.admin.query(
      'SELECT 1 FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(other.projectId)],
    );
    expect(rows).toHaveLength(0);
  });

  it('writes nothing when the customer refuses on Stripe', async () => {
    const other = await h.bootstrap('Stripe refusal');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    const exchanges = stripe.of('/oauth/token').length;

    const response = await callback({ state, error: 'access_denied' });
    expect(response.status).toBe(200);
    expect(response.html).toContain('Nothing was connected');
    expect(stripe.of('/oauth/token').length).toBe(exchanges);
    expect(await countConnections(other.projectId)).toBe(0);
  });

  it('writes nothing when Stripe authorised the other mode', async () => {
    const other = await h.bootstrap('Stripe livemode');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    // A Stripe that answers a mode its application does not imply. It cannot happen for real,
    // which is the point: the branch is a second net behind the CHECK of the migration, and a
    // net nothing ever falls into is a net nobody has looked at.
    stripe.forceLivemode = true;

    try {
      const response = await callback({ state, code: stripe.codeFor(link.body.url) });
      expect(response.status).toBe(400);
      expect(response.html).toContain('wrong mode');
    } finally {
      stripe.forceLivemode = null;
    }
    expect(await countConnections(other.projectId)).toBe(0);
  });

  it('cannot connect the test environment with a live application (B1)', async () => {
    // The shape that existed before this correction: one `ca_` for both modes. Here the shared
    // application is the live one, so the `test` environment mints a live link and then tries to
    // exchange its code with a test key, which Stripe refuses with `invalid_grant`. With the
    // per environment `client_id` above, the same flow succeeds.
    const shared = createHarness({
      stripe: stripeConfig(stripe, { sharedClientId: stripe.clientIds.live }),
      logger: recordingLogger,
    });
    try {
      const broken = await shared.bootstrap('Shared client id');
      const link = await shared.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
        token: broken.testKey,
      });
      const state = new URL(link.body.url).searchParams.get('state')!;
      const code = stripe.codeFor(link.body.url);
      expect(code.startsWith('ac_live_')).toBe(true);

      const search = new URLSearchParams({ state, code }).toString();
      const response = await shared.app.request(`/v1/stripe/callback?${search}`, { method: 'GET' });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('could not be reached');

      const { rows } = await h.pools.admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM payment_provider_connections WHERE project_id = $1',
        [uuidOf(broken.projectId)],
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await shared.close();
    }
  }, 60_000);

  it('answers 502 and writes nothing when Stripe cannot be reached', async () => {
    const other = await h.bootstrap('Stripe unreachable');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    stripe.failWith = {
      path: '/oauth/token',
      status: 500,
      body: { error: { type: 'api_error', message: 'Something went wrong.' } },
    };
    try {
      const response = await callback({ state, code: stripe.codeFor(link.body.url) });
      expect(response.status).toBe(502);
      expect(response.html).toContain('could not be reached');
    } finally {
      stripe.failWith = null;
    }
    expect(await countConnections(other.projectId)).toBe(0);
  });

  it('answers 400 to a callback with no state at all', async () => {
    const response = await callback({ code: 'ac_test_orphan' });
    expect(response.status).toBe(400);
    expect(response.html).toContain('not valid');
  });

  it('still answers 200 when Stripe will not say whether charges are enabled', async () => {
    const other = await h.bootstrap('Stripe slow read');
    stripe.stripeUserId = 'acct_SlowRead';
    await authorise(other.testKey);

    stripe.failWith = {
      path: '/v1/accounts/acct_SlowRead',
      status: 503,
      body: { error: { type: 'api_error', message: 'Service unavailable.' } },
    };
    try {
      const response = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: other.testKey });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('connected');
      // `null`, not `false`: "we do not know" and "Stripe says no" are different answers.
      expect(response.body.charges_enabled).toBeNull();
    } finally {
      stripe.failWith = null;
    }
  });

  it('refuses a publishable key on all three keyed routes', async () => {
    const publishable = 'pk_test_0123456789abcdef0123456789abcdef';
    for (const [method, path] of [
      ['POST', '/v1/stripe/connect'],
      ['GET', '/v1/stripe'],
      ['DELETE', '/v1/stripe'],
    ] as const) {
      const response = await h.call<ErrorBody>(method, path, { token: publishable });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.body.error.code).toBe('invalid_api_key');
    }
  });

  it('keeps every platform key out of every log line of this suite', () => {
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join('\n');
    for (const secret of [
      PLATFORM_TEST_KEY,
      PLATFORM_LIVE_KEY,
      'rk_test_',
      'rk_live_',
      'sk_',
      'whsec_',
    ]) {
      expect(all, `the log contains ${secret}`).not.toContain(secret);
    }
  });

  it('keeps the clear text state out of every log line of this suite', async () => {
    const other = await h.bootstrap('Stripe log');
    const link = await h.call<ConnectLinkBody>('POST', '/v1/stripe/connect', {
      token: other.testKey,
    });
    const state = new URL(link.body.url).searchParams.get('state')!;
    stripe.failWith = {
      path: '/oauth/token',
      status: 500,
      body: { error: { type: 'api_error', message: 'Something went wrong.' } },
    };
    try {
      await callback({ state, code: stripe.codeFor(link.body.url) });
    } finally {
      stripe.failWith = null;
    }
    expect(logLines.join('\n')).not.toContain(state);
  });
});

// --- A deployment that is not a Stripe platform ---------------------------------------------

describe('a deployment with no Stripe credentials', () => {
  let h: Harness;
  let project: Awaited<ReturnType<Harness['bootstrap']>>;

  beforeAll(async () => {
    h = createHarness();
    project = await h.bootstrap('Stripe off');
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('answers 503 stripe_not_configured on all three keyed routes', async () => {
    for (const [method, path] of [
      ['POST', '/v1/stripe/connect'],
      ['GET', '/v1/stripe'],
      ['DELETE', '/v1/stripe'],
    ] as const) {
      const response = await h.call<ErrorBody>(method, path, { token: project.testKey });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(response.body.error.code).toBe('stripe_not_configured');
      expect(response.body.error.type).toBe('internal');
      expect(response.body.error.fix).toContain('STRIPE_CLIENT_ID_TEST');
    }
  });
});

// --- An environment without credentials, on a deployment that has them for the other --------

describe('an environment without credentials', () => {
  let stripe: FakeStripe;
  let h: Harness;
  let project: Awaited<ReturnType<Harness['bootstrap']>>;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    // `live: false`: a platform in test and not in live, which is what a deployment looks like
    // before it has been approved for real payments.
    h = createHarness({ stripe: stripeConfig(stripe, { live: false }) });
    project = await h.bootstrap('Stripe test only');
  }, 60_000);

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  it('serves test and answers 503 on live', async () => {
    const test = await h.call<ConnectionBody>('GET', '/v1/stripe', { token: project.testKey });
    expect(test.status).toBe(200);
    expect(test.body.status).toBe('not_connected');

    const live = await h.call<ErrorBody>('GET', '/v1/stripe', { token: project.liveKey });
    expect(live.status).toBe(503);
    expect(live.body.error.code).toBe('stripe_not_configured');
    expect(live.body.error.fix).toContain('STRIPE_SECRET_KEY_LIVE');
  });
});

// --- The purge --------------------------------------------------------------------------------

describe('the hourly purge', () => {
  let stripe: FakeStripe;
  let h: Harness;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    h = createHarness({ stripe: stripeConfig(stripe) });
  }, 60_000);

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  it('deletes the states whose fifteen minutes have run out, and no others', async () => {
    const { purgeStripeOauthStates } = await import('../src/jobs/tasks.js');
    const project = await h.bootstrap('Stripe purge');
    await h.call('POST', '/v1/stripe/connect', { token: project.testKey });
    await h.pools.admin.query(
      "UPDATE stripe_oauth_states SET expires_at = now() - interval '1 hour' WHERE project_id = $1",
      [uuidOf(project.projectId)],
    );
    const fresh = await h.bootstrap('Stripe purge fresh');
    await h.call('POST', '/v1/stripe/connect', { token: fresh.testKey });

    const deleted = await purgeStripeOauthStates({
      db: createDatabase(h.pools.app),
      logger: h.logger,
    });
    expect(deleted).toBeGreaterThanOrEqual(1);

    const stale = await h.pools.admin.query(
      'SELECT 1 FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(project.projectId)],
    );
    expect(stale.rows).toHaveLength(0);
    const alive = await h.pools.admin.query(
      'SELECT 1 FROM stripe_oauth_states WHERE project_id = $1',
      [uuidOf(fresh.projectId)],
    );
    expect(alive.rows).toHaveLength(1);
  });
});
