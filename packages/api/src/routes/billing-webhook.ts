/**
 * `POST /v1/billing/webhook`: where Stripe tells Bookrail about its **own** customers, the ones
 * who buy Pro and Scale.
 *
 * ## Not the Connect receivers
 *
 * `POST /v1/stripe/webhook/{mode}` receives the events of the **connected accounts** of the
 * customers of Bookrail: money that moved on a booking. This receiver receives the events of the
 * Bookrail account itself, as a seller: a checkout completed, a subscription changed, an invoice
 * created, paid or failed. Two receivers, two signing secrets, two sets of events, and the
 * mistake of registering one for the other is made **visible**: an event that names a connected
 * `account` is refused here with a `400`, because it can only have arrived through a Connect
 * endpoint pointed at the wrong URL.
 *
 * ## The order, as in the Connect receivers
 *
 * 1. The raw bytes, at most a megabyte, before anything is parsed.
 * 2. The signature, with `STRIPE_BILLING_WEBHOOK_SECRET`, over those bytes. Nothing touches the
 *    database before it passes.
 * 3. The JSON, the mode (`livemode` against `BILLING_STRIPE_MODE`, `400 billing_mode_mismatch`),
 *    and the refusal of a Connect event.
 * 4. The claim of the event: a duplicate that was processed answers `duplicate: true` and does
 *    nothing; a claim that was never settled is an attempt that failed, and this one carries on.
 * 5. The handler, which calls Stripe outside any transaction and writes through the definer
 *    functions of migration 0027.
 * 6. The settlement.
 *
 * A handler that fails throws, the claim stays unsettled, and the `500` is what makes Stripe
 * deliver the event again.
 */
import { Hono } from 'hono';
import { sql, withAuthContext } from '@bookrail/db';
import { BookrailError } from '@bookrail/shared';
import type { AppDeps, AppEnv, BillingDeps } from '../context.js';
import { billingNotConfigured } from '../billing/errors.js';
import {
  applySubscription,
  checkoutCompleted,
  customerChanged,
  invoiceNoLongerDue,
  invoicePaid,
  paymentFailed,
  renewalCreated,
  scheduleChanged,
  type BillingEvent,
  type Outcome,
} from '../billing/events.js';
import { STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from '../stripe/signature.js';

/** The event types this receiver acts on. Everything else is recorded and ignored. */
export const HANDLED_BILLING_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.updated',
  'customer.tax_id.created',
  'customer.tax_id.updated',
  'customer.tax_id.deleted',
  'subscription_schedule.created',
  'subscription_schedule.updated',
  'subscription_schedule.released',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.aborted',
  'invoice.voided',
  'invoice.marked_uncollectible',
] as const;

/** The same ceiling as the Connect receivers, for the same reasons. */
const MAX_BODY_BYTES = 1024 * 1024;

function payloadTooLarge(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'payload_too_large',
    'The request body is larger than the one megabyte this endpoint accepts.',
  );
}

function signatureInvalid(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'stripe_signature_invalid',
    'The Stripe-Signature header is missing, malformed, out of tolerance or does not match.',
    undefined,
    'Check that STRIPE_BILLING_WEBHOOK_SECRET matches the endpoint of the account registered in Stripe for /v1/billing/webhook.',
  );
}

function modeMismatch(mode: string): BookrailError {
  return new BookrailError(
    'invalid_request',
    'billing_mode_mismatch',
    `Billing runs in ${mode} mode on this deployment, and the event is for the other one.`,
    undefined,
    'Point the Stripe endpoint of this mode at this deployment, or set BILLING_STRIPE_MODE to the mode of the endpoint.',
  );
}

