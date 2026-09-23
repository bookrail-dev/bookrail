/**
 * The whole payment flow, end to end, against a fake Stripe over a real socket.
 *
 * Nothing is mocked. The API is the real app on the real Postgres named by `DATABASE_URL`, the
 * fake Stripe is `test/stripe-server.ts` listening on 127.0.0.1, and the webhooks are real
 * `POST`s with a real `Stripe-Signature` computed from the same bytes that are sent. The only
 * thing invented here is the money.
 *
 * **No test here waits for a clock.** The expiry of a payment is thirty minutes away and is
 * exercised by passing `now` to the task, which is a parameter for exactly this reason. The
 * one place a wait is unavoidable is the event log, which is
 * readable only below `pg_snapshot_xmin`, and that is `settleEventLog`, a wait on the condition
 * and not on a duration.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import type { StripePlatformConfig } from '../src/config.js';
import { MAX_ATTEMPTS, runPaymentActions } from '../src/jobs/payment-actions.js';
import { runBookingTransitions } from '../src/jobs/tasks.js';
import { settleEventLog } from './event-horizon.js';
import { buildScenario, firstSlot, nextMonday, plusDays } from './booking-fixtures.js';

/** The error envelope, with the `fix` this suite asserts on. */
interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string; fix?: string };
}
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { startFakeStripe, type FakeStripe } from './stripe-server.js';
import { startReceiver, type TestReceiver } from './webhook-receiver.js';

const PLATFORM_TEST_KEY = 'rk_test_paymentTestsOnly';
const PLATFORM_LIVE_KEY = 'rk_live_paymentTestsOnly';
const WEBHOOK_SECRET_TEST = 'whsec_obviouslyFakeTestSigningSecret';
const WEBHOOK_SECRET_LIVE = 'whsec_obviouslyFakeLiveSigningSecret';
const ACCOUNT = 'acct_1PaymentsFake';

function stripeConfig(stripe: FakeStripe): StripePlatformConfig {
  return {
    redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
    environments: {
      test: {
        clientId: stripe.clientIds.test,
        secretKey: PLATFORM_TEST_KEY,
        publishableKey: 'pk_test_platform',
      },
      live: {
        clientId: stripe.clientIds.live,
        secretKey: PLATFORM_LIVE_KEY,
        publishableKey: 'pk_live_platform',
      },
    },
    webhookSecrets: { test: WEBHOOK_SECRET_TEST, live: WEBHOOK_SECRET_LIVE },
    apiBase: stripe.url,
    connectBase: stripe.url,
  };
}

interface BookingBody {
  id: string;
  status: string;
  amount_paid: number;
  amount_due: number;
  amount_refunded: number;
  refund_percent: number | null;
  refund_amount_expected: number | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  next_transition: string | null;
  payment_expires_at: string | null;
  payments?: PaymentBody[];
  payment_intent?: {
    id: string;
    client_secret: string | null;
    amount: number;
    currency: string;
    status: string;
    stripe_account: string;
    publishable_key: string;
    payment_id: string;
  } | null;
}

interface PaymentBody {
  id: string;
  object: string;
  booking_id: string | null;
  type: string;
  status: string;
  amount: number;
  currency: string;
  amount_refunded: number;
  provider: string;
  provider_payment_id: string | null;
  provider_account_id: string;
  parent_payment_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  client_secret: string | null;
  provider_status: string | null;
  metadata: Record<string, unknown>;
}

