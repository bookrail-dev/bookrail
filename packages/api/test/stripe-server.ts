/**
 * A fake Stripe on 127.0.0.1, in this process, over a real socket.
 *
 * `node:http`, no dependency, and no mocked `fetch`: what the tests have to prove is that the
 * client speaks Stripe's wire protocol (the bracket form encoding, `Stripe-Version`,
 * `Stripe-Account`, `Idempotency-Key`, the two shapes of error body), and a mocked `fetch`
 * would prove only that the mock was called.
 *
 * It serves both bases, because they are two hosts at Stripe and one server here: the API
 * (`/v1/...`) and Connect (`/oauth/...`). `STRIPE_API_BASE` and `STRIPE_CONNECT_BASE` are
 * pointed at the same URL, which is exactly what those two variables exist for and is refused
 * under `NODE_ENV=production`.
 *
 * Every answer is programmable between calls, so one server can play a Stripe that authorises,
 * a Stripe that refuses, a Stripe that authorised the wrong mode and a Stripe that hangs.
 *
 * ## It knows about `client_id`, because Stripe does
 *
 * A Stripe OAuth application is itself a live one or a test one, and two documented facts follow
 * from that: the `livemode` of an authorisation "matches the livemode of the application used to
 * authorize the OAuth request", and the key used to turn the code into a connection "must match
 * the mode (live or test) of the authorization code (which depends on whether the `client_id`
 * used was production or development)". A fake that ignored `client_id` would be a fake in which
 * a single shared `ca_` works, which is precisely the defect this server has to be able to
 * express. So it knows two application identifiers, {@link FakeStripe.codeFor} mints a code
 * bound to the one in an authorisation URL, and `/oauth/token` refuses a code whose mode does
 * not match the key, with `invalid_grant`, exactly as the reference says.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StripeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The raw `application/x-www-form-urlencoded` body, exactly as it arrived. */
  body: string;
  /** The same body parsed, for the assertions that are about one field. */
  form: Record<string, string>;
}

