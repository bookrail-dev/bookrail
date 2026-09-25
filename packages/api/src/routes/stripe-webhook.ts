/**
 * `POST /v1/stripe/webhook/test` and `POST /v1/stripe/webhook/live`: where Stripe tells us that
 * money moved.
 *
 * It is the only endpoint in this API whose caller is another company's server, the only one
 * with no API key that writes to project data, and the only one allowed to change
 * `bookings.amount_paid`, `amount_due` and `amount_refunded`. Everything below is shaped by
 * those three facts.
 *
 * ## Two paths, not one endpoint that guesses
 *
 * The mode is in the **path**, so the secret to verify with is decided before the body is
 * looked at. An endpoint that read `livemode` out of the payload to choose a secret would be
 * letting the sender choose which key it is checked against, which is not a check. The body's
 * own `livemode` is still compared with the path afterwards, and a disagreement is a `400`: it
 * means a test event reached the live endpoint, and applying it would move real numbers for a
 * payment that never happened.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **The raw body**, `await c.req.text()`, before any parsing. The HMAC is over the bytes
 *    that arrived: two JSON encoders disagree about key order and whitespace, and a receiver
 *    that re-serialised before verifying would refuse payloads that are perfectly valid. It is
 *    the first route in this API that reads a body this way, and the reason is exactly this.
 * 2. **The signature.** Nothing before it touches the database. A refusal is a `400` and a
 *    `warn` line carrying the timestamp and the length of the body: not the body, which is a
 *    payload somebody chose, and not the header, which is an attempt at a secret.
 * 3. **The JSON**, and the `livemode` check.
 * 4. **The claim**, `(provider, provider_event_id)`. Stripe retries until it gets a 2xx and may
 *    redeliver after one; applying `payment_intent.succeeded` twice would add the amount twice.
 *    A row that exists **and is processed** is a duplicate and is answered as one. A row that
 *    exists and is not processed is a previous attempt that failed, and this one carries on.
 * 5. **The dispatch**, inside `withProjectContext` of the project the event resolves to.
 * 6. **The settlement**: `processed_at` and `outcome`.
 *
 * ## No call to Stripe, ever
 *
 * Stripe expects an answer within seconds and retries the whole event if it does not get one.
 * So this endpoint touches the database and nothing else: a refund that has to be created, or
 * an intent that has to be cancelled, is queued on the `payments` row and made by the worker
 * (`jobs/payment-actions.ts`). An enrichment call here would put another company's latency
 * inside their own timeout.
 *
 * ## What a forged request can do
 *
 * Nothing. Resolving an account and an intent to a project is `stripe_payment_scope`, a
 * `SECURITY DEFINER` function whose `EXECUTE` belongs to the application role alone, and it is
 * reached only after the signature has been verified against a secret that is in an environment
 * file and in Stripe's dashboard. A request with a valid body and no signature costs one
 * `400` and writes nothing at all, claim row included.
 */
import { Hono } from 'hono';
import { sql, withAuthContext, withProjectContext, type Transaction } from '@bookrail/db';
import {
  applyTransition,
  insertEvent,
  nextTransitionFor,
  recordPlanUsage,
  requiresConfirmation,
  type AutomaticTransition,
  type PlanUsageWarning,
} from '@bookrail/engine';
import { BookrailError, encodeId, uuidv7, type Environment } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { invalidateTouchedDays } from '../cache.js';
import { sendPlanWarnings } from '../plan.js';
import { serializePayment } from '../serialize.js';
import { stripeWebhookSecret } from '../stripe/platform.js';
import { STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from '../stripe/signature.js';
import { stripeNotConfigured } from './stripe.js';

/** The five event types this release acts on. Everything else is recorded and ignored. */
export const HANDLED_STRIPE_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'account.application.deauthorized',
] as const;

/** Stripe caps a failure message at what it caps it at; the column caps it at 500. */
const MAX_FAILURE_MESSAGE = 500;

/**
 * The most this endpoint will read, in bytes.
 *
 * A Stripe event is a few kilobytes. A megabyte is far above anything real and far below what
 * an unbounded read would let a stranger hold in memory, and it is the same number the reverse
 * proxy is configured with, so the two refusals agree.
 */
const MAX_BODY_BYTES = 1024 * 1024;

function payloadTooLarge(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'payload_too_large',
    'The request body is larger than the one megabyte this endpoint accepts.',
  );
}

/**
 * Stripe said money arrived, and it is not the money we asked for.
 *
 * Thrown from inside the transaction so that nothing it had written is kept, caught at the
 * route so that the line can be logged with the identifiers and the answer can be a 500. It is
 * not a `BookrailError`: there is no caller to explain it to, only Stripe, which needs a status
 * it will retry and nothing else.
 */