function connectEventRefused(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'billing_connect_event',
    'This endpoint receives the events of the Bookrail account itself, and this event belongs to a connected account.',
    undefined,
    'Register /v1/billing/webhook as an endpoint of the account, not as a Connect endpoint. Connect events go to /v1/stripe/webhook/{mode}.',
  );
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseEvent(raw: string): BillingEvent | null {
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
  if (id === null || type === null || !/^evt_[A-Za-z0-9]+$/.test(id)) return null;
  const data = typeof body.data === 'object' && body.data !== null ? body.data : {};
  const object = (data as Record<string, unknown>).object;
  const previous = (data as Record<string, unknown>).previous_attributes;
  const created =
    typeof body.created === 'number' && Number.isFinite(body.created) ? body.created : null;
  return {
    id,
    type,
    livemode: body.livemode === true,
    created: created ?? Math.floor(Date.now() / 1000),
    account: asString(body.account),
    object:
      typeof object === 'object' && object !== null ? (object as Record<string, unknown>) : {},
    previousAttributes:
      typeof previous === 'object' && previous !== null && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)
        : null,
  };
}

export function billingWebhookRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/webhook', async (c) => {
    const billing = deps.billing;
    if (billing === undefined || billing === null) throw billingNotConfigured();

    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw payloadTooLarge();
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) throw payloadTooLarge();
    const header = c.req.header(STRIPE_SIGNATURE_HEADER) ?? null;

    if (
      !verifyStripeSignature({
        body: raw,
        header,
        secret: billing.webhookSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    ) {
      deps.logger.warn('billing_webhook_signature_invalid', {
        signature_timestamp: /(?:^|,)t=(\d{1,15})(?:,|$)/.exec(header ?? '')?.[1] ?? null,
        body_bytes: raw.byteLength,
      });
      throw signatureInvalid();
    }

    const event = parseEvent(raw.toString('utf8'));
    if (event === null) {
      throw new BookrailError(
        'invalid_request',
        'invalid_body',
        'The Stripe event body could not be read.',
      );
    }
    if (event.livemode !== (billing.mode === 'live')) {
      deps.logger.error('billing_webhook_mode_mismatch', {
        event_id: event.id,
        mode: billing.mode,
      });
      throw modeMismatch(billing.mode);
    }
    if (event.account !== null) {
      deps.logger.error('billing_webhook_connect_event', { event_id: event.id, type: event.type });
      throw connectEventRefused();
    }

    const claimed = await claim(deps, event);
    if (claimed.duplicate) return c.json({ received: true, duplicate: true });

    const outcome = await dispatch(deps, billing, event);
    await withAuthContext(deps.db, (tx) =>
      tx.execute(sql`SELECT billing_event_settle(${claimed.id}::uuid, ${outcome})`),
    );
    return c.json({ received: true });
  });

  return routes;
}

async function claim(
  deps: AppDeps,
  event: BillingEvent,
): Promise<{ id: string; duplicate: boolean }> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ id: string; duplicate: boolean }>(sql`
      SELECT id, duplicate FROM billing_event_claim(${event.id}, ${event.type}, ${event.livemode})
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('billing_event_claim answered no row.');
  return row;
}

async function dispatch(
  deps: AppDeps,
  billing: BillingDeps,
  event: BillingEvent,
): Promise<Outcome> {
  const handlerDeps = {
    db: deps.db,
    logger: deps.logger,
    mailer: deps.mailer,
    billing,
    ...(deps.plans === undefined ? {} : { plans: deps.plans }),
  };
  switch (event.type) {
    case 'checkout.session.completed':
      return checkoutCompleted(handlerDeps, event);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
    case 'customer.subscription.pending_update_expired': {
      const id = asString(event.object.id);
      if (id === null) return 'ignored';
      return applySubscription(handlerDeps, id, null, null, event.created);
    }
    case 'invoice.created':
      return renewalCreated(handlerDeps, event);
    case 'invoice.paid':
      return invoicePaid(handlerDeps, event);
    case 'invoice.payment_failed':
      return paymentFailed(handlerDeps, event);
    case 'customer.updated':
    case 'customer.tax_id.created':
    case 'customer.tax_id.updated':
    case 'customer.tax_id.deleted':
      return customerChanged(handlerDeps, event);
    case 'subscription_schedule.created':
    case 'subscription_schedule.updated':
    case 'subscription_schedule.released':
    case 'subscription_schedule.canceled':
    case 'subscription_schedule.completed':
    case 'subscription_schedule.aborted':
      return scheduleChanged(handlerDeps, event);
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      return invoiceNoLongerDue(handlerDeps, event);
    default:
      return 'ignored';
  }
}