export interface FakeStripe {
  /** The value for both `STRIPE_API_BASE` and `STRIPE_CONNECT_BASE`. */
  url: string;
  /** Every request this server saw, in order. */
  requests: StripeRequest[];
  /** The two OAuth applications this fake platform owns, one per mode. */
  readonly clientIds: { test: string; live: string };
  /**
   * An authorisation code for the application named in an authorisation URL.
   *
   * This is where the mode is decided, as it is at Stripe: the code carries the mode of the
   * application that issued it, and `/oauth/token` reads it back. Throws on a `client_id` this
   * platform does not own, which in a test means the test built the URL wrong.
   */
  codeFor(authorizeUrl: string): string;
  /** The account identifier the next OAuth exchange hands back. */
  stripeUserId: string;
  /**
   * Answer this `livemode` whatever the application implies, or `null` to answer the truth.
   *
   * Cannot happen against the real Stripe, and exists for one reason: the callback has a branch
   * that refuses an authorisation whose mode disagrees with the environment, and a branch that
   * nothing can reach is a branch that nothing checks. The `CHECK` in the migration is the same
   * kind of second net.
   */
  forceLivemode: boolean | null;
  /** `charges_enabled` of the next account read. */
  chargesEnabled: boolean;
  /** When set, the next matching call answers this instead of succeeding. */
  failWith: { path: string; status: number; body: unknown } | null;
  /** Milliseconds to hold a request before answering. Used to reach the client timeout. */
  delayMs: number;
  /** The requests whose path ends with this suffix. */
  of(suffix: string): StripeRequest[];
  /** The PaymentIntent of that id, as this fake currently holds it. */
  intent(id: string): { status: string } | undefined;
  /** Marks an intent succeeded, so that a cancel of it answers the documented refusal. */
  succeed(id: string, amountReceived: number): void;
  /** Marks an intent cancelled, so that a cancel of it answers the other documented refusal. */
  cancel(id: string): void;
  close(): Promise<void>;
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) out[key] = value;
  return out;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const requests: StripeRequest[] = [];
  const clientIds = { test: 'ca_FakeTestApplication', live: 'ca_FakeLiveApplication' };
  /** Every PaymentIntent this fake has created, by id, so a cancel or a read can find one. */
  const intents = new Map<string, Record<string, unknown> & { status: string }>();
  /** Stripe's own `Idempotency-Key` behaviour, which the creation route depends on. */
  const intentsByKey = new Map<string, Record<string, unknown>>();
  const refundsByKey = new Map<string, Record<string, unknown>>();
  const state = {
    stripeUserId: 'acct_1FakeAccount',
    forceLivemode: null as boolean | null,
    chargesEnabled: true,
    failWith: null as FakeStripe['failWith'],
    delayMs: 0,
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : (value ?? '');
      }
      const url = request.url ?? '';
      requests.push({ method: request.method ?? 'GET', url, headers, body, form: parseForm(body) });

      const answer = (status: number, payload: unknown): void => {
        const send = (): void => {
          response.writeHead(status, {
            'content-type': 'application/json',
            'request-id': 'req_fake_stripe',
          });
          response.end(JSON.stringify(payload));
        };
        if (state.delayMs > 0) {
          // `unref`, so a delayed answer nobody is waiting for any more (the client has already
          // timed out and aborted) cannot hold the process, or the `close()` below, open.
          setTimeout(send, state.delayMs).unref();
        } else send();
      };

      /** `test` or `live`, from a key or from a code. Unknown shapes count as test. */
      const modeOf = (value: string): 'test' | 'live' => (/_live_/.test(value) ? 'live' : 'test');

      const path = url.split('?')[0] ?? '';
      if (state.failWith !== null && path.endsWith(state.failWith.path)) {
        answer(state.failWith.status, state.failWith.body);
        return;
      }
      if (path === '/oauth/token') {
        const form = parseForm(body);
        const code = form.code ?? '';
        const keyMode = modeOf(form.client_secret ?? '');
        // «API key mode (live or test key) doesn't match the `code` mode» is one of the three
        // documented causes of `invalid_grant` on this endpoint, and it is exactly what a
        // platform with one shared `client_id` would hit on one of its two environments.
        if (modeOf(code) !== keyMode) {
          answer(400, {
            error: 'invalid_grant',
            error_description:
              'The API key mode does not match the mode of the authorization code.',
          });
          return;
        }
        answer(200, {
          access_token: `${keyMode === 'live' ? 'sk_live' : 'sk_test'}_thisMustNeverBeStored`,
          refresh_token: 'rt_thisMustNeverBeStored',
          stripe_publishable_key: 'pk_test_connected',
          stripe_user_id: state.stripeUserId,
          livemode: state.forceLivemode ?? keyMode === 'live',
          scope: 'read_write',
          token_type: 'bearer',
        });
        return;
      }
      if (path === '/oauth/deauthorize') {
        const form = parseForm(body);
        const clientId = form.client_id ?? '';
        const keyMode = modeOf(headers.authorization ?? '');
        const owned = clientId === clientIds.test || clientId === clientIds.live;
        // The other documented cause of `invalid_client`: a key of the wrong mode for the
        // application. The three causes are indistinguishable by code, which is why the route
        // treats all of them as a refusal.
        if (!owned || modeOf(clientId === clientIds.live ? '_live_' : '_test_') !== keyMode) {
          answer(401, {
            error: 'invalid_client',
            error_description:
              'This client_id does not belong to you, or the API key mode does not match it.',
          });
          return;
        }
        answer(200, { stripe_user_id: state.stripeUserId });
        return;
      }
      // --- PaymentIntents and Refunds ---------------------------------------------------
      //
      // The fake keeps them, because the handlers under test read them back: a cancellation
      // asks Stripe to cancel an intent that a creation made a moment earlier, and a refund
      // asks for one against an intent that has to exist. A fake that answered `200` to
      // everything would let a test pass while the code cancelled an intent that was never
      // created.
      if (path === '/v1/payment_intents') {
        const form = parseForm(body);
        const key = headers['idempotency-key'] ?? '';
        // Stripe's own idempotency: the same key answers the same object instead of creating a
        // second intent. It is the property the creation route depends on for its retries, so
        // the fake has to have it or the test would be proving nothing.
        const existing = key === '' ? undefined : intentsByKey.get(key);
        if (existing !== undefined) {
          answer(200, existing);
          return;
        }
        const id = `pi_${String(intents.size + 1)}Fake`;
        const intent = {
          id,
          object: 'payment_intent',
          amount: Number(form.amount ?? 0),
          amount_received: 0,
          currency: form.currency ?? 'eur',
          status: 'requires_payment_method',
          client_secret: `${id}_secret_${String(intents.size + 1)}`,
          capture_method: form.capture_method ?? 'automatic',
          description: form.description ?? null,
          latest_charge: null,
        };
        intents.set(id, intent);
        if (key !== '') intentsByKey.set(key, intent);
        answer(200, intent);
        return;
      }
      if (/^\/v1\/payment_intents\/[^/]+\/cancel$/.test(path)) {
        const id = path.split('/')[3] ?? '';
        const intent = intents.get(id);
        if (intent === undefined) {
          answer(404, {
            error: {
              type: 'invalid_request_error',
              code: 'resource_missing',
              message: `No such payment_intent: ${id}`,
            },
          });
          return;
        }
        if (intent.status === 'succeeded' || intent.status === 'canceled') {
          // The documented refusal, and the one the worker has to tell apart: an intent that
          // has already succeeded means the money arrived in the window between the
          // cancellation and the call, and an intent already cancelled is the state that was
          // asked for.
          //
          // The real Stripe attaches the PaymentIntent itself to this error, and so does this,
          // because the `status` inside it is what the worker reads. The sentence is kept as
          // well, because it is what the fallback path reads when the object is absent, and a
          // fake that dropped it would stop exercising that path.
          answer(400, {
            error: {
              type: 'invalid_request_error',
              code: 'payment_intent_unexpected_state',
              message: `This PaymentIntent's status is "${intent.status}". You may only cancel it when it is not.`,
              payment_intent: intent,
            },
          });
          return;
        }
        intent.status = 'canceled';
        answer(200, intent);
        return;
      }
      if (/^\/v1\/payment_intents\/[^/]+$/.test(path)) {
        const id = path.split('/')[3] ?? '';
        const intent = intents.get(id);
        if (intent === undefined) {
          answer(404, {
            error: {
              type: 'invalid_request_error',
              code: 'resource_missing',
              message: `No such payment_intent: ${id}`,
            },
          });
          return;
        }
        answer(200, intent);
        return;
      }
      if (path === '/v1/refunds') {
        const form = parseForm(body);
        const key = headers['idempotency-key'] ?? '';
        const existing = key === '' ? undefined : refundsByKey.get(key);
        if (existing !== undefined) {
          answer(200, existing);
          return;
        }
        const intentId = form.payment_intent ?? '';
        if (!intents.has(intentId)) {
          answer(404, {
            error: {
              type: 'invalid_request_error',
              code: 'resource_missing',
              message: `No such payment_intent: ${intentId}`,
            },
          });
          return;
        }
        const refund = {
          id: `re_${String(refundsByKey.size + 1)}Fake`,
          object: 'refund',
          amount: Number(form.amount ?? 0),
          currency: 'eur',
          payment_intent: intentId,
          status: 'succeeded',
        };
        if (key !== '') refundsByKey.set(key, refund);
        answer(200, refund);
        return;
      }
      if (path.startsWith('/v1/accounts/')) {
        answer(200, {
          id: path.slice('/v1/accounts/'.length),
          object: 'account',
          charges_enabled: state.chargesEnabled,
          details_submitted: true,
          default_currency: 'eur',
          country: 'IT',
        });
        return;
      }
      answer(404, {
        error: { type: 'invalid_request_error', code: 'url_invalid', message: 'No such path.' },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    clientIds,
    codeFor(authorizeUrl: string): string {
      const clientId = new URL(authorizeUrl).searchParams.get('client_id') ?? '';
      if (clientId === clientIds.test) return `ac_test_${String(requests.length)}`;
      if (clientId === clientIds.live) return `ac_live_${String(requests.length)}`;
      throw new Error(`no such OAuth application on this fake platform: ${clientId}`);
    },
    get stripeUserId() {
      return state.stripeUserId;
    },
    set stripeUserId(value: string) {
      state.stripeUserId = value;
    },
    get forceLivemode() {
      return state.forceLivemode;
    },
    set forceLivemode(value: boolean | null) {
      state.forceLivemode = value;
    },
    get chargesEnabled() {
      return state.chargesEnabled;
    },
    set chargesEnabled(value: boolean) {
      state.chargesEnabled = value;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(value: FakeStripe['failWith']) {
      state.failWith = value;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    of(suffix: string) {
      return requests.filter((request) => (request.url.split('?')[0] ?? '').endsWith(suffix));
    },
    intent(id: string) {
      return intents.get(id);
    },
    succeed(id: string, amountReceived: number) {
      const intent = intents.get(id);
      if (intent === undefined) throw new Error(`no such fake intent: ${id}`);
      intent.status = 'succeeded';
      intent.amount_received = amountReceived;
    },
    cancel(id: string) {
      const intent = intents.get(id);
      if (intent === undefined) throw new Error(`no such fake intent: ${id}`);
      intent.status = 'canceled';
    },
    async close() {
      state.delayMs = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