class AmountMismatch extends Error {
  constructor(
    readonly paymentId: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super('The amount Stripe reported does not match the amount this payment asked for.');
    this.name = 'AmountMismatch';
  }
}

function signatureInvalid(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'stripe_signature_invalid',
    'The Stripe-Signature header is missing, malformed, out of tolerance or does not match.',
    undefined,
    'Check that STRIPE_WEBHOOK_SECRET_TEST/_LIVE matches the endpoint registered in Stripe.',
  );
}

/** The scope of an event, as `stripe_payment_scope` answers it. */
interface PaymentScope {
  projectId: string;
  environment: Environment;
  paymentId: string;
}

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** The connected account, on a Connect event. Absent on a platform event. */
  account: string | null;
  object: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The event, or `null` when the body is not one. Never throws: the body is from the network. */
function parseEvent(raw: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const id = asString(body.id);
  const type = asString(body.type);
  if (id === null || type === null) return null;
  const data = typeof body.data === 'object' && body.data !== null ? body.data : {};
  const object = (data as Record<string, unknown>).object;
  return {
    id,
    type,
    livemode: body.livemode === true,
    account: asString(body.account),
    object:
      typeof object === 'object' && object !== null ? (object as Record<string, unknown>) : {},
  };
}

export function stripeWebhookRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  for (const environment of ['test', 'live'] as const) {
    routes.post(`/${environment}`, async (c) => {
      const secret = stripeWebhookSecret(deps.stripe, environment);
      // A deployment whose endpoint has not been registered yet. `503` and not `400`: the
      // request is fine, this side is not ready, and Stripe retries a 5xx.
      if (secret === null) throw stripeNotConfigured(environment);

      // Step 1: the bytes, before anything, and never more than a megabyte of them.
      //
      // The limit is also in the reverse proxy, and it belongs here as well: this is a public
      // endpoint with no key and, by design, no rate limit in front of it, so a deployment
      // running without that proxy (development, or a different front end one day) would
      // otherwise accumulate a body of any size in memory on request. `content-length` is
      // checked first because refusing before reading is the only refusal that costs nothing,
      // and the read is capped afterwards for a sender that lies about it or omits it.
      const declared = Number(c.req.header('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw payloadTooLarge();
      // `arrayBuffer` and not `text`: the signature is over the bytes that arrived, and
      // decoding to a string would replace anything that is not valid UTF-8 with U+FFFD, which
      // changes what is being verified.
      const raw = Buffer.from(await c.req.arrayBuffer());
      if (raw.byteLength > MAX_BODY_BYTES) throw payloadTooLarge();
      const header = c.req.header(STRIPE_SIGNATURE_HEADER) ?? null;

      // Step 2. Nothing has touched the database yet, and nothing will if this fails.
      const nowMs = Date.now();
      if (
        !verifyStripeSignature({
          body: raw,
          header,
          secret,
          nowSeconds: Math.floor(nowMs / 1000),
        })
      ) {
        // The timestamp the sender claimed and the size of what it sent: enough to tell a clock
        // that has drifted from a secret that is wrong, and nothing of the payload itself.
        deps.logger.warn('stripe_webhook_signature_invalid', {
          environment,
          signature_timestamp: /(?:^|,)t=(\d{1,15})(?:,|$)/.exec(header ?? '')?.[1] ?? null,
          body_bytes: raw.byteLength,
        });
        throw signatureInvalid();
      }

      // Step 3. Decoded only now, after the bytes have been proved to be Stripe's.
      const event = parseEvent(raw.toString('utf8'));
      if (event === null) {
        throw new BookrailError(
          'invalid_request',
          'invalid_body',
          'The Stripe event body could not be read.',
        );
      }
      if (event.livemode !== (environment === 'live')) {
        throw new BookrailError(
          'invalid_request',
          'stripe_signature_invalid',
          `This endpoint serves the ${environment} environment and the event is for the other one.`,
        );
      }

      // `account.application.deauthorized` is the one event that is about the **link** and not
      // about a payment. It names an account and no intent, and an account may legitimately
      // belong to more than one project, so it has no single scope and is claimed without one.
      const isDeauthorization = event.type === 'account.application.deauthorized';
      const scope = isDeauthorization ? null : await resolveScope(deps, event);

      // Step 4: the claim, in the project's own context when there is one.
      const claimed =
        scope === null
          ? await claimUnmatched(deps, event)
          : await claimInProject(deps, event, scope);
      if (claimed.duplicate) {
        return c.json({ received: true, duplicate: true });
      }

      // Step 5 and 6. A failure here throws, the claim row stays unprocessed, and the `500`
      // this becomes is what makes Stripe try again: the next attempt finds a row that exists
      // and is **not** processed, which is not a duplicate.
      let outcome: 'applied' | 'ignored' | 'unmatched';
      try {
        outcome = isDeauthorization
          ? await deauthorize(deps, event, nowMs)
          : scope === null
            ? ('unmatched' as const)
            : await dispatch(deps, event, scope, nowMs);
      } catch (error) {
        if (!(error instanceof AmountMismatch)) throw error;
        // The one refusal that is about the money itself. Everything the transaction touched is
        // already rolled back, and the claim row stays unprocessed on purpose, so Stripe's next
        // delivery is a retry and not a duplicate. Whoever reads the log gets all three numbers.
        deps.logger.error('stripe_amount_mismatch', {
          environment,
          event_id: event.id,
          payment_id: encodeId('payment', error.paymentId),
          expected: error.expected,
          received: error.received,
        });
        throw new BookrailError(
          'internal',
          'payment_amount_mismatch',
          'The amount reported for this payment does not match the amount it asked for.',
        );
      }
      await settle(deps, claimed.id, scope, outcome, nowMs);

      return c.json({ received: true });
    });
  }

  return routes;
}

// --- Resolving the project --------------------------------------------------------------------

/**
 * Which project an event belongs to, through the one definer function that can answer.
 *
 * Two shapes of question, because the events have two shapes. A `payment_intent.*` or a
 * `charge.*` names an intent, and the pair (account, intent) is the lookup;
 * `account.application.deauthorized` names only the account, and is handled by
 * {@link deauthorize} which asks `stripe_account_scope` for **every** project that connected
 * it. `null` here means the first kind could not be attributed, which is recorded as
 * `unmatched` and acted on by nothing.
 */
async function resolveScope(deps: AppDeps, event: StripeEvent): Promise<PaymentScope | null> {
  if (event.type === 'account.application.deauthorized') return null;
  const account = event.account;
  const intent = paymentIntentIdOf(event);
  if (account === null || intent === null) return null;
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ project_id: string; environment: Environment; payment_id: string }>(
      sql`SELECT project_id, environment, payment_id
            FROM stripe_payment_scope(${account}, ${intent})`,
    ),
  );
  // Two rows is a state the schema makes unreachable, and if it were ever reached the honest
  // answer is "we cannot say which project this belongs to". Recorded as `unmatched`, which
  // somebody can find, rather than attributed to whichever row sorted first.
  if (rows.length > 1) {
    deps.logger.error('stripe_payment_scope_ambiguous', {
      event_id: event.id,
      type: event.type,
    });
    return null;
  }
  const row = rows[0];
  if (row === undefined) return null;
  return {
    projectId: row.project_id,
    environment: row.environment,
    paymentId: row.payment_id,
  };
}