describe('payments', () => {
  let h: Harness;
  let stripe: FakeStripe;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  /** The rows a test reads back, through the privileged pool: RLS hides them from everyone else. */
  async function paymentRow(id: string): Promise<Record<string, unknown>> {
    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<Record<string, unknown>>(
      sql`SELECT * FROM payments WHERE id = ${decodeId('payment', id)}`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no such payment: ${id}`);
    return row;
  }

  async function paymentsOf(bookingId: string): Promise<Record<string, unknown>[]> {
    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<Record<string, unknown>>(sql`
      SELECT * FROM payments WHERE booking_id = ${decodeId('booking', bookingId)}
       ORDER BY created_at, id
    `);
    return rows;
  }

  /**
   * Moves a booking's payment deadline into the past, with admin SQL.
   *
   * The alternative would be to hand the task an instant thirty minutes in the future, and
   * that is what this exists to avoid: `runBookingTransitions` is **cross project** by
   * construction, so a far future `now` would also fire the automatic transitions of every
   * other suite's bookings on the shared test database. Ageing one row keeps the blast radius
   * to the booking under test while the task still runs its real discovery query at the real
   * instant, which is injected all the same.
   */
  async function agePaymentDeadline(bookingId: string): Promise<void> {
    const admin = createDatabase(h.pools.admin);
    await admin.execute(sql`
      UPDATE bookings
         SET payment_expires_at = now() - interval '1 minute',
             next_transition_at = now() - interval '1 minute'
       WHERE id = ${decodeId('booking', bookingId)} AND next_transition = 'expire_payment'
    `);
  }

  /** Attaches a connected Stripe account to a project and environment, as the OAuth flow would. */
  async function connect(projectId: string, environment: 'test' | 'live'): Promise<void> {
    const admin = createDatabase(h.pools.admin);
    await admin.execute(sql`
      INSERT INTO payment_provider_connections
        (id, project_id, environment, provider, provider_account_id, status, connected_at,
         livemode)
      VALUES (${uuidv7()}, ${decodeId('project', projectId)}, ${environment}, 'stripe',
              ${ACCOUNT}, 'connected', now(), ${environment === 'live'})
      ON CONFLICT (project_id, environment, provider) DO UPDATE
        SET status = 'connected', provider_account_id = ${ACCOUNT}, disconnected_at = NULL,
            disconnect_reason = NULL
    `);
  }

  /** A signed `POST` to the receiver, exactly as Stripe would send it. */
  async function sendEvent(
    event: Record<string, unknown>,
    options: { mode?: 'test' | 'live'; secret?: string; timestamp?: number; body?: string } = {},
  ): Promise<{ status: number; body: { received?: boolean; duplicate?: boolean } }> {
    const mode = options.mode ?? 'test';
    const raw = options.body ?? JSON.stringify(event);
    const t = options.timestamp ?? Math.floor(Date.now() / 1000);
    const secret = options.secret ?? (mode === 'live' ? WEBHOOK_SECRET_LIVE : WEBHOOK_SECRET_TEST);
    const signature = createHmac('sha256', secret)
      .update(`${String(t)}.${raw}`, 'utf8')
      .digest('hex');
    return h.call(`POST`, `/v1/stripe/webhook/${mode}`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${String(t)},v1=${signature}`,
      },
      body: JSON.parse(raw) as unknown,
    });
  }

  /** A `payment_intent.*` event about one of our intents, on the connected account. */
  function intentEvent(
    type: string,
    intent: Record<string, unknown>,
    options: { livemode?: boolean } = {},
  ): Record<string, unknown> {
    return {
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type,
      livemode: options.livemode ?? false,
      account: ACCOUNT,
      created: Math.floor(Date.now() / 1000),
      data: { object: { object: 'payment_intent', ...intent } },
    };
  }

  /** Books one slot of a fresh scenario with the given payment mode. */
  async function book(
    options: {
      policy?: Record<string, unknown>;
      price?: { amount: number; currency: string } | null;
      mode?: 'deposit' | 'full' | 'none';
      tokenOverride?: string;
    } = {},
  ): Promise<{ response: { status: number; body: BookingBody }; serviceId: string; slot: string }> {
    const useToken = options.tokenOverride ?? token;
    const scenario = await buildScenario(h, useToken, {
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      service:
        options.price === null ? {} : { price: options.price ?? { amount: 5000, currency: 'EUR' } },
    });
    const slot = await firstSlot(h, useToken, scenario.serviceId, monday, plusDays(monday, 1));
    const response = await h.call<BookingBody>('POST', '/v1/bookings', {
      token: useToken,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        payment: { mode: options.mode ?? 'deposit' },
      },
    });
    return { response, serviceId: scenario.serviceId, slot: slot.start };
  }

  beforeAll(async () => {
    stripe = await startFakeStripe();
    h = createHarness({ stripe: stripeConfig(stripe), allowPrivateWebhookTargets: true });
    p = await h.bootstrap('Payments project');
    token = p.testKey;
    monday = nextMonday();
    await connect(p.projectId, 'test');
  });

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  // --- Creating a payment -----------------------------------------------------------------------

  /**
   * The ordinary case, and the one every other test builds on: a deposit of 30% of a frozen
   * price of 50 EUR is 15 EUR, the booking is `pending` and holds its slot, and the front end
   * gets everything it needs to complete the payment in one response.
   */
  it('creates a pending booking with a deposit, an intent and a client secret', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('pending');
    expect(response.body.amount_due).toBe(1500);
    expect(response.body.amount_paid).toBe(0);
    expect(response.body.payment_expires_at).not.toBeNull();
    // Thirty minutes, the default of the deployment, from now. Asserted as a window rather
    // than an instant: the creation reads the clock once, and a test that demanded the exact
    // millisecond would be testing the scheduler of this machine.
    const deadline = new Date(response.body.payment_expires_at!).getTime();
    expect(deadline - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(response.body.next_transition).toBe('expire_payment');

    const intent = response.body.payment_intent;
    expect(intent).not.toBeNull();
    expect(intent!.id.startsWith('pi_')).toBe(true);
    expect(intent!.client_secret).toContain('_secret_');
    expect(intent!.amount).toBe(1500);
    expect(intent!.currency).toBe('EUR');
    expect(intent!.stripe_account).toBe(ACCOUNT);
    expect(intent!.publishable_key).toBe('pk_test_platform');
    expect(intent!.payment_id.startsWith('pay_')).toBe(true);

    // The row, and the identifier written back after the call.
    const rows = await paymentsOf(response.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('deposit');
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.amount).toBe(1500);
    expect(rows[0]!.provider_payment_id).toBe(intent!.id);
    expect(rows[0]!.provider_account_id).toBe(ACCOUNT);

    // And what was sent to Stripe: the account, the idempotency key, no application fee, no
    // payment method types, and the four pieces of metadata that tie the intent back to us.
    const created = stripe.of('/v1/payment_intents').at(-1)!;
    expect(created.headers['stripe-account']).toBe(ACCOUNT);
    expect(created.headers['idempotency-key']).toBe(intent!.payment_id);
    expect(created.form.amount).toBe('1500');
    expect(created.form.currency).toBe('eur');
    expect(created.form.capture_method).toBe('automatic');
    expect(created.body).not.toContain('application_fee_amount');
    expect(created.body).not.toContain('payment_method_types');
    expect(created.form['metadata[bookrail_booking_id]']).toBe(response.body.id);
    expect(created.form['metadata[bookrail_payment_id]']).toBe(intent!.payment_id);
    expect(created.form['metadata[bookrail_project_id]']).toBe(p.projectId);
    expect(created.form['metadata[bookrail_environment]']).toBe('test');
  });

  it('charges the whole frozen price with mode full', async () => {
    const { response } = await book({ mode: 'full', price: { amount: 2500, currency: 'EUR' } });
    expect(response.status).toBe(201);
    expect(response.body.amount_due).toBe(2500);
    expect(response.body.payment_intent?.amount).toBe(2500);
    expect((await paymentsOf(response.body.id))[0]!.type).toBe('full');
  });

  /**
   * The `Idempotency-Key` promise, and the one thing it must **not** promise.
   *
   * The same key answers the same booking, because that is what idempotency means. It answers
   * `client_secret: null`, because the middleware stores the body for twenty-four hours and a
   * secret stored and replayed is not a secret shown once. The route nominates the narrowed
   * body with `idempotencyResponseBody`, exactly as `POST /v1/webhooks` does with its signing
   * secret.
   */
  it('replays the booking without the client secret, and creates no second payment', async () => {
    const scenario = await buildScenario(h, token, {
      policy: { deposit: { type: 'fixed', value: 1000 } },
      service: { price: { amount: 5000, currency: 'EUR' } },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const key = `idem-${uuidv7()}`;
    const body = {
      service_id: scenario.serviceId,
      start: slot.start,
      payment: { mode: 'deposit' },
    };

    const first = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(201);
    expect(first.body.payment_intent?.client_secret).toContain('_secret_');

    const replay = await h.call<BookingBody>('POST', '/v1/bookings', {
      token,
      body,
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.payment_intent?.id).toBe(first.body.payment_intent?.id);
    expect(replay.body.payment_intent?.client_secret).toBeNull();

    // One booking, one payment, one intent.
    expect(await paymentsOf(first.body.id)).toHaveLength(1);

    // And the stored body itself carries no secret: the row, not the response.
    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<{ body: string }>(sql`
      SELECT response_body::text AS body FROM idempotency_keys WHERE key = ${key}
    `);
    expect(rows[0]?.body).not.toContain('_secret_');
  });

  // --- Reading a payment ------------------------------------------------------------------------

  it('reads the client secret back from Stripe, and lists without asking it anything', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 50 } } });
    const paymentId = response.body.payment_intent!.payment_id;

    const before = stripe.requests.length;
    const one = await h.call<PaymentBody>('GET', `/v1/payments/${paymentId}`, { token });
    expect(one.status).toBe(200);
    expect(one.body.object).toBe('payment');
    expect(one.body.booking_id).toBe(response.body.id);
    expect(one.body.type).toBe('deposit');
    expect(one.body.status).toBe('pending');
    expect(one.body.amount).toBe(2500);
    expect(one.body.client_secret).toBe(response.body.payment_intent!.client_secret);
    expect(one.body.provider_status).toBe('requires_payment_method');
    expect(stripe.requests.length).toBeGreaterThan(before);

    const afterRead = stripe.requests.length;
    const list = await h.call<{ data: PaymentBody[] }>(
      'GET',
      `/v1/payments?booking_id=${response.body.id}`,
      { token },
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]!.id).toBe(paymentId);
    // A list of twenty payments must not be twenty round trips to another company.
    expect(list.body.data[0]!.client_secret).toBeNull();
    expect(list.body.data[0]!.provider_status).toBeNull();
    expect(stripe.requests.length).toBe(afterRead);
  });

  it('expands the payments of a booking without calling Stripe', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 20 } } });
    const before = stripe.requests.length;
    const expanded = await h.call<BookingBody>(
      'GET',
      `/v1/bookings/${response.body.id}?expand[]=payments`,
      { token },
    );
    expect(expanded.status).toBe(200);
    expect(expanded.body.payments).toHaveLength(1);
    expect(expanded.body.payments![0]!.client_secret).toBeNull();
    expect(stripe.requests.length).toBe(before);
  });

  /**
   * Row Level Security, through the endpoint. Another project's payment is not "forbidden", it
   * is **not there**: the two answers are the same one deliberately, so that neither confirms
   * the existence of anything.
   */
  it('hides the payment of another project behind a 404', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 10 } } });
    const other = await h.bootstrap('Another payments project');
    const read = await h.call<ErrorBody>(
      'GET',
      `/v1/payments/${response.body.payment_intent!.payment_id}`,
      { token: other.testKey },
    );
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('resource_missing');
  });

  // --- The refusals -----------------------------------------------------------------------------

  it('refuses a payment when the project has connected no account', async () => {
    const other = await h.bootstrap('Unconnected project');
    const { response } = await book({
      tokenOverride: other.testKey,
      policy: { deposit: { type: 'percent', value: 30 } },
    });
    expect(response.status).toBe(409);
    const error = response.body as unknown as ErrorBody;
    expect(error.error.code).toBe('stripe_not_connected');
    expect(error.error.fix).toContain('bookrail stripe connect');
  });

  it('refuses a deposit the policy does not define, and a price the service does not have', async () => {
    const noDeposit = await book({ policy: { hold_duration_seconds: 300 } });
    expect(noDeposit.response.status).toBe(400);
    expect((noDeposit.response.body as unknown as ErrorBody).error.code).toBe(
      'deposit_not_configured',
    );

    const noPrice = await book({ mode: 'full', price: null });
    expect(noPrice.response.status).toBe(400);
    const error = noPrice.response.body as unknown as ErrorBody;
    expect(error.error.code).toBe('price_missing');
    expect(error.error.param).toBe('service_id');
  });

  it('refuses an amount of zero and says to use mode none', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 0 } } });
    expect(response.status).toBe(400);
    const error = response.body as unknown as ErrorBody;
    expect(error.error.code).toBe('payment_amount_invalid');
    expect(error.error.fix).toContain('none');
  });

  /**
   * Stripe refuses the intent. The booking existed for a moment and must not survive: it holds
   * a slot nobody is going to pay for, and the caller has to be told which booking is gone.
   */
  it('cancels the booking and frees the slot when Stripe refuses the intent', async () => {
    stripe.failWith = {
      path: '/v1/payment_intents',
      status: 402,
      body: {
        error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
      },
    };
    let created;
    try {
      created = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    } finally {
      stripe.failWith = null;
    }
    expect(created.response.status).toBe(502);
    const error = created.response.body as unknown as ErrorBody;
    expect(error.error.code).toBe('stripe_provider_error');
    expect(error.error.message).toContain('was cancelled and its slot released');

    // The booking exists and is cancelled, the payment is failed, and the slot is bookable.
    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<{ status: string; id: string }>(sql`
      SELECT b.id, b.status FROM bookings b
       WHERE b.service_id = ${decodeId('service', created.serviceId)}
       ORDER BY b.created_at DESC LIMIT 1
    `);
    expect(rows[0]?.status).toBe('cancelled');
    const slots = await h.call<{ slots: { start: string }[] }>('POST', '/v1/availability', {
      token,
      body: {
        service_id: created.serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      },
    });
    expect(slots.body.slots.map((s) => s.start)).toContain(created.slot);
  });

  // --- The webhook receiver ---------------------------------------------------------------------

  /**
   * The central test: the money arrives, the booking is confirmed, the counters move, and two
   * events are written **and delivered** to the project's own endpoint.
   */
  it('confirms the booking when the payment succeeds, and delivers both events', async () => {
    let receiver: TestReceiver | undefined;
    try {
      receiver = await startReceiver();
      const endpoint = await h.call<{ id: string }>('POST', '/v1/webhooks', {
        token,
        body: { url: receiver.url, events: ['booking.confirmed', 'payment.succeeded'] },
      });
      expect(endpoint.status).toBe(201);

      const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
      const intentId = response.body.payment_intent!.id;
      const paymentId = response.body.payment_intent!.payment_id;
      stripe.succeed(intentId, 1500);

      const received = await sendEvent(
        intentEvent('payment_intent.succeeded', {
          id: intentId,
          amount: 1500,
          amount_received: 1500,
          currency: 'eur',
          status: 'succeeded',
        }),
      );
      expect(received.status).toBe(200);
      expect(received.body).toEqual({ received: true });

      const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, {
        token,
      });
      expect(booking.body.status).toBe('confirmed');
      expect(booking.body.amount_paid).toBe(1500);
      expect(booking.body.amount_due).toBe(0);
      expect(booking.body.payment_expires_at).toBeNull();
      expect(booking.body.next_transition).toBeNull();
      expect((await paymentRow(paymentId)).status).toBe('succeeded');

      await settleEventLog(h);
      const events = await h.call<{
        data: { type: string; data: { object: Record<string, unknown> } }[];
      }>('GET', '/v1/events?limit=100', { token });
      const mine = events.body.data.filter(
        (event) => event.data.object.id === response.body.id || event.data.object.id === paymentId,
      );
      expect(mine.map((event) => event.type)).toContain('booking.confirmed');
      expect(mine.map((event) => event.type)).toContain('payment.succeeded');

      // Delivered, not merely written: the outbox turns them into deliveries and the delivery
      // worker sends them to the customer's own endpoint.
      const { runWebhookOutbox } = await import('../src/webhooks/outbox.js');
      const { runWebhookDeliveries } = await import('../src/webhooks/dispatch.js');
      const deps = {
        db: createDatabase(h.pools.app),
        cache: h.cache,
        logger: h.logger,
        webhookSecretKey: h.webhookSecretKey,
      };
      await runWebhookOutbox(deps);
      await runWebhookDeliveries(deps, { allowPrivateTargets: true, allowAnyPort: true });
      const delivered = receiver.requests.map(
        (request) => (JSON.parse(request.body) as { type: string }).type,
      );
      expect(delivered).toContain('payment.succeeded');
      expect(delivered).toContain('booking.confirmed');
    } finally {
      await receiver?.close();
    }
  });

  /**
   * A redelivery of the same event does nothing at all. It is the property the whole
   * `payment_provider_events` table exists for: applying `payment_intent.succeeded` twice
   * would add the amount to `amount_paid` twice, which is the one class of bug a payment
   * system may not have.
   */
  it('answers a redelivery with duplicate: true and moves no money', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 40 } } });
    const intentId = response.body.payment_intent!.id;
    stripe.succeed(intentId, 2000);
    const event = intentEvent('payment_intent.succeeded', {
      id: intentId,
      amount: 2000,
      amount_received: 2000,
      currency: 'eur',
      status: 'succeeded',
    });

    expect((await sendEvent(event)).body).toEqual({ received: true });
    const afterFirst = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, {
      token,
    });
    expect(afterFirst.body.amount_paid).toBe(2000);

    const again = await sendEvent(event);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });

    const afterSecond = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, {
      token,
    });
    expect(afterSecond.body.amount_paid).toBe(2000);
  });

  /**
   * A forged request. Nothing is written, claim row included, and the refusal is a `400` rather
   * than a `500`: a verifier that threw on a hostile payload would turn every forgery into an
   * alert about our own code.
   */
  it('refuses an event whose signature does not match, and writes nothing', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    const event = intentEvent('payment_intent.succeeded', {
      id: response.body.payment_intent!.id,
      amount: 1500,
      amount_received: 1500,
      currency: 'eur',
      status: 'succeeded',
    });

    const forged = await sendEvent(event, { secret: 'whsec_notTheSecretAtAll' });
    expect(forged.status).toBe(400);
    expect((forged.body as unknown as ErrorBody).error.code).toBe('stripe_signature_invalid');

    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM payment_provider_events
       WHERE provider_event_id = ${event.id as string}
    `);
    expect(rows[0]?.n).toBe(0);

    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.amount_paid).toBe(0);
    expect(booking.body.status).toBe('pending');
  });

  it('refuses a test event that arrives at the live endpoint', async () => {
    const event = intentEvent('payment_intent.succeeded', { id: 'pi_whatever' }, {});
    const wrong = await sendEvent(event, { mode: 'live' });
    expect(wrong.status).toBe(400);
  });

  /**
   * An event about an intent this deployment never created. Recorded, so that "did we see it"
   * has an answer, and acted on by nothing. It is also the one success answer the live path
   * gets in this suite, which is what keeps its response schema proven.
   */
  it('records an unattributable event as unmatched and does nothing with it', async () => {
    const event = intentEvent(
      'payment_intent.succeeded',
      { id: 'pi_neverCreatedHere', amount: 100, amount_received: 100, status: 'succeeded' },
      { livemode: true },
    );
    const received = await sendEvent(event, { mode: 'live' });
    expect(received.status).toBe(200);
    expect(received.body).toEqual({ received: true });

    const admin = createDatabase(h.pools.admin);
    const { rows } = await admin.execute<{ project_id: string | null; outcome: string }>(sql`
      SELECT project_id, outcome FROM payment_provider_events
       WHERE provider_event_id = ${event.id as string}
    `);
    expect(rows[0]?.project_id).toBeNull();
    expect(rows[0]?.outcome).toBe('unmatched');
  });

  it('records a failed attempt, keeps the payment pending, and emits payment.failed', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    const paymentId = response.body.payment_intent!.payment_id;

    const received = await sendEvent(
      intentEvent('payment_intent.payment_failed', {
        id: response.body.payment_intent!.id,
        amount: 1500,
        amount_received: 0,
        currency: 'eur',
        status: 'requires_payment_method',
        last_payment_error: {
          type: 'card_error',
          code: 'card_declined',
          message: 'Your card was declined.',
        },
      }),
    );
    expect(received.status).toBe(200);

    const row = await paymentRow(paymentId);
    expect(row.failure_code).toBe('card_declined');
    expect(row.failure_message).toBe('Your card was declined.');
    // Still `pending`: the same intent survives a refused card, and the customer may try
    // another one until the booking's deadline.
    expect(row.status).toBe('pending');

    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.status).toBe('pending');
    expect(booking.body.amount_paid).toBe(0);

    await settleEventLog(h);
    const events = await h.call<{ data: { type: string; data: { object: { id: string } } }[] }>(
      'GET',
      '/v1/events?limit=100',
      { token },
    );
    expect(
      events.body.data.some(
        (event) => event.type === 'payment.failed' && event.data.object.id === paymentId,
      ),
    ).toBe(true);
  });

  /**
   * A policy that asks somebody to accept the booking. Being paid does not accept it for them:
   * the booking stays `pending`, now confirmable by hand, and the deadline is cleared because
   * the wait for **money** is over.
   */
  it('leaves a booking pending when the frozen policy requires a confirmation', async () => {
    const { response } = await book({
      policy: { deposit: { type: 'percent', value: 30 }, require_provider_confirmation: true },
    });
    const intentId = response.body.payment_intent!.id;
    stripe.succeed(intentId, 1500);
    await sendEvent(
      intentEvent('payment_intent.succeeded', {
        id: intentId,
        amount: 1500,
        amount_received: 1500,
        currency: 'eur',
        status: 'succeeded',
      }),
    );

    const paid = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(paid.body.status).toBe('pending');
    expect(paid.body.amount_paid).toBe(1500);
    expect(paid.body.payment_expires_at).toBeNull();
    expect(paid.body.next_transition).toBeNull();

    const confirmed = await h.call<BookingBody>(
      'POST',
      `/v1/bookings/${response.body.id}/confirm`,
      { token },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
  });

  it('refuses a manual confirm while the payment is still in flight', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    const refused = await h.call<ErrorBody>('POST', `/v1/bookings/${response.body.id}/confirm`, {
      token,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('payment_pending');
    expect(refused.body.error.fix).toContain('cancel');
  });

  it('refuses to reschedule a booking that has money on it', async () => {
    const { response, serviceId } = await book({
      policy: { deposit: { type: 'percent', value: 30 } },
    });
    const slots = await h.call<{ slots: { start: string }[] }>('POST', '/v1/availability', {
      token,
      body: {
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      },
    });
    const elsewhere = slots.body.slots[1]!.start;
    const refused = await h.call<ErrorBody>('POST', `/v1/bookings/${response.body.id}/reschedule`, {
      token,
      body: { start: elsewhere },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('reschedule_not_supported');
    expect(refused.body.error.param).toBe('reschedule');
  });

  // --- Refunds ----------------------------------------------------------------------------------

  /**
   * The whole refund path: a cancellation the policy pays back in full, the row queued inside
   * the cancelling transaction, the call made by the worker **outside** every transaction, and
   * the counters moved only when Stripe says the money went back.
   */
  it('queues a refund on cancellation, executes it in the worker, and settles it on charge.refunded', async () => {
    const { response } = await book({
      policy: {
        deposit: { type: 'percent', value: 100 },
        cancellation: [{ before: '1h', refund_percent: 100 }],
      },
    });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;
    stripe.succeed(intentId, 5000);
    await sendEvent(
      intentEvent('payment_intent.succeeded', {
        id: intentId,
        amount: 5000,
        amount_received: 5000,
        currency: 'eur',
        status: 'succeeded',
      }),
    );

    const cancelled = await h.call<BookingBody>('POST', `/v1/bookings/${response.body.id}/cancel`, {
      token,
      body: { reason: 'changed my mind' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.refund_percent).toBe(100);
    expect(cancelled.body.refund_amount_expected).toBe(5000);

    // The refund row exists, is queued, and has made no call yet.
    const rows = await paymentsOf(response.body.id);
    const refund = rows.find((row) => row.type === 'refund')!;
    expect(refund).toBeDefined();
    expect(refund.status).toBe('pending');
    expect(refund.amount).toBe(5000);
    expect(refund.pending_action).toBe('create_refund');
    expect(refund.provider_payment_id).toBeNull();
    expect(stripe.of('/v1/refunds')).toHaveLength(0);

    // One tick of the worker.
    const report = await runPaymentActions({
      db: createDatabase(h.pools.app),
      logger: h.logger,
      stripe: stripeConfig(stripe),
    });
    expect(report.done).toBeGreaterThanOrEqual(1);
    const call = stripe.of('/v1/refunds').at(-1)!;
    expect(call.headers['stripe-account']).toBe(ACCOUNT);
    expect(call.headers['idempotency-key']).toBe(
      `pay_${String(refund.id as string).replaceAll('-', '')}`,
    );
    expect(call.form.payment_intent).toBe(intentId);
    expect(call.form.amount).toBe('5000');

    const withId = await paymentRow(`pay_${String(refund.id as string).replaceAll('-', '')}`);
    expect((withId.provider_payment_id as string).startsWith('re_')).toBe(true);
    // Still `pending`: what makes a refund succeeded is the verified event, never our own call.
    expect(withId.status).toBe('pending');
    expect(withId.pending_action).toBeNull();

    // And the event that settles it.
    const settled = await sendEvent({
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type: 'charge.refunded',
      livemode: false,
      account: ACCOUNT,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: 'charge',
          id: 'ch_fake',
          payment_intent: intentId,
          amount: 5000,
          amount_refunded: 5000,
          refunded: true,
        },
      },
    });
    expect(settled.status).toBe(200);

    expect((await paymentRow(paymentId)).amount_refunded).toBe(5000);
    expect((await paymentRow(paymentId)).status).toBe('refunded');
    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.amount_refunded).toBe(5000);

    await settleEventLog(h);
    const events = await h.call<{ data: { type: string; data: { object: { id: string } } }[] }>(
      'GET',
      '/v1/events?limit=100',
      { token },
    );
    expect(events.body.data.some((event) => event.type === 'payment.refunded')).toBe(true);
  });

  /**
   * A refund made from the customer's own Stripe dashboard, which Bookrail never asked for.
   * The numbers on the booking are about the money, not about who moved it, so a child row is
   * created at the moment the event arrives and the counters follow.
   */
  it('records a refund made outside Bookrail, with origin provider', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;
    stripe.succeed(intentId, 5000);
    await sendEvent(
      intentEvent('payment_intent.succeeded', {
        id: intentId,
        amount: 5000,
        amount_received: 5000,
        currency: 'eur',
        status: 'succeeded',
      }),
    );

    await sendEvent({
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type: 'charge.refunded',
      livemode: false,
      account: ACCOUNT,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: 'charge',
          id: 'ch_dashboard',
          payment_intent: intentId,
          amount: 5000,
          // A partial refund, which is what a person clicking in the dashboard usually makes.
          amount_refunded: 2000,
          refunded: false,
        },
      },
    });

    expect((await paymentRow(paymentId)).amount_refunded).toBe(2000);
    // Not `refunded`: only part of it came back.
    expect((await paymentRow(paymentId)).status).toBe('succeeded');
    const rows = await paymentsOf(response.body.id);
    const child = rows.find((row) => row.type === 'refund')!;
    expect(child.amount).toBe(2000);
    expect(child.status).toBe('succeeded');
    expect(child.provider_payment_id).toBeNull();
    expect((child.metadata as Record<string, unknown>).origin).toBe('provider');
    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.amount_refunded).toBe(2000);
  });

  // --- The expiry -------------------------------------------------------------------------------

  /**
   * The deadline, with the instant injected. Nothing waits for thirty minutes: `now` is a
   * parameter of the task, which is what makes the assertion exact instead of slow.
   */
  it('expires a booking whose payment never arrived, and cancels its intent', async () => {
    const { response, serviceId, slot } = await book({
      policy: { deposit: { type: 'percent', value: 30 } },
    });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;
    await agePaymentDeadline(response.body.id);

    const deps = { db: createDatabase(h.pools.app), cache: h.cache, logger: h.logger };
    const report = await runBookingTransitions(deps, { now: Date.now() });
    expect(report.applied).toBeGreaterThanOrEqual(1);

    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.status).toBe('cancelled');
    expect(booking.body.cancelled_by).toBe('system');
    expect(booking.body.cancellation_reason).toBe('payment_timeout');
    expect(booking.body.refund_percent).toBe(0);
    expect(booking.body.refund_amount_expected).toBe(0);
    expect(booking.body.payment_expires_at).toBeNull();

    // The intent cancellation is queued, and executed by the worker.
    expect((await paymentRow(paymentId)).pending_action).toBe('cancel_intent');
    await runPaymentActions({
      db: createDatabase(h.pools.app),
      logger: h.logger,
      stripe: stripeConfig(stripe),
    });
    expect(stripe.intent(intentId)?.status).toBe('canceled');
    const row = await paymentRow(paymentId);
    expect(row.status).toBe('cancelled');
    expect(row.pending_action).toBeNull();

    // The slot is back on the market.
    const slots = await h.call<{ slots: { start: string }[] }>('POST', '/v1/availability', {
      token,
      body: {
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      },
    });
    expect(slots.body.slots.map((s) => s.start)).toContain(slot);
  });

  /**
   * The race the expiry can lose: the money arrived between the scheduler selecting the
   * booking and the row lock. `amount_paid` is the evidence, and the answer is to do nothing,
   * because cancelling here would take a slot away from a customer who has just bought it.
   */
  it('does not expire a booking that has been paid for in the meantime', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    const intentId = response.body.payment_intent!.id;
    await agePaymentDeadline(response.body.id);
    stripe.succeed(intentId, 1500);
    await sendEvent(
      intentEvent('payment_intent.succeeded', {
        id: intentId,
        amount: 1500,
        amount_received: 1500,
        currency: 'eur',
        status: 'succeeded',
      }),
    );

    const deps = { db: createDatabase(h.pools.app), cache: h.cache, logger: h.logger };
    await runBookingTransitions(deps, { now: Date.now() });

    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.status).toBe('confirmed');
    expect(booking.body.amount_paid).toBe(1500);
  });

  /**
   * The other half of the same race, and the one that would keep a customer's money for a slot
   * that no longer exists: the payment succeeds **after** the booking is gone. The money is
   * still recorded as received, a full refund is queued, and the event says so.
   */
  it('refunds in full when a payment succeeds after the booking was cancelled', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;

    const cancelled = await h.call<BookingBody>('POST', `/v1/bookings/${response.body.id}/cancel`, {
      token,
      body: { reason: 'too slow' },
    });
    expect(cancelled.body.status).toBe('cancelled');

    stripe.succeed(intentId, 1500);
    await sendEvent(
      intentEvent('payment_intent.succeeded', {
        id: intentId,
        amount: 1500,
        amount_received: 1500,
        currency: 'eur',
        status: 'succeeded',
      }),
    );

    expect((await paymentRow(paymentId)).status).toBe('succeeded');
    const rows = await paymentsOf(response.body.id);
    const refund = rows.find((row) => row.type === 'refund')!;
    expect(refund).toBeDefined();
    expect(refund.amount).toBe(1500);
    expect(refund.pending_action).toBe('create_refund');

    await settleEventLog(h);
    const events = await h.call<{
      data: { type: string; data: { object: Record<string, unknown> } }[];
    }>('GET', '/v1/events?limit=100', { token });
    const succeeded = events.body.data.find(
      (event) => event.type === 'payment.succeeded' && event.data.object.id === paymentId,
    );
    expect(succeeded).toBeDefined();
    expect(succeeded!.data.object.booking_status).toBe('cancelled');
  });

  /**
   * The two of them at once, in one process, on one booking.
   *
   * The scheduler has selected this booking as due and the webhook is arriving: both are
   * transactions that lock the same booking row, and exactly one of the two outcomes is legal.
   * What must never happen is the third: a `cancelled` booking with `amount_paid > 0` and no
   * refund queued, which is money taken for a slot that was given away.
   *
   * Run ten times, because a race that is won the same way every time on one machine is not a
   * race that has been tested; the assertion is about the **set** of legal outcomes, not about
   * which one wins.
   */
  it('never leaves money on a cancelled booking when the expiry and the payment race', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { response } = await book({ policy: { deposit: { type: 'percent', value: 30 } } });
      const intentId = response.body.payment_intent!.id;
      const paymentId = response.body.payment_intent!.payment_id;
      await agePaymentDeadline(response.body.id);
      stripe.succeed(intentId, 1500);

      const deps = { db: createDatabase(h.pools.app), cache: h.cache, logger: h.logger };
      await Promise.all([
        runBookingTransitions(deps, { now: Date.now() }),
        sendEvent(
          intentEvent('payment_intent.succeeded', {
            id: intentId,
            amount: 1500,
            amount_received: 1500,
            currency: 'eur',
            status: 'succeeded',
          }),
        ),
      ]);

      const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, {
        token,
      });
      const where = `attempt ${String(attempt)} booking ${response.body.id}`;
      // Exactly two outcomes are legal, and they are the two halves of the same race.
      expect(['confirmed', 'cancelled'], where).toContain(booking.body.status);
      if (booking.body.status === 'confirmed') {
        expect(booking.body.amount_paid, where).toBe(1500);
        expect(booking.body.amount_due, where).toBe(0);
      } else {
        expect(booking.body.cancellation_reason, where).toBe('payment_timeout');
        // The invariant: if the money arrived anyway, a refund of it is queued. Never a
        // cancellation that kept the money.
        if (booking.body.amount_paid > 0) {
          const rows = await paymentsOf(response.body.id);
          const refund = rows.find((row) => row.type === 'refund');
          expect(refund, `${where}: cancelled with money and no refund queued`).toBeDefined();
          expect(refund!.amount, where).toBe(booking.body.amount_paid);
        } else {
          // The expiry won outright, so the payment is on its way to being cancelled.
          const row = await paymentRow(paymentId);
          expect([row.pending_action, row.status], where).toContain('cancel_intent');
        }
      }
    }
  });

  // --- The deauthorisation ----------------------------------------------------------------------

  /**
   * The customer revoked us from their own Stripe dashboard. Until this release nothing wrote
   * `disconnect_reason = 'deauthorized'`, and a revoked project stayed `connected` in our
   * database for ever.
   */
  it('disconnects the connection when Stripe says the application was deauthorized', async () => {
    const other = await h.bootstrap('Deauthorized project');
    const admin = createDatabase(h.pools.admin);
    const account = `acct_1Deauthorized${String(Date.now())}`;
    await admin.execute(sql`
      INSERT INTO payment_provider_connections
        (id, project_id, environment, provider, provider_account_id, status, connected_at,
         livemode)
      VALUES (${uuidv7()}, ${decodeId('project', other.projectId)}, 'test', 'stripe',
              ${account}, 'connected', now(), false)
    `);

    const received = await sendEvent({
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type: 'account.application.deauthorized',
      livemode: false,
      account,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'ca_fake', object: 'application', name: 'Bookrail' } },
    });
    expect(received.status).toBe(200);

    const connection = await h.call<{ status: string; disconnect_reason: string | null }>(
      'GET',
      '/v1/stripe',
      { token: other.testKey },
    );
    expect(connection.body.status).toBe('disconnected');
    expect(connection.body.disconnect_reason).toBe('deauthorized');

    await settleEventLog(h);
    const events = await h.call<{ data: { type: string }[] }>('GET', '/v1/events?limit=50', {
      token: other.testKey,
    });
    expect(events.body.data.some((event) => event.type === 'stripe.disconnected')).toBe(true);
  });

  it('reports whether the incoming webhook secret is configured', async () => {
    const connection = await h.call<{ webhook_configured: boolean }>('GET', '/v1/stripe', {
      token,
    });
    expect(connection.body.webhook_configured).toBe(true);
  });

  // --- The one line that must never exist -------------------------------------------------------

  /**
   * No secret, in any form, in any log line or any response of this suite.
   *
   * The scan covers the whole file through a harness of its own, for the reason the Stripe
   * suite scans its own: a secret leaks through a log line nobody was looking at, so the check
   * has to be about every line rather than about the lines a test happened to read.
   */
  it('never writes a platform key, a webhook secret or a client secret to the log', async () => {
    const lines: string[] = [];
    const noisy = createHarness({
      stripe: stripeConfig(stripe),
      logger: {
        debug: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        info: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        warn: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        error: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        child() {
          return this;
        },
      },
    });
    try {
      const project = await noisy.bootstrap('Noisy payments project');
      await connect(project.projectId, 'test');
      const scenario = await buildScenario(noisy, project.testKey, {
        policy: { deposit: { type: 'percent', value: 30 } },
        service: { price: { amount: 5000, currency: 'EUR' } },
      });
      const slot = await firstSlot(
        noisy,
        project.testKey,
        scenario.serviceId,
        monday,
        plusDays(monday, 1),
      );
      const created = await noisy.call<BookingBody>('POST', '/v1/bookings', {
        token: project.testKey,
        body: {
          service_id: scenario.serviceId,
          start: slot.start,
          payment: { mode: 'deposit' },
        },
      });
      expect(created.status).toBe(201);
      await noisy.call('GET', `/v1/payments/${created.body.payment_intent!.payment_id}`, {
        token: project.testKey,
      });
      // A forged webhook, which is the request most likely to log something it should not.
      await noisy.call('POST', '/v1/stripe/webhook/test', {
        headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
        body: { id: 'evt_forged', type: 'payment_intent.succeeded' },
      });

      const joined = lines.join('\n');
      for (const needle of [
        PLATFORM_TEST_KEY,
        PLATFORM_LIVE_KEY,
        WEBHOOK_SECRET_TEST,
        WEBHOOK_SECRET_LIVE,
        '_secret_',
        'sk_',
        'rk_',
        'whsec_',
      ]) {
        expect(joined, `a log line contains ${needle}`).not.toContain(needle);
      }
    } finally {
      await noisy.close();
    }
  });

  // --- The retry ladder, and the end of it ------------------------------------------------------

  /**
   * A row that has failed twenty times leaves the queue, and stays left.
   *
   * `pending_action_next_at` carries two facts that must never be confused: "may be tried from
   * this instant" and, as NULL, "the ladder ran out". An earlier form of this code wrote NULL
   * when queueing as well, which made an exhausted row indistinguishable from a fresh one: the
   * worker picked it up again on the next tick, called Stripe again, exhausted it again and
   * logged it again, six times a minute for ever.
   *
   * So this walks the whole ladder with the instant injected, and then asserts the thing that
   * actually matters: the twenty-first tick makes **no call at all**.
   */
  it('stops calling Stripe once a payment action has exhausted its retries', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    stripe.succeed(intentId, 5000);
    await sendEvent(
      intentEvent('payment_intent.succeeded', { id: intentId, amount_received: 5000 }),
    );

    // Drain whatever other tests of this shared database left queued, so that the refusal armed
    // next meets this row and nothing else.
    await runPaymentActions(
      { db: createDatabase(h.pools.app), logger: h.logger, stripe: stripeConfig(stripe) },
      { now: Date.now() },
    );
    // Armed **before** the cancellation, so the refund it queues is refused from its very first
    // attempt and the ladder starts at one.
    stripe.failWith = {
      path: '/v1/refunds',
      status: 500,
      body: { error: { type: 'api_error', message: 'Stripe is having a bad day.' } },
    };
    await h.call('POST', `/v1/bookings/${response.body.id}/cancel`, {
      token,
      body: { by: 'provider' },
    });
    const refund = (await paymentsOf(response.body.id)).find((row) => row.type === 'refund')!;
    const refundId = `pay_${String(refund.id as string).replaceAll('-', '')}`;

    const deps = {
      db: createDatabase(h.pools.app),
      logger: h.logger,
      stripe: stripeConfig(stripe),
    };
    // The worker is cross project by construction and this suite shares one database, so every
    // count below is filtered to this row's own `Idempotency-Key`. Counting every call to
    // `/v1/refunds` would be counting other tests.
    const callsForThisRow = (): number =>
      stripe.of('/v1/refunds').filter((call) => call.headers['idempotency-key'] === refundId)
        .length;

    try {
      // Twenty ticks, each one at the instant the previous failure asked for. The instant is
      // injected rather than waited for: the ladder reaches an hour between attempts, and a
      // test that slept through it would take a day.
      let now = Date.now();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const before = callsForThisRow();
        await runPaymentActions(deps, { now });
        expect(callsForThisRow() - before, `tick ${String(attempt)}`).toBe(1);
        const row = await paymentRow(refundId);
        expect(row.pending_action_attempts, `tick ${String(attempt)}`).toBe(attempt);
        if (attempt < MAX_ATTEMPTS) {
          expect(row.pending_action_next_at, `tick ${String(attempt)}`).not.toBeNull();
          now = new Date(row.pending_action_next_at as string).getTime();
        }
      }
      expect(callsForThisRow()).toBe(MAX_ATTEMPTS);

      // Exhausted: the row keeps what it owes and why, and loses only its place in the queue.
      const exhausted = await paymentRow(refundId);
      expect(exhausted.pending_action).toBe('create_refund');
      expect(exhausted.pending_action_next_at).toBeNull();
      expect(exhausted.pending_action_attempts).toBe(MAX_ATTEMPTS);
      expect(exhausted.pending_action_error).not.toBeNull();

      // The twenty-first tick, and a hundred years after it, do nothing at all to this row.
      // This is the assertion the whole test exists for: before the correction, NULL also meant
      // "due now", so every one of these would have called Stripe again.
      for (const at of [now, now + 3_600_000, now + 100 * 365 * 24 * 3_600_000]) {
        await runPaymentActions(deps, { now: at });
      }
      expect(callsForThisRow()).toBe(MAX_ATTEMPTS);
      const still = await paymentRow(refundId);
      expect(still.pending_action_attempts).toBe(MAX_ATTEMPTS);
      expect(still.pending_action).toBe('create_refund');
    } finally {
      stripe.failWith = null;
    }
  });

  // --- The two refusals that are not failures ---------------------------------------------------

  /**
   * Cancelling an intent that Stripe has already captured is not an error.
   *
   * It means the customer paid in the window between the cancellation and the call. The row is
   * left alone, without an action and without a ladder, because `payment_intent.succeeded` is
   * already on its way and the receiver will queue the full refund the situation calls for.
   *
   * What the worker reads to know this is `error.payment_intent.status`, a documented enum, and
   * not the English of the message beside it.
   */
  it('leaves a payment alone when the intent it was told to cancel has already succeeded', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;

    await agePaymentDeadline(response.body.id);
    await runBookingTransitions(
      { db: createDatabase(h.pools.app), cache: h.cache, logger: h.logger },
      { now: Date.now() },
    );
    expect((await paymentRow(paymentId)).pending_action).toBe('cancel_intent');

    // The money landed first, so the cancellation Stripe is about to be asked for is refused.
    stripe.succeed(intentId, 5000);
    await runPaymentActions(
      { db: createDatabase(h.pools.app), logger: h.logger, stripe: stripeConfig(stripe) },
      { now: Date.now() },
    );

    // Asserted on this row and not on the report's counters: the worker is cross project and
    // this database is shared, so the totals belong to the whole suite.
    const row = await paymentRow(paymentId);
    expect(row.status).toBe('pending');
    expect(row.pending_action).toBeNull();
    expect(row.pending_action_next_at).toBeNull();
  });

  /** The other refusal: the intent was already cancelled, which is the state that was asked for. */
  it('closes the payment when the intent it was told to cancel is already cancelled', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;

    await agePaymentDeadline(response.body.id);
    await runBookingTransitions(
      { db: createDatabase(h.pools.app), cache: h.cache, logger: h.logger },
      { now: Date.now() },
    );

    stripe.cancel(intentId);
    await runPaymentActions(
      { db: createDatabase(h.pools.app), logger: h.logger, stripe: stripeConfig(stripe) },
      { now: Date.now() },
    );

    const row = await paymentRow(paymentId);
    expect(row.status).toBe('cancelled');
    expect(row.pending_action).toBeNull();
  });

  // --- The refund is recomputed against the parent at the moment of the call ---------------------

  /**
   * A refund queued for 1500, a customer who gives back 500 from their own dashboard, and a
   * worker that must now ask for 1000 rather than for 1500.
   *
   * The amount written when the booking was cancelled is a snapshot of what was owed then.
   * Between that instant and the call, the receiver may have raised the parent's
   * `amount_refunded` because the customer refunded part of the charge themselves, and it
   * deliberately leaves the queued row alone. Asking for the old amount would exceed what the
   * charge still has, Stripe would refuse it, and the residue actually owed would never go back.
   */
  it('recomputes a queued refund against what the parent still owes', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;
    stripe.succeed(intentId, 5000);
    await sendEvent(
      intentEvent('payment_intent.succeeded', { id: intentId, amount_received: 5000 }),
    );

    await h.call('POST', `/v1/bookings/${response.body.id}/cancel`, {
      token,
      body: { by: 'provider' },
    });
    const queued = (await paymentsOf(response.body.id)).find(
      (row) => row.type === 'refund' && row.pending_action === 'create_refund',
    )!;
    expect(queued.amount).toBe(5000);

    // The customer gives back 2000 from their own Stripe dashboard before the worker runs.
    await sendEvent({
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type: 'charge.refunded',
      livemode: false,
      account: ACCOUNT,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: 'charge',
          id: 'ch_fake_partial',
          payment_intent: intentId,
          amount: 5000,
          amount_refunded: 2000,
          refunded: false,
        },
      },
    });
    expect((await paymentRow(paymentId)).amount_refunded).toBe(2000);

    // Now the tick. What is asked of Stripe is the residue, not the stale number.
    const refundId = `pay_${String(queued.id as string).replaceAll('-', '')}`;
    await runPaymentActions(
      { db: createDatabase(h.pools.app), logger: h.logger, stripe: stripeConfig(stripe) },
      { now: Date.now() },
    );
    const call = stripe
      .of('/v1/refunds')
      .filter((request) => request.headers['idempotency-key'] === refundId)
      .at(-1)!;
    expect(call, 'the worker asked Stripe for this refund').toBeDefined();
    expect(call.form.amount).toBe('3000');

    // And the row says what was actually asked for, so the event that settles it still matches.
    const row = await paymentRow(refundId);
    expect(row.amount).toBe(3000);
    expect(row.pending_action).toBeNull();
  });

  /** The whole charge came back from the dashboard: there is nothing left to ask, and no call. */
  it('closes a queued refund without calling Stripe when nothing is left to refund', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;
    stripe.succeed(intentId, 5000);
    await sendEvent(
      intentEvent('payment_intent.succeeded', { id: intentId, amount_received: 5000 }),
    );
    await h.call('POST', `/v1/bookings/${response.body.id}/cancel`, {
      token,
      body: { by: 'provider' },
    });
    const queued = (await paymentsOf(response.body.id)).find(
      (row) => row.type === 'refund' && row.pending_action === 'create_refund',
    )!;

    // Two partial refunds from the dashboard, neither of which matches the queued row: a child
    // is only settled when its amount fits inside the delta, and 5000 fits in neither 3000 nor
    // the 2000 that follows. So the parent ends fully refunded while our row is still waiting,
    // which is exactly the state this test is about.
    for (const [id, cumulative] of [
      ['ch_fake_part_one', 3000],
      ['ch_fake_part_two', 5000],
    ] as const) {
      await sendEvent({
        id: `evt_${uuidv7().replaceAll('-', '')}`,
        object: 'event',
        type: 'charge.refunded',
        livemode: false,
        account: ACCOUNT,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            object: 'charge',
            id,
            payment_intent: intentId,
            amount: 5000,
            amount_refunded: cumulative,
            refunded: cumulative >= 5000,
          },
        },
      });
    }
    expect((await paymentRow(paymentId)).amount_refunded).toBe(5000);
    const stillQueued = await paymentRow(`pay_${String(queued.id as string).replaceAll('-', '')}`);
    expect(stillQueued.pending_action).toBe('create_refund');

    const refundId = `pay_${String(queued.id as string).replaceAll('-', '')}`;
    await runPaymentActions(
      { db: createDatabase(h.pools.app), logger: h.logger, stripe: stripeConfig(stripe) },
      { now: Date.now() },
    );
    expect(
      stripe.of('/v1/refunds').filter((call) => call.headers['idempotency-key'] === refundId),
      'no call was made for a refund with nothing left to give back',
    ).toHaveLength(0);

    const row = await paymentRow(refundId);
    expect(row.status).toBe('cancelled');
    expect(row.pending_action).toBeNull();
    expect((row.metadata as { reason?: string }).reason).toBe('already_refunded');
  });

  // --- The amount Stripe reports has to be the amount we asked for -------------------------------

  /**
   * An event that says money arrived, for an amount that is not the one this payment asked for,
   * is refused whole.
   *
   * This is the only place a money column is fed from a field of somebody else's payload.
   * Applying it would give a booking that is `confirmed` and still owes the whole deposit, and
   * no line anywhere would say so. So nothing is written, the answer is a 500 that Stripe will
   * retry, and the line is at `error` with all three numbers.
   */
  it('refuses a payment_intent.succeeded whose amount is not the amount asked for', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;

    const answered = await sendEvent(
      intentEvent('payment_intent.succeeded', { id: intentId, amount_received: 4200 }),
    );
    expect(answered.status).toBe(500);

    // Nothing moved: not the payment, not the booking, not the deadline.
    const row = await paymentRow(paymentId);
    expect(row.status).toBe('pending');
    const booking = await h.call<BookingBody>('GET', `/v1/bookings/${response.body.id}`, { token });
    expect(booking.body.status).toBe('pending');
    expect(booking.body.amount_paid).toBe(0);
    expect(booking.body.amount_due).toBe(5000);
    expect(booking.body.payment_expires_at).not.toBeNull();

    // And the redelivery of the correct event still works, because the claim row was left
    // unprocessed: this is what makes the 500 a retry and not a loss.
    const good = await sendEvent(
      intentEvent('payment_intent.succeeded', { id: intentId, amount_received: 5000 }),
    );
    expect(good.status).toBe(200);
    expect((await paymentRow(paymentId)).status).toBe('succeeded');
  });

  /** A missing `amount_received` reads as zero, and zero is refused by the same guard. */
  it('refuses a payment_intent.succeeded that reports no amount at all', async () => {
    const { response } = await book({ policy: { deposit: { type: 'percent', value: 100 } } });
    const intentId = response.body.payment_intent!.id;
    const paymentId = response.body.payment_intent!.payment_id;

    const answered = await sendEvent(intentEvent('payment_intent.succeeded', { id: intentId }));
    expect(answered.status).toBe(500);
    expect((await paymentRow(paymentId)).status).toBe('pending');
  });

  // --- A body nobody should be able to make this endpoint hold ----------------------------------

  /** Over a megabyte is refused before it is read, and before the signature is even looked at. */
  it('refuses a webhook body larger than a megabyte', async () => {
    const huge = JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 64) });
    const answered = await h.call<ErrorBody>('POST', '/v1/stripe/webhook/test', {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(huge, 'utf8')),
        'stripe-signature': 't=1,v1=' + '0'.repeat(64),
      },
      body: JSON.parse(huge) as unknown,
    });
    expect(answered.status).toBe(413);
    expect(answered.body.error.code).toBe('payload_too_large');
  });
});