/**
 * The PaymentIntent an event is about, whatever shape the event has.
 *
 * `payment_intent.*` carries the intent itself, so its `id`. `charge.refunded` carries a
 * **charge**, whose `payment_intent` is the link back: the charge identifier is a second thing
 * we would have to store and keep in step, and the intent is the one we already have.
 */
function paymentIntentIdOf(event: StripeEvent): string | null {
  if (event.type.startsWith('payment_intent.')) return asString(event.object.id);
  if (event.type.startsWith('charge.')) return asString(event.object.payment_intent);
  return null;
}

// --- The claim ---------------------------------------------------------------------------------

interface Claim {
  id: string;
  /** True only when the row existed **and** had already been processed. */
  duplicate: boolean;
}

/**
 * Claims the event row inside the project it belongs to.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` then a read, rather than an upsert, so that a redelivery
 * of an attempt which failed halfway finds `processed_at IS NULL` and is allowed to run again.
 */
async function claimInProject(
  deps: AppDeps,
  event: StripeEvent,
  scope: PaymentScope,
): Promise<Claim> {
  return withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    async (tx) => {
      const id = uuidv7();
      await tx.execute(sql`
        INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                             provider_event_id, type, provider_account_id)
        VALUES (${id}, ${scope.projectId}::uuid, ${scope.environment}, 'stripe', ${event.id},
                ${event.type}, ${event.account})
        ON CONFLICT (provider, provider_event_id) DO NOTHING
      `);
      const { rows } = await tx.execute<{ id: string; processed: boolean }>(sql`
        SELECT id, processed_at IS NOT NULL AS processed
          FROM payment_provider_events
         WHERE provider = 'stripe' AND provider_event_id = ${event.id}
      `);
      const row = rows[0];
      // The row is invisible only if a previous delivery of the same event was recorded against
      // another project, which would mean an intent moved between projects. Treated as a
      // duplicate rather than applied twice: refusing to act is the safe half of the choice.
      //
      // It is also the one branch where an event is refused **for ever**, since every later
      // delivery lands here too, so it says so out loud. Silence here would be a payment that
      // never applies and no way to find out why.
      if (row === undefined) {
        deps.logger.warn('stripe_webhook_claim_invisible', {
          event_id: event.id,
          type: event.type,
        });
        return { id, duplicate: true };
      }
      return { id: row.id, duplicate: row.processed };
    },
  );
}

/** The same claim for an event that belongs to no project, through the definer function. */
async function claimUnmatched(deps: AppDeps, event: StripeEvent): Promise<Claim> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ id: string; duplicate: boolean }>(sql`
      SELECT id, duplicate
        FROM stripe_event_record_unmatched(${uuidv7()}::uuid, ${event.id}, ${event.type},
                                           ${event.account})
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('stripe_event_record_unmatched answered no row.');
  return { id: row.id, duplicate: row.duplicate };
}

/**
 * Marks the claim processed, on whichever side of the policy the row lives.
 *
 * A row with a project is settled by the application role under its own policy; a row without
 * one is invisible to that policy and is settled by the definer function that wrote it. Both
 * are conditional on `processed_at IS NULL`, so two deliveries racing here settle it once.
 */
async function settle(
  deps: AppDeps,
  id: string,
  scope: PaymentScope | null,
  outcome: 'applied' | 'ignored' | 'unmatched',
  nowMs: number,
): Promise<void> {
  if (scope === null) {
    await withAuthContext(deps.db, (tx) =>
      tx.execute(sql`
        SELECT stripe_event_settle_unmatched(${id}::uuid, ${outcome},
                                             ${new Date(nowMs).toISOString()}::timestamptz)
      `),
    );
    return;
  }
  await withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    (tx) =>
      tx.execute(sql`
        UPDATE payment_provider_events
           SET processed_at = ${new Date(nowMs).toISOString()}::timestamptz, outcome = ${outcome}
         WHERE id = ${id}::uuid AND processed_at IS NULL
      `),
  );
}

/**
 * `account.application.deauthorized`: the customer revoked us from their own Stripe dashboard.
 *
 * Until this release nothing wrote `disconnect_reason = 'deauthorized'`, and a customer who
 * revoked access stayed `connected` in our database for ever. This is the writer.
 *
 * It asks `stripe_account_scope` for **every** project that named this account and disconnects
 * each one, because nothing in the model stops two projects from having connected the same
 * Stripe account and a revocation ends the platform's access for all of them at once. Each gets
 * its own transaction and its own `stripe.disconnected` event, and the `UPDATE` is guarded on
 * `status = 'connected'` so that a second delivery, or a `bookrail stripe disconnect` that got
 * there first, writes nothing and emits nothing.
 *
 * `applied` when at least one connection changed, `ignored` when none did: an event about an
 * account this deployment does not know is a fact worth recording and nothing to act on.
 */
async function deauthorize(
  deps: AppDeps,
  event: StripeEvent,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  const account = event.account;
  if (account === null) return 'ignored';
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ project_id: string; environment: Environment }>(
      sql`SELECT project_id, environment FROM stripe_account_scope(${account})`,
    ),
  );
  let applied = false;
  for (const row of rows) {
    const changed = await withProjectContext(
      deps.db,
      { projectId: row.project_id, environment: row.environment },
      async (tx) => {
        const at = new Date(nowMs).toISOString();
        const updated = await tx.execute<Record<string, unknown>>(sql`
          UPDATE payment_provider_connections
             SET status = 'disconnected', disconnected_at = ${at}::timestamptz,
                 disconnect_reason = 'deauthorized', updated_at = ${at}::timestamptz
           WHERE provider = 'stripe' AND provider_account_id = ${account}
             AND status = 'connected'
          RETURNING id, provider_account_id, connected_at, disconnected_at, disconnect_reason
        `);
        const connection = updated.rows[0];
        if (connection === undefined) return false;
        await insertEvent(
          tx,
          row.project_id,
          row.environment,
          'stripe.disconnected',
          {
            object: 'stripe_connection',
            status: 'disconnected',
            environment: row.environment,
            id: encodeId('payment_provider_connection', connection.id as string),
            account_id: connection.provider_account_id as string,
            // Built rather than cast, for the reason `paymentEventObject` builds its two: a
            // `timestamptz` read through `tx.execute` is whatever the driver parsed, and a
            // cast that is wrong is a cast that crashes at run time.
            connected_at: new Date(connection.connected_at as string).toISOString(),
            disconnected_at: new Date(connection.disconnected_at as string).toISOString(),
            disconnect_reason: 'deauthorized',
            charges_enabled: null,
          },
          { actor: { type: 'provider', id: null }, occurredAt: nowMs },
        );
        return true;
      },
    );
    if (changed) applied = true;
  }
  return applied ? 'applied' : 'ignored';
}

// --- The dispatch ------------------------------------------------------------------------------

async function dispatch(
  deps: AppDeps,
  event: StripeEvent,
  scope: PaymentScope,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      return succeeded(deps, event, scope, nowMs);
    case 'payment_intent.payment_failed':
      return paymentFailed(deps, event, scope, nowMs);
    case 'payment_intent.canceled':
      return intentCanceled(deps, scope, nowMs);
    case 'charge.refunded':
      return chargeRefunded(deps, event, scope, nowMs);
    default:
      // Every other type Stripe sends. Recorded, so that "did we see it" has an answer, and
      // acted on by nothing: a receiver that quietly did something with an event it was not
      // designed for is a receiver nobody can reason about.
      return 'ignored';
  }
}

/** The locked payment row a handler works on, with the booking it belongs to. */
interface LockedPayment {
  id: string;
  bookingId: string | null;
  type: string;
  status: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  providerAccountId: string;
  providerPaymentId: string | null;
}

/**
 * Takes the locks of one payment **and its booking**, in the order the rest of the system takes
 * them: the booking first, then the payment.
 *
 * That order is not a preference, it is the fix for a real deadlock. `lifecycle.ts` locks the
 * booking row and then its payments, because every transition starts from a booking; a handler
 * here that locked the payment and then updated the booking would take the same two locks the
 * other way round, and an expiry racing a `payment_intent.succeeded` on the same booking would
 * deadlock. Postgres would report `40P01` and the receiver would answer `500`, which Stripe
 * would retry, which is a bug that looks like slowness.
 *
 * The booking identifier is read **without** a lock first. It is safe to read it that way
 * because it never changes: a `payments` row is written with its booking and keeps it for ever
 * (the one exception, `ON DELETE SET NULL`, cannot fire while the booking exists). The lock
 * that decides anything is the one taken immediately afterwards.
 */
async function lockPaymentAndBooking(tx: Transaction, id: string): Promise<LockedPayment | null> {
  const { rows } = await tx.execute<{ booking_id: string | null }>(
    sql`SELECT booking_id FROM payments WHERE id = ${id}`,
  );
  const first = rows[0];
  if (first === undefined) return null;
  if (first.booking_id !== null) {
    await tx.execute(sql`SELECT id FROM bookings WHERE id = ${first.booking_id} FOR UPDATE`);
  }
  return lockPayment(tx, id);
}

async function lockPayment(tx: Transaction, id: string): Promise<LockedPayment | null> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    SELECT id, booking_id, type, status, amount, amount_refunded, currency, provider_account_id,
           provider_payment_id
      FROM payments WHERE id = ${id} FOR UPDATE
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id as string,
    bookingId: (row.booking_id as string | null) ?? null,
    type: row.type as string,
    status: row.status as string,
    amount: Number(row.amount),
    amountRefunded: Number(row.amount_refunded),
    currency: row.currency as string,
    providerAccountId: row.provider_account_id as string,
    providerPaymentId: (row.provider_payment_id as string | null) ?? null,
  };
}

/** The `payments` row as it is now, serialized for the `data.object` of a `payment.*` event. */
async function paymentEventObject(
  tx: Transaction,
  paymentId: string,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { rows } = await tx.execute<Record<string, unknown>>(
    sql`SELECT * FROM payments WHERE id = ${paymentId}`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('The payment disappeared inside its own transaction.');
  return {
    ...serializePayment(
      {
        id: row.id as string,
        projectId: row.project_id as string,
        environment: row.environment as Environment,
        bookingId: (row.booking_id as string | null) ?? null,
        provider: row.provider as string,
        providerPaymentId: (row.provider_payment_id as string | null) ?? null,
        providerAccountId: row.provider_account_id as string,
        parentPaymentId: (row.parent_payment_id as string | null) ?? null,
        type: row.type as 'deposit',
        amount: Number(row.amount),
        currency: row.currency as string,
        amountRefunded: Number(row.amount_refunded),
        status: row.status as 'pending',
        failureCode: (row.failure_code as string | null) ?? null,
        failureMessage: (row.failure_message as string | null) ?? null,
        pendingAction: null,
        pendingActionAttempts: 0,
        pendingActionNextAt: null,
        pendingActionError: null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? {},
        // `tx.execute` hands back what the driver parsed; a `timestamptz` selected this way is
        // a string rather than the `Date` the Drizzle query builder produces, so it is built
        // here instead of being cast and crashing the serializer at run time.
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string),
      },
      {},
    ),
    ...extra,
  };
}

/**
 * `payment_intent.succeeded`: the money arrived.
 *
 * The only place in this system, together with the creation, where `amount_paid` and
 * `amount_due` change, and the whole handler runs in one transaction that locks the payment and
 * then the booking.
 *
 * Three outcomes for the booking, and the third is the interesting one:
 *
 *  * `pending` and the frozen policy asks for no confirmation → `confirm`, which writes
 *    `booking.confirmed` and clears the deadline. This is the ordinary case.
 *  * `pending` and the policy **does** ask for one → it stays `pending`, now confirmable by
 *    hand, and the deadline is cleared because the wait for money is over. The customer agreed
 *    to a policy that says somebody has to accept the booking, and being paid does not accept
 *    it for them.
 *  * already `cancelled` → the money is still recorded as received, and a **full refund** is
 *    queued on a child row. Somebody paid for a slot that no longer exists: taking the money
 *    and keeping it because the timing was unlucky is not an option, and the customer is told
 *    through `payment.succeeded`, whose `data.object` carries `booking_status: "cancelled"`.
 */
async function succeeded(
  deps: AppDeps,
  event: StripeEvent,
  scope: PaymentScope,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  const received = asInteger(event.object.amount_received);
  const result = await withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    async (tx) => {
      const payment = await lockPaymentAndBooking(tx, scope.paymentId);
      if (payment === null) return null;
      // A second `payment_intent.succeeded` for the same intent, arriving with a different
      // event id, would otherwise add the amount again. The row's own status is the guard that
      // the event table cannot be: it is about the money, not about the message.
      if (payment.status === 'succeeded') return null;

      // The amount is checked against what we asked for before it is written anywhere.
      //
      // This is the only place a money column is fed from a field of somebody else's payload,
      // and `asInteger` turns anything that is not a finite number into `0`. Without this
      // guard a payload whose `amount_received` were missing, renamed by a future API version,
      // or simply different, would be applied in silence: the booking would go to `confirmed`
      // with `amount_paid` unchanged and `amount_due` still the whole deposit, which is a
      // booking that says it is paid and owes money at the same time, and no line anywhere
      // would say so.
      //
      // The refusal is deliberately loud and deliberately total. Nothing is written, the claim
      // row is left unprocessed, and the answer is a 500, which is what makes Stripe deliver
      // the event again while a person reads the line below. Recording an amount we cannot
      // explain would be worse than recording nothing.
      if (received <= 0 || received !== payment.amount) {
        throw new AmountMismatch(payment.id, payment.amount, received);
      }

      await tx.execute(sql`
        UPDATE payments
           SET status = 'succeeded', failure_code = NULL, failure_message = NULL,
               pending_action = NULL, pending_action_next_at = NULL,
               updated_at = ${new Date(nowMs).toISOString()}::timestamptz
         WHERE id = ${payment.id}
      `);
      // The paid volume of the plan, in the transaction that records the money. Nothing in the
      // test environment.
      await recordPlanUsage(tx, {
        projectId: scope.projectId,
        environment: scope.environment,
        now: nowMs,
        paymentVolume: received,
        currency: payment.currency,
      });

      let bookingStatus: string | null = null;
      let touchedDays: { resourceId: string; day: string }[] = [];
      let planWarnings: readonly PlanUsageWarning[] = [];
      if (payment.bookingId !== null) {
        const { rows } = await tx.execute<Record<string, unknown>>(sql`
          UPDATE bookings
             SET amount_paid = amount_paid + ${received},
                 amount_due = greatest(0, amount_due - ${received}),
                 payment_expires_at = NULL,
                 updated_at = ${new Date(nowMs).toISOString()}::timestamptz
           WHERE id = ${payment.bookingId}
          RETURNING status, policy_snapshot,
                    (extract(epoch FROM starts_at) * 1000)::bigint AS starts_ms,
                    (extract(epoch FROM ends_at) * 1000)::bigint AS ends_ms,
                    (extract(epoch FROM checked_in_at) * 1000)::bigint AS checked_in_ms
        `);
        const booking = rows[0];
        if (booking !== undefined) {
          bookingStatus = booking.status as string;
          const snapshot = (booking.policy_snapshot as Record<string, unknown> | null) ?? null;
          if (bookingStatus === 'pending' && !requiresConfirmation(snapshot)) {
            const applied = await applyTransition(tx, {
              projectId: scope.projectId,
              environment: scope.environment,
              bookingId: payment.bookingId,
              action: 'confirm',
              actor: { type: 'system', id: null },
              now: nowMs,
              ...(deps.plans === undefined ? {} : { plans: deps.plans }),
            });
            bookingStatus = applied.status;
            touchedDays = [...applied.touchedDays];
            planWarnings = applied.planWarnings;
          } else if (bookingStatus === 'cancelled') {
            // The slot is gone, so the money goes back in full. `amount - amount_refunded`,
            // not `amount`, so a refund that somebody had already started is not duplicated.
            await queueFullRefund(tx, scope, payment, nowMs);
          } else {
            // The clock was `expire_payment` and the wait is over, so it has to be recomputed
            // from what the booking is now rather than left pointing at a deadline that no
            // longer applies. Same function every transition uses.
            const scheduled = nextTransitionFor(
              {
                status: bookingStatus as 'pending',
                startsAt: Number(booking.starts_ms),
                endsAt: Number(booking.ends_ms),
                checkedInAt: booking.checked_in_ms === null ? null : Number(booking.checked_in_ms),
                paymentExpiresAt: null,
              },
              snapshot,
            );
            await tx.execute(sql`
              UPDATE bookings
                 SET next_transition = ${(scheduled?.action ?? null) as AutomaticTransition | null},
                     next_transition_at = ${
                       scheduled === null ? null : new Date(scheduled.at).toISOString()
                     }::timestamptz
               WHERE id = ${payment.bookingId}
            `);
          }
        }
      }

      const object = await paymentEventObject(tx, payment.id, { booking_status: bookingStatus });
      await insertEvent(tx, scope.projectId, scope.environment, 'payment.succeeded', object, {
        actor: { type: 'system', id: null },
        occurredAt: nowMs,
      });
      return { touchedDays, planWarnings };
    },
  );
  if (result === null) return 'ignored';
  await invalidateTouchedDays(deps, result.touchedDays);
  sendPlanWarnings(deps, result.planWarnings);
  return 'applied';
}

/** A refund row for everything still refundable on a payment, queued for the worker. */
async function queueFullRefund(
  tx: Transaction,
  scope: PaymentScope,
  payment: LockedPayment,
  nowMs: number,
): Promise<void> {
  const amount = payment.amount - payment.amountRefunded;
  if (amount <= 0) return;
  await tx.execute(sql`
    INSERT INTO payments (id, project_id, environment, booking_id, parent_payment_id, provider,
                          provider_account_id, type, amount, currency, status, metadata,
                          pending_action, pending_action_next_at, created_at, updated_at)
    VALUES (${uuidv7()}, ${scope.projectId}::uuid, ${scope.environment},
            ${payment.bookingId}, ${payment.id}::uuid, 'stripe', ${payment.providerAccountId},
            'refund', ${amount}, ${payment.currency}, 'pending',
            ${JSON.stringify({ origin: 'policy', reason: 'paid_after_cancellation' })}::jsonb,
            'create_refund', ${new Date(nowMs).toISOString()}::timestamptz,
            ${new Date(nowMs).toISOString()}::timestamptz,
            ${new Date(nowMs).toISOString()}::timestamptz)
  `);
}

/**
 * `payment_intent.payment_failed`: a card was refused, and the customer may try again.
 *
 * The status stays `pending` on purpose. A PaymentIntent survives a failed attempt: the same
 * `client_secret` still works, and the customer can put in another card until the booking's
 * deadline. Marking the payment `failed` here would tell a dashboard that the booking is dead
 * when it is not, and would leave nothing for a second attempt to succeed against.
 */
async function paymentFailed(
  deps: AppDeps,
  event: StripeEvent,
  scope: PaymentScope,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  const error =
    typeof event.object.last_payment_error === 'object' && event.object.last_payment_error !== null
      ? (event.object.last_payment_error as Record<string, unknown>)
      : {};
  const code = asString(error.code) ?? asString(error.type);
  const message = asString(error.message);
  const applied = await withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    async (tx) => {
      const payment = await lockPaymentAndBooking(tx, scope.paymentId);
      if (payment === null || payment.status !== 'pending') return false;
      await tx.execute(sql`
        UPDATE payments
           SET failure_code = ${code === null ? null : code.slice(0, 100)},
               failure_message = ${message === null ? null : message.slice(0, MAX_FAILURE_MESSAGE)},
               updated_at = ${new Date(nowMs).toISOString()}::timestamptz
         WHERE id = ${payment.id}
      `);
      const object = await paymentEventObject(tx, payment.id, {});
      await insertEvent(tx, scope.projectId, scope.environment, 'payment.failed', object, {
        actor: { type: 'system', id: null },
        occurredAt: nowMs,
      });
      return true;
    },
  );
  return applied ? 'applied' : 'ignored';
}

/**
 * `payment_intent.canceled`: the intent is closed.
 *
 * No event of ours. Bookrail is the one that asked for this, through `cancel_intent`, and the
 * booking has already emitted its `booking.cancelled`: a `payment.cancelled` would be a second
 * announcement of one decision. The row is moved to `cancelled` only from `pending`, so an
 * intent cancelled after it somehow succeeded does not rewrite a succeeded payment.
 */
async function intentCanceled(
  deps: AppDeps,
  scope: PaymentScope,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  const applied = await withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    async (tx) => {
      const payment = await lockPaymentAndBooking(tx, scope.paymentId);
      if (payment === null || payment.status !== 'pending') return false;
      await tx.execute(sql`
        UPDATE payments
           SET status = 'cancelled', pending_action = NULL, pending_action_next_at = NULL,
               updated_at = ${new Date(nowMs).toISOString()}::timestamptz
         WHERE id = ${payment.id}
      `);
      return true;
    },
  );
  return applied ? 'applied' : 'ignored';
}

/**
 * `charge.refunded`: money went back, and the charge says how much in total.
 *
 * **Why this event and not `refund.updated`.** Of the two, this is the one that carries the
 * cumulative amount reliably. `charge.refunded` fires
 * for every refund of the charge, including a partial one and including one created from the
 * customer's own Stripe dashboard, and `charge.amount_refunded` is documented as the cumulative
 * total; `refund.updated` fires when a refund *changes*, which for a card refund that is
 * created already `succeeded` may never happen at all, and it carries one refund's amount,
 * which a receiver would have to add up itself.
 *
 * Cumulative is what makes this handler safe rather than merely careful: the parent's
 * `amount_refunded` is **set** to what Stripe says, not incremented, so applying the same
 * event twice (or applying two events out of order) converges instead of drifting. The
 * booking's counter moves by the **difference** between the two, so it is derived from the same
 * cumulative truth.
 *
 * The cost of the choice, named because it is real: `charge.refunded` does not say **which**
 * refund. So the child rows are settled oldest first against the delta, and a refund nobody
 * asked us for (the dashboard case) becomes a child row of its own with
 * `metadata.origin: "provider"` and no `provider_payment_id`. The numbers on the booking are
 * right either way, which is the thing that has to be right.
 */
async function chargeRefunded(
  deps: AppDeps,
  event: StripeEvent,
  scope: PaymentScope,
  nowMs: number,
): Promise<'applied' | 'ignored'> {
  const cumulative = asInteger(event.object.amount_refunded);
  const applied = await withProjectContext(
    deps.db,
    { projectId: scope.projectId, environment: scope.environment },
    async (tx) => {
      const parent = await lockPaymentAndBooking(tx, scope.paymentId);
      if (parent === null) return false;
      const target = Math.min(Math.max(cumulative, 0), parent.amount);
      const delta = target - parent.amountRefunded;
      if (delta <= 0) return false;

      const at = new Date(nowMs).toISOString();
      await tx.execute(sql`
        UPDATE payments
           SET amount_refunded = ${target},
               status = ${target >= parent.amount ? 'refunded' : parent.status},
               updated_at = ${at}::timestamptz
         WHERE id = ${parent.id}
      `);

      // The child rows this refund settles, oldest first: the ones we asked for, then, for
      // whatever is left over, one we did not.
      const { rows: children } = await tx.execute<Record<string, unknown>>(sql`
        SELECT id, amount FROM payments
         WHERE parent_payment_id = ${parent.id} AND type = 'refund' AND status = 'pending'
         ORDER BY created_at, id
           FOR UPDATE
      `);
      let left = delta;
      const settled: string[] = [];
      for (const child of children) {
        const amount = Number(child.amount);
        if (amount > left) break;
        left -= amount;
        const id = child.id as string;
        settled.push(id);
        await tx.execute(sql`
          UPDATE payments
             SET status = 'succeeded', pending_action = NULL, pending_action_next_at = NULL,
                 updated_at = ${at}::timestamptz
           WHERE id = ${id}
        `);
      }
      if (left > 0) {
        // Nobody here asked for this much. It is a refund made from the customer's own Stripe
        // dashboard, and the counters have to tell the truth about it too: the numbers on a
        // booking are about the money, not about who moved it.
        const id = uuidv7();
        await tx.execute(sql`
          INSERT INTO payments (id, project_id, environment, booking_id, parent_payment_id,
                                provider, provider_account_id, type, amount, currency, status,
                                metadata, created_at, updated_at)
          VALUES (${id}, ${scope.projectId}::uuid, ${scope.environment}, ${parent.bookingId},
                  ${parent.id}::uuid, 'stripe', ${parent.providerAccountId}, 'refund', ${left},
                  ${parent.currency}, 'succeeded',
                  ${JSON.stringify({ origin: 'provider' })}::jsonb, ${at}::timestamptz,
                  ${at}::timestamptz)
        `);
        settled.push(id);
      }

      if (parent.bookingId !== null) {
        await tx.execute(sql`
          UPDATE bookings
             SET amount_refunded = amount_refunded + ${delta}, updated_at = ${at}::timestamptz
           WHERE id = ${parent.bookingId}
        `);
      }
      // The money that went back comes off the month's paid volume: the month of the refund,
      // which is the month this event is applied in. Nothing in the test environment.
      await recordPlanUsage(tx, {
        projectId: scope.projectId,
        environment: scope.environment,
        now: nowMs,
        paymentVolume: -delta,
        currency: parent.currency,
      });

      for (const id of settled) {
        const object = await paymentEventObject(tx, id, {});
        await insertEvent(tx, scope.projectId, scope.environment, 'payment.refunded', object, {
          actor: { type: 'system', id: null },
          occurredAt: nowMs,
        });
      }
      return true;
    },
  );
  return applied ? 'applied' : 'ignored';
}
