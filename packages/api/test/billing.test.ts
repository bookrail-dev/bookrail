/**
 * Stripe Billing, against the real API, the real definer functions, a real Postgres and a fake
 * Stripe over a real socket (`billing-stripe-server.ts`).
 *
 * The accounts are made the way a person makes one (a sign up, then a dashboard session from the
 * link in the message), and Stripe is played by the test: the fake keeps what the API asks it to
 * create, and the test sets the subscriptions and the invoices and delivers the signed events
 * Stripe would deliver. Nothing here waits on a timer: the events carry the instants, and the
 * messages sent after a commit are waited for as a condition.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import {
  LEGAL_VERSIONS,
  PLANS,
  decodeId,
  encodeId,
  perMilleOf,
  silentLogger,
  type PlanTable,
} from '@bookrail/shared';
import { SETUP_USAGE, parseSetupArgs, runSetup } from '../src/billing-setup-main.js';
import { loadBillingConfig } from '../src/config.js';
import type { BillingDeps } from '../src/context.js';
import {
  CatalogIncomplete,
  EU_COUNTRIES,
  PLAN_LOOKUP_KEYS,
  forgetCatalog,
  planOfPrice,
  resolveCatalog,
  vatTreatmentOf,
} from '../src/billing/catalog.js';
import {
  CHECKOUT_SESSION_LIFETIME_S,
  checkoutSessionForm,
  firstOfNextMonthUtc,
  renewalAnchorOf,
} from '../src/billing/checkout.js';
import {
  campo,
  invoiceDataMessage,
  monthlyInvoiceCsv,
  type InvoiceData,
} from '../src/billing/invoice-mail.js';
import {
  computeOverage,
  includedOf,
  overageLines,
  wholeMonthOn,
  type MonthOfPlans,
} from '../src/billing/overage.js';
import { portalConfigurationForm, setupStripeBillingCatalog } from '../src/billing/setup.js';
import {
  runBillingInvoiceList,
  runBillingOverdue,
  runBillingReconcile,
  previousMonthInRome,
  stripeInstantOf,
} from '../src/jobs/billing.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUSES,
  isLiveSubscriptionStatus,
} from '../src/billing/live.js';
import { StripeBillingClient, invoiceLinesOf, priceOf } from '../src/stripe/billing-client.js';
import { appliedVatTreatment, applySubscriptionState } from '../src/billing/events.js';
import { signStripePayload } from '../src/stripe/signature.js';
import { BILLING_INVOICE_LIST_RETRIES } from '../src/jobs/worker.js';
import { buildScenario, nextMonday, plusDays, slotsFor } from './booking-fixtures.js';
import { startFakeBillingStripe, type FakeBillingStripe } from './billing-stripe-server.js';
import { SITE_URL, createHarness, type Harness } from './harness.js';
import { until } from './until.js';

const SECRET = 'whsec_billing_test_secret';
const INVOICE_TO = 'fatture@example.com';

/** Two bookings a month on Free, three on Pro, four on Scale: numbers a test can reach. */
const SMALL: PlanTable = {
  ...PLANS,
  free: { ...PLANS.free, bookingsIncluded: 2 },
  pro: { ...PLANS.pro, bookingsIncluded: 3 },
  scale: { ...PLANS.scale, bookingsIncluded: 4 },
};

interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string; fix?: string };
}

interface AccountBody {
  account: { id: string; plan: string };
  billing: {
    status: string;
    plan: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    scheduled_plan: string | null;
    past_due_since: string | null;
    grace_ends_at: string | null;
    unpaid_invoice?: {
      id: string;
      number: string | null;
      amount_due: number;
      currency: string;
      url: string | null;
    } | null;
  } | null;
  terms: { terms_version: string; dpa_version: string; accepted_at: string | null };
}

let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `billing-${String(counter)}-${String(process.pid)}-${String(Date.now())}@example.com`;
}

function freshCaller(): Record<string, string> {
  counter += 1;
  return { 'x-forwarded-for': `198.51.100.${String(counter % 250)}` };
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The token out of the last link sent to that address. */
function tokenSentTo(h: Harness, email: string, path: string): string {
  const message = [...(h.mailer?.sent ?? [])].reverse().find((sent) => sent.to === email);
  if (message === undefined) throw new Error(`no message was sent to ${email}`);
  const match = new RegExp(`${path}#token=([A-Za-z0-9_%-]+)`).exec(message.text);
  if (match?.[1] === undefined) throw new Error(`no ${path} link in:\n${message.text}`);
  return decodeURIComponent(match[1]);
}

interface Customer {
  email: string;
  accountId: string;
  projectId: string;
  liveKey: string;
  session: string;
}

/** An account made through the sign up, with the terms, and a dashboard session for it. */
async function customer(h: Harness): Promise<Customer> {
  const email = freshEmail();
  const started = await h.call('POST', '/v1/signups', {
    body: { email, client: 'web', accept_terms: true, approve_clauses: true },
    headers: freshCaller(),
  });
  expect(started.status).toBe(202);
  const confirmed = await h.call<{
    account: { id: string };
    project: { id: string };
    live_secret_key: string;
  }>('POST', '/v1/signups/confirm', {
    body: { token: tokenSentTo(h, email, '/signup/confirm') },
  });
  expect(confirmed.status).toBe(200);
  return {
    email,
    accountId: confirmed.body.account.id,
    projectId: confirmed.body.project.id,
    liveKey: confirmed.body.live_secret_key,
    session: await signIn(h, email),
  };
}

async function signIn(h: Harness, email: string): Promise<string> {
  const asked = await h.call('POST', '/v1/dashboard/login', {
    body: { email },
    headers: freshCaller(),
  });
  expect(asked.status).toBe(202);
  const opened = await h.call<{ session_token: string }>('POST', '/v1/dashboard/login/confirm', {
    body: { token: tokenSentTo(h, email, '/dashboard/confirm') },
  });
  expect(opened.status).toBe(200);
  return opened.body.session_token;
}

let eventCounter = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  options: { created?: number; account?: string; livemode?: boolean } = {},
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_Billing${String(process.pid)}x${String(eventCounter)}x${String(Date.now())}`,
    object: 'event',
    type,
    created: options.created ?? seconds(Date.now()),
    livemode: options.livemode ?? false,
    ...(options.account === undefined ? {} : { account: options.account }),
    data: { object },
  };
}

/** Delivers an event the way Stripe does: the body, and its signature over those bytes. */
async function deliver<T = Record<string, unknown>>(
  h: Harness,
  body: Record<string, unknown>,
  secret = SECRET,
): Promise<{ status: number; body: T }> {
  const header = signStripePayload(JSON.stringify(body), secret, seconds(Date.now()));
  return h.call<T>('POST', '/v1/billing/webhook', {
    body,
    headers: { 'stripe-signature': header },
  });
}

function admin(h: Harness): ReturnType<typeof createDatabase> {
  return createDatabase(h.pools.admin);
}

async function planOf(h: Harness, accountId: string): Promise<string> {
  const { rows } = await admin(h).execute<{ plan: string }>(
    sql`SELECT plan FROM accounts WHERE id = ${decodeId('account', accountId)}`,
  );
  return rows[0]?.plan ?? 'none';
}

async function customerOf(h: Harness, accountId: string): Promise<string> {
  const { rows } = await admin(h).execute<{ stripe_customer_id: string | null }>(
    sql`SELECT stripe_customer_id FROM accounts WHERE id = ${decodeId('account', accountId)}`,
  );
  const id = rows[0]?.stripe_customer_id;
  if (id === null || id === undefined) throw new Error('the account has no Stripe customer');
  return id;
}

async function planChanges(
  h: Harness,
  projectId: string,
): Promise<{ environment: string; data: Record<string, unknown> }[]> {
  const { rows } = await admin(h).execute<{ environment: string; data: Record<string, unknown> }>(
    sql`SELECT environment, data FROM events
         WHERE project_id = ${decodeId('project', projectId)} AND type = 'plan.changed'
         ORDER BY seq`,
  );
  return rows;
}

async function account(h: Harness, session: string): Promise<AccountBody> {
  const read = await h.call<AccountBody>('GET', '/v1/dashboard/account', { token: session });
  expect(read.status).toBe(200);
  return read.body;
}

async function seedUsage(
  h: Harness,
  projectId: string,
  month: string,
  bookings: number,
  volume: number,
): Promise<void> {
  await admin(h).execute(sql`
    INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed, payment_volume, currency)
    VALUES (gen_random_uuid(), ${decodeId('project', projectId)}, 'live', ${month}, ${bookings}, ${volume}, 'EUR')
    ON CONFLICT (project_id, environment, month)
    DO UPDATE SET bookings_confirmed = EXCLUDED.bookings_confirmed, payment_volume = EXCLUDED.payment_volume
  `);
}

/** Opens a checkout through the dashboard and plays Stripe completing it. */
async function subscribe(
  h: Harness,
  stripe: FakeBillingStripe,
  who: Customer,
  plan: 'pro' | 'scale',
  created: number,
  periodEnd: number,
  options: { periodStart?: number } = {},
): Promise<{ customer: string; subscription: string }> {
  const opened = await h.call<{ url: string }>('POST', '/v1/dashboard/billing/checkout', {
    token: who.session,
    body: { plan },
  });
  expect(opened.status).toBe(200);
  const customerId = await customerOf(h, who.accountId);
  const session = stripe.checkoutSessions.at(-1)!;
  const subscription = `sub_${who.accountId.slice(5, 21)}${plan}`;
  stripe.completeSession(session.id, subscription);
  stripe.setSubscription({
    id: subscription,
    customer: customerId,
    lookupKey: PLAN_LOOKUP_KEYS[plan],
    status: 'active',
    currentPeriodEnd: periodEnd,
    metadata: { bookrail_account_id: who.accountId },
    ...(options.periodStart === undefined ? {} : { currentPeriodStart: options.periodStart }),
  });
  const completed = await deliver(
    h,
    event(
      'checkout.session.completed',
      {
        id: `cs_test_${subscription}`,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: who.accountId,
        customer: customerId,
        subscription,
        custom_fields: [{ key: 'sdiorpec', type: 'text', text: { value: 'M5UXCR1' } }],
      },
      { created },
    ),
  );
  expect(completed.status).toBe(200);
  return { customer: customerId, subscription };
}

/** The renewal draft of a subscription, as Stripe sends it in `invoice.created`. */
function renewal(
  draft: string,
  customerId: string,
  subscription: string,
  periodEnd: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: draft,
    object: 'invoice',
    billing_reason: 'subscription_cycle',
    status: 'draft',
    customer: customerId,
    parent: { type: 'subscription_details', subscription_details: { subscription } },
    period_end: periodEnd,
    ...extra,
  };
}

// ------------------------------------------------------------------------------------------------

describe('the configuration of Billing', () => {
  const base = {
    STRIPE_SECRET_KEY_TEST: 'sk_test_abc',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_abc',
    STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_abc',
  };

  it('is off without BILLING_STRIPE_MODE', () => {
    expect(loadBillingConfig({ ...base })).toBeNull();
  });

  it('reads the mode, the key of that mode, the secret and the invoice address', () => {
    expect(loadBillingConfig({ ...base, BILLING_STRIPE_MODE: 'test' })).toEqual({
      mode: 'test',
      secretKey: 'sk_test_abc',
      webhookSecret: 'whsec_abc',
      invoiceTo: 'hello@bookrail.dev',
      apiBase: 'https://api.stripe.com',
    });
    expect(
      loadBillingConfig({
        ...base,
        BILLING_STRIPE_MODE: 'live',
        NODE_ENV: 'production',
        BILLING_INVOICE_TO: 'founder@example.com',
      })?.invoiceTo,
    ).toBe('founder@example.com');
  });

  it('refuses to start with half a configuration or with the wrong mode for the machine', () => {
    expect(() => loadBillingConfig({ ...base, BILLING_STRIPE_MODE: 'sandbox' })).toThrow(
      /test or live/,
    );
    expect(() => loadBillingConfig({ ...base, BILLING_STRIPE_MODE: 'live' })).toThrow(
      /NODE_ENV=production/,
    );
    expect(() =>
      loadBillingConfig({ ...base, BILLING_STRIPE_MODE: 'test', NODE_ENV: 'production' }),
    ).toThrow(/pretend plans/);
    expect(() =>
      loadBillingConfig({
        ...base,
        BILLING_STRIPE_MODE: 'test',
        STRIPE_BILLING_WEBHOOK_SECRET: '',
      }),
    ).toThrow(/STRIPE_BILLING_WEBHOOK_SECRET/);
    expect(() =>
      loadBillingConfig({
        ...base,
        BILLING_STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY_TEST: 'sk_live_x',
      }),
    ).toThrow(/STRIPE_SECRET_KEY_TEST/);
    expect(() =>
      loadBillingConfig({
        ...base,
        BILLING_STRIPE_MODE: 'live',
        NODE_ENV: 'production',
        STRIPE_API_BASE: 'http://127.0.0.1:1',
      }),
    ).toThrow(/STRIPE_API_BASE/);
  });
});

describe('the Checkout Session of a plan', () => {
  it('anchors on midnight UTC of the first of the next month', () => {
    expect(firstOfNextMonthUtc(Date.UTC(2026, 8, 24, 13, 5))).toBe(Date.UTC(2026, 9, 1));
    expect(firstOfNextMonthUtc(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(Date.UTC(2027, 0, 1));
    expect(firstOfNextMonthUtc(Date.UTC(2026, 9, 1))).toBe(Date.UTC(2026, 10, 1));
  });

  /**
   * The edges of a month. The anchor is computed by Stripe when the customer pays, from the
   * configuration (`renewalAnchorOf` is that computation), so a page opened before midnight and
   * paid after it still renews in the future; and the session lives twenty-four hours.
   */
  it('renews in the future however late in the month the page was opened and paid', () => {
    const lastDay = Date.UTC(2026, 8, 30, 23, 40);
    const firstDay = Date.UTC(2026, 9, 1, 0, 10);
    const opened = checkoutSessionForm({
      plan: 'pro',
      priceId: 'price_pro',
      customer: 'cus_1',
      accountId: '0190f2a1-7c3e-7d4b-8a9f-0123456789ab',
      siteUrl: 'https://bookrail.dev',
      now: lastDay,
    });
    // No timestamp that could be in the past by the time the customer pays.
    expect(opened.subscription_data).toMatchObject({
      billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
    });
    expect(opened.subscription_data).not.toHaveProperty('billing_cycle_anchor');
    expect(opened.expires_at).toBe(seconds(lastDay) + CHECKOUT_SESSION_LIFETIME_S);
    // Paid on the last day at 23:40: renews on the first of October.
    expect(renewalAnchorOf(lastDay)).toBe(Date.UTC(2026, 9, 1));
    // Paid after midnight: renews on the first of November, never on a first already gone.
    expect(renewalAnchorOf(firstDay)).toBe(Date.UTC(2026, 10, 1));
    expect(renewalAnchorOf(firstDay)).toBeGreaterThan(firstDay);
    // The first period is the pro rata of one month at most.
    for (const paidAt of [lastDay, firstDay, Date.UTC(2027, 1, 28, 12), Date.UTC(2027, 0, 31)]) {
      const days = (renewalAnchorOf(paidAt) - paidAt) / 86_400_000;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(31);
    }
    // What a timestamp computed from the expiry of the session would have been on the last day:
    // the first of November, more than one period after a payment on 30 September, which Stripe
    // refuses ("within the first billing period").
    expect(firstOfNextMonthUtc(lastDay + CHECKOUT_SESSION_LIFETIME_S * 1000)).toBe(
      Date.UTC(2026, 10, 1),
    );
  });

  it('asks Stripe for exactly what the product needs', () => {
    const accountId = '0190f2a1-7c3e-7d4b-8a9f-0123456789ab';
    const form = checkoutSessionForm({
      plan: 'pro',
      priceId: 'price_pro',
      customer: 'cus_1',
      accountId,
      siteUrl: 'https://bookrail.dev/',
      now: Date.UTC(2026, 8, 24, 13, 5),
    });
    expect(form).toEqual({
      mode: 'subscription',
      customer: 'cus_1',
      customer_update: { address: 'auto', name: 'auto' },
      client_reference_id: encodeId('account', accountId),
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true, required: 'if_supported' },
      // Stripe Tax computes the tax from the address and the VAT number typed in Checkout.
      automatic_tax: { enabled: true },
      line_items: [{ price: 'price_pro', quantity: 1 }],
      subscription_data: {
        billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
        proration_behavior: 'create_prorations',
        metadata: { bookrail_account_id: encodeId('account', accountId), bookrail_plan: 'pro' },
      },
      custom_fields: [
        {
          key: 'sdiorpec',
          label: { type: 'custom', custom: 'SdI recipient code or PEC (Italian companies)' },
          type: 'text',
          optional: true,
          text: { maximum_length: 100 },
        },
      ],
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message:
            'I accept the [Terms of Service](https://bookrail.dev/terms) and the [Data Processing Agreement](https://bookrail.dev/dpa) on behalf of my business.',
        },
      },
      metadata: { bookrail_account_id: encodeId('account', accountId), bookrail_plan: 'pro' },
      // Twenty-three hours and fifty-five minutes: short of Stripe's twenty-four by a margin.
      expires_at: seconds(Date.UTC(2026, 8, 25, 13, 0)),
      success_url: 'https://bookrail.dev/dashboard/?checkout=success',
      cancel_url: 'https://bookrail.dev/dashboard/?checkout=cancel',
    });
    // Stripe's limits on a custom field: an alphanumeric key, a label of at most 50 characters.
    expect('sdiorpec').toMatch(/^[a-z0-9]+$/);
    expect('SdI recipient code or PEC (Italian companies)'.length).toBeLessThanOrEqual(50);
  });
});

describe('the overage of a month', () => {
  it('bills the bookings over the quantity and the per mille of the volume, in cents', () => {
    const overage = computeOverage(
      wholeMonthOn('pro'),
      { bookingsConfirmed: 5200, paymentVolume: 123_450, currency: 'EUR' },
      PLANS,
    );
    expect(overage).toMatchObject({
      bookingsIncluded: 5000,
      bookingsOver: 200,
      bookingUnitAmount: 3,
      bookingsAmount: 600,
      paymentsPerMille: 4,
      paymentsAmount: 494,
    });
    const scale = computeOverage(
      wholeMonthOn('scale'),
      { bookingsConfirmed: 10, paymentVolume: -500, currency: 'EUR' },
      PLANS,
    );
    expect(scale).toMatchObject({ bookingsOver: 0, bookingsAmount: 0, paymentsAmount: 0 });
    // The free plan refuses at its threshold instead, and a contract is billed by contract.
    expect(
      computeOverage(
        wholeMonthOn('free'),
        { bookingsConfirmed: 9999, paymentVolume: 1, currency: null },
        PLANS,
      ),
    ).toBeNull();
    expect(
      computeOverage(
        wholeMonthOn('enterprise'),
        { bookingsConfirmed: 9999, paymentVolume: 1, currency: null },
        PLANS,
      ),
    ).toBeNull();
  });

  it('includes the quantities of each plan pro rata by its days, rounded up, and bills at the prices of the last day', () => {
    const month = (
      days: Partial<Record<'free' | 'pro' | 'scale' | 'enterprise', number>>,
      daysInMonth: number,
      plan: string | null,
    ): MonthOfPlans => ({
      plan,
      daysInMonth,
      days: { free: 0, pro: 0, scale: 0, enterprise: 0, ...days },
    });
    const usage = { bookingsConfirmed: 30_000, paymentVolume: 1_000_000, currency: 'EUR' };
    // Pro all of October, then Scale for its last day (a move up on the 31st at 23:00: the day
    // of the move counts on the new plan): (5,000 × 30 + 50,000 × 1) / 31 = 6,451.6 → 6,452.
    const upLastDay = computeOverage(month({ pro: 30, scale: 1 }, 31, 'scale'), usage, PLANS)!;
    expect(upLastDay).toMatchObject({
      plan: 'scale',
      bookingsIncluded: 6452,
      bookingsOver: 30_000 - 6452,
      bookingUnitAmount: 2,
      bookingsAmount: (30_000 - 6452) * 2,
      paymentVolumeIncluded: 0,
      paymentsPerMille: 3,
      paymentsAmount: 3000,
    });
    // The review's case: the move up the last evening no longer turns 1,350 € into a few euro.
    expect(upLastDay.bookingsAmount).toBeGreaterThan(40_000);
    // Free until the 14th of a 28 day February, Pro from the 15th: (1,000 × 14 + 5,000 × 14) / 28
    // = 3,000 bookings, and (100,000 × 14) / 28 = 50,000 cents of volume without the per mille.
    const february = computeOverage(month({ free: 14, pro: 14 }, 28, 'pro'), usage, PLANS)!;
    expect(february).toMatchObject({
      bookingsIncluded: 3000,
      paymentVolumeIncluded: 50_000,
      paymentsAmount: 3800, // 0.4 % of 950,000
    });
    // Rounded up, never down: (1,000 × 1 + 5,000 × 30) / 31 = 4,870.97 → 4,871; volume
    // 100,000 / 31 = 3,225.8 → 3,226.
    expect(includedOf(month({ free: 1, pro: 30 }, 31, 'pro'), PLANS)).toEqual({
      bookings: 4871,
      paymentVolume: 3226,
    });
    // A subscription closed on the 10th for a failed payment: billed at Pro's prices for the days
    // Pro served, with the free quantities for the rest.
    expect(computeOverage(month({ pro: 9, free: 21 }, 30, 'pro'), usage, PLANS)).toMatchObject({
      plan: 'pro',
      bookingsIncluded: 2200,
      paymentVolumeIncluded: 70_000,
    });
    // A day on a contract: billed by the contract.
    expect(computeOverage(month({ pro: 29, enterprise: 1 }, 30, 'pro'), usage, PLANS)).toBeNull();
  });

  it('writes one line per amount, with the period, the metadata and a description with the base, and no tax rate', () => {
    const overage = computeOverage(
      wholeMonthOn('pro'),
      { bookingsConfirmed: 5200, paymentVolume: 123_450, currency: 'EUR' },
      PLANS,
    )!;
    const lines = overageLines({
      overage,
      month: '2026-09',
      accountId: 'a',
      customer: 'cus_1',
      invoice: 'in_1',
    });
    expect(lines.map((line) => line.kind)).toEqual(['bookings', 'payments']);
    // Stripe Tax computes the tax on the invoice: no rate on the line.
    expect(lines[0]?.form).not.toHaveProperty('tax_rates');
    expect(lines[0]?.form).toMatchObject({
      customer: 'cus_1',
      invoice: 'in_1',
      quantity: 200,
      price_data: { currency: 'eur', unit_amount: 3, tax_behavior: 'exclusive' },
      metadata: { bookrail_month: '2026-09', bookrail_kind: 'bookings', bookrail_plan: 'pro' },
      period: { start: seconds(Date.UTC(2026, 8, 1)), end: seconds(Date.UTC(2026, 9, 1)) - 1 },
    });
    expect(lines[0]?.form.description).toBe(
      'Bookings over the 5,000 included, September 2026: 200 × €0.03',
    );
    expect(lines[1]?.form).toMatchObject({ quantity: 1, price_data: { unit_amount: 494 } });
    expect(lines[1]?.form.description).toBe(
      'Orchestrated payments, September 2026: 0.4% of €1,234.50',
    );
    const pending = overageLines({
      overage,
      month: '2026-09',
      accountId: 'a',
      customer: 'cus_1',
      invoice: null,
    });
    expect(pending[0]?.form.invoice).toBeUndefined();
  });
});

describe('the data of an electronic invoice', () => {
  const base: InvoiceData = {
    stripeInvoiceId: 'in_1',
    number: 'BR-0001',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
    paidAt: '2026-10-01T06:30:00.000Z',
    currency: 'eur',
    accountId: 'acct_1',
    customerName: 'Padel Roma Srl',
    customerEmail: 'amministrazione@padelroma.example.com',
    taxIdType: 'eu_vat',
    taxIdValue: 'IT12345678901',
    taxIdVerification: 'verified',
    country: 'IT',
    address: {
      line1: 'Via Roma 1',
      line2: null,
      postal_code: '00100',
      city: 'Roma',
      state: 'RM',
      country: 'IT',
    },
    sdiOrPec: 'M5UXCR1',
    vatTreatment: 'it_vat',
    lines: [
      {
        description: '1 × Bookrail (at €29.00 / month)',
        amount: 2900,
        taxAmount: 638,
        taxRatePercent: 22,
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
      },
      {
        description: 'Bookings over the 5,000 included, September 2026: 200 × €0.03',
        amount: 600,
        taxAmount: 132,
        taxRatePercent: 22,
        periodStart: null,
        periodEnd: null,
      },
    ],
    subtotal: 3500,
    tax: 770,
    total: 4270,
  };

  it('says everything the invoice needs, in Italian, for an Italian company with VAT', () => {
    const message = invoiceDataMessage(INVOICE_TO, base);
    expect(message.to).toBe(INVOICE_TO);
    expect(message.subject).toBe('Fattura da emettere: Padel Roma Srl 42,70 EUR');
    for (const fact of [
      "Data dell'incasso: 2026-10-01",
      'Fattura Stripe: BR-0001',
      'https://invoice.stripe.com/i/1',
      'Ragione sociale: Padel Roma Srl',
      'IT12345678901 (eu_vat)',
      'Verifica di Stripe: verified',
      'Paese: IT',
      'Via Roma 1, 00100 Roma RM, IT',
      'Codice SdI o PEC: M5UXCR1',
      'imponibile 29,00 EUR, aliquota 22 %, IVA 6,38 EUR, periodo 2026-10-01 - 2026-11-01',
      'Imponibile: 35,00 EUR',
      'IVA: 7,70 EUR',
      'Totale: 42,70 EUR',
      'Regime IVA: IVA ordinaria, cliente italiano',
    ]) {
      expect(message.text, fact).toContain(fact);
    }
    expect(message.text).not.toContain('ATTENZIONE');
    expect(message.text).not.toContain(String.fromCharCode(0x2014));
  });

  it('names the reverse charge for the EU, and warns first when VIES did not verify the number', () => {
    const verified = invoiceDataMessage(INVOICE_TO, {
      ...base,
      country: 'DE',
      taxIdValue: 'DE123456789',
      vatTreatment: 'eu_reverse_charge',
      tax: 0,
      total: 3500,
    });
    expect(verified.text).toContain('art. 7-ter DPR 633/72');
    expect(verified.text).toContain('reverse charge');
    expect(verified.text.startsWith('ATTENZIONE')).toBe(false);
    const unverified = invoiceDataMessage(INVOICE_TO, {
      ...base,
      country: 'DE',
      vatTreatment: 'eu_reverse_charge',
      taxIdVerification: 'unverified',
    });
    expect(
      unverified.text.startsWith('ATTENZIONE: la partita IVA UE non risulta verificata da VIES'),
    ).toBe(true);
  });

  it('says not subject outside the EU', () => {
    const outside = invoiceDataMessage(INVOICE_TO, {
      ...base,
      country: 'US',
      vatTreatment: 'outside_eu',
      taxIdVerification: null,
    });
    expect(outside.text).toContain('Operazione non soggetta ad IVA, art. 7-ter DPR 633/72');
    expect(outside.text.startsWith('ATTENZIONE')).toBe(false);
  });

  it('writes the monthly CSV with a semicolon and decimal commas, quoting what has to be', () => {
    const csv = monthlyInvoiceCsv([
      {
        stripeInvoiceId: 'in_1',
        number: 'BR-0001',
        paidAt: '2026-09-30T22:30:00.000Z',
        customerName: 'Padel; Roma "Srl"',
        taxIdValue: 'IT12345678901',
        taxIdVerification: 'verified',
        country: 'IT',
        sdiOrPec: null,
        vatTreatment: 'it_vat',
        currency: 'eur',
        subtotal: 2900,
        tax: 638,
        total: 3538,
        hostedInvoiceUrl: null,
      },
    ]);
    const [header, row] = csv.split('\r\n');
    expect(header?.startsWith('data_incasso;numero_stripe;fattura_stripe;ragione_sociale')).toBe(
      true,
    );
    // 22:30 UTC on 30 September is the first of October in Rome.
    expect(row).toBe(
      '2026-10-01;BR-0001;in_1;"Padel; Roma ""Srl""";IT12345678901;verified;IT;;it_vat;EUR;29,00;6,38;35,38;',
    );
  });

  it('keeps a formula typed by a customer from becoming one when the CSV is opened', () => {
    expect(campo('=HYPERLINK("https://example.com","x")')).toBe(
      '"\'=HYPERLINK(""https://example.com"",""x"")"',
    );
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(
        campo(`${lead}1+1`).replace(/^"/, '').startsWith(`'${lead}`),
        JSON.stringify(lead),
      ).toBe(true);
    }
    expect(campo('Padel Roma Srl')).toBe('Padel Roma Srl');
    expect(campo(null)).toBe('');
    const csv = monthlyInvoiceCsv([
      {
        stripeInvoiceId: 'in_1',
        number: null,
        paidAt: '2026-10-01T06:00:00.000Z',
        customerName: '@SUM(A1:A9)',
        taxIdValue: '+39 000',
        taxIdVerification: null,
        country: 'IT',
        sdiOrPec: null,
        vatTreatment: 'it_vat',
        currency: 'eur',
        subtotal: -100,
        tax: 0,
        total: 100,
        hostedInvoiceUrl: null,
      },
    ]);
    expect(csv).toContain(";'@SUM(A1:A9);'+39 000;");
    // An amount written by the code stays a number, a negative one too.
    expect(csv).toContain(';-1,00;0,00;1,00;');
  });

  it('retries the monthly list of invoices, five times within a day', () => {
    expect(BILLING_INVOICE_LIST_RETRIES).toEqual({
      retryLimit: 5,
      retryDelay: 1800,
      retryBackoff: true,
    });
    const { retryLimit, retryDelay } = BILLING_INVOICE_LIST_RETRIES;
    const total = Array.from({ length: retryLimit }, (_, n) => retryDelay * 2 ** n).reduce(
      (sum, delay) => sum + delay,
      0,
    );
    expect(total).toBeLessThan(24 * 3600);
  });

  it('knows which countries are in the Union', () => {
    expect(EU_COUNTRIES).toHaveLength(27);
    expect(vatTreatmentOf('it')).toBe('it_vat');
    expect(vatTreatmentOf('FR')).toBe('eu_reverse_charge');
    expect(vatTreatmentOf('CH')).toBe('outside_eu');
    expect(vatTreatmentOf(null)).toBe('outside_eu');
  });
});

// ------------------------------------------------------------------------------------------------

describe('the catalogue on Stripe', () => {
  let stripe: FakeBillingStripe;
  let client: StripeBillingClient;

  beforeAll(async () => {
    stripe = await startFakeBillingStripe();
    client = new StripeBillingClient({ secretKey: 'sk_test_catalogue', apiBase: stripe.url });
  });

  afterAll(async () => {
    await stripe.close();
  });

  it('is incomplete before the setup, and the API says so rather than guessing', async () => {
    await expect(resolveCatalog(client)).rejects.toBeInstanceOf(CatalogIncomplete);
  });

  it('is created by the setup, and a second run creates nothing', async () => {
    const first = await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    expect(first.products.map((p) => [p.id, p.action])).toEqual([
      ['bookrail_pro', 'created'],
      ['bookrail_scale', 'created'],
      ['bookrail_bookings_over_quota', 'created'],
      ['bookrail_orchestrated_payments', 'created'],
    ]);
    expect(first.prices.map((p) => p.action)).toEqual(['created', 'created']);
    // Stripe Tax: no tax rate of our own.
    expect(first.taxRates).toEqual([]);
    expect(first.portal.action).toBe('created');
    const counts = (): number[] => [
      stripe.products.size,
      stripe.prices.size,
      stripe.taxRates.size,
      stripe.portalConfigurations.size,
    ];
    const afterFirst = counts();
    expect(afterFirst).toEqual([4, 2, 0, 1]);
    for (const product of stripe.products.values()) {
      expect(product.tax_code, product.id).toBe('txcd_10103001');
    }
    expect(stripe.products.get('bookrail_pro')).toMatchObject({
      name: 'Bookrail Pro',
      metadata: { bookrail_plan: 'pro' },
    });
    expect(stripe.products.get('bookrail_scale')).toMatchObject({ name: 'Bookrail Scale' });

    const second = await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    expect(counts()).toEqual(afterFirst);
    expect(second.products.every((p) => p.action === 'unchanged')).toBe(true);
    expect(second.prices.every((p) => p.action === 'unchanged')).toBe(true);
    expect(second.taxRates).toEqual([]);
    // The portal says what the code says: nothing to update (S7).
    expect(second.portal).toEqual({ id: first.portal.id, action: 'unchanged' });
    expect(stripe.of('POST', `/v1/billing_portal/configurations/${first.portal.id}`)).toEqual([]);

    // What it made says what the code says.
    const pro = [...stripe.prices.values()].find((p) => p.lookup_key === 'bookrail_pro_monthly');
    expect(pro).toMatchObject({
      unit_amount: 2900,
      currency: 'eur',
      tax_behavior: 'exclusive',
      product: 'bookrail_pro',
      recurring: { interval: 'month' },
    });
    const scale = [...stripe.prices.values()].find(
      (p) => p.lookup_key === 'bookrail_scale_monthly',
    );
    expect(scale).toMatchObject({ unit_amount: 24_900, product: 'bookrail_scale' });
    const portal = [...stripe.portalConfigurations.values()][0] as Record<string, unknown>;
    const features = portal.features as Record<string, Record<string, unknown>>;
    expect(features.subscription_cancel).toMatchObject({ enabled: 'true', mode: 'at_period_end' });
    // The portal changes no plan: one product per plan, and the dashboard makes the changes.
    expect(features.subscription_update).toEqual({ enabled: 'false' });
    expect(features.customer_update).toMatchObject({
      enabled: 'true',
      // The fiscal data are not the customer's to change in the portal (they write to Bookrail).
      allowed_updates: ['email', 'name'],
    });

    const catalog = await resolveCatalog(client);
    expect(catalog.prices.pro.id).toBe(pro?.id);
  });

  it('moves a catalogue made before Stripe Tax and the two products onto the new one', async () => {
    const old = await startFakeBillingStripe();
    const oldClient = new StripeBillingClient({ secretKey: 'sk_test_old', apiBase: old.url });
    try {
      // What the first two deliveries made: one product for both plans, and a tax rate per country.
      await oldClient.createProduct({ id: 'bookrail_plan', name: 'Bookrail' });
      for (const [plan, amount] of [
        ['pro', 2900],
        ['scale', 24_900],
      ] as const) {
        await oldClient.createPrice({
          product: 'bookrail_plan',
          unit_amount: amount,
          currency: 'eur',
          recurring: { interval: 'month' },
          tax_behavior: 'exclusive',
          lookup_key: `bookrail_${plan}_monthly`,
          metadata: { bookrail_plan: plan },
        });
      }
      await oldClient.createTaxRate({
        display_name: 'IVA',
        percentage: 22,
        inclusive: false,
        country: 'IT',
        metadata: { bookrail_tax: 'it_vat_22' },
      });
      const report = await setupStripeBillingCatalog(oldClient, { siteUrl: SITE_URL });
      expect(report.prices.map((p) => p.action)).toEqual(['replaced', 'replaced']);
      expect(report.products).toContainEqual({ id: 'bookrail_plan', action: 'archived' });
      expect(report.taxRates.map((r) => [r.key, r.action])).toEqual([['it_vat_22', 'archived']]);
      expect(old.products.get('bookrail_plan')?.active).toBe(false);
      expect([...old.taxRates.values()].every((rate) => rate.active === false)).toBe(true);
      const pro = [...old.prices.values()].find((p) => p.lookup_key === 'bookrail_pro_monthly');
      expect(pro?.product).toBe('bookrail_pro');
      // A second run archives nothing more.
      const again = await setupStripeBillingCatalog(oldClient, { siteUrl: SITE_URL });
      expect(again.taxRates).toEqual([]);
      expect(again.products.every((p) => p.action === 'unchanged')).toBe(true);
    } finally {
      await old.close();
    }
  });

  it('refuses, like Stripe, the checkout and the portal of the second delivery', async () => {
    // The two answers of the sandbox on 24 September 2026 that the fake did not give then: with
    // them, the suite would have been red on S1 and S2 before the proof in the sandbox.
    const fake = await startFakeBillingStripe();
    const fakeClient = new StripeBillingClient({
      secretKey: 'sk_test_refusals',
      apiBase: fake.url,
    });
    try {
      await fakeClient.createProduct({ id: 'bookrail_plan', name: 'Bookrail' });
      const both = [];
      for (const [plan, amount] of [
        ['pro', 2900],
        ['scale', 24_900],
      ] as const) {
        both.push(
          await fakeClient.createPrice({
            product: 'bookrail_plan',
            unit_amount: amount,
            currency: 'eur',
            recurring: { interval: 'month' },
            tax_behavior: 'exclusive',
            lookup_key: `bookrail_${plan}_monthly`,
          }),
        );
      }
      // One product with a monthly Pro and a monthly Scale, offered in the portal.
      await expect(
        fakeClient.createPortalConfiguration({
          features: {
            subscription_update: {
              enabled: true,
              default_allowed_updates: ['price'],
              products: [{ product: 'bookrail_plan', prices: both.map((price) => price.id) }],
            },
          },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('unique billing intervals') });
      // The per country rates of Checkout.
      await expect(
        fakeClient.createCheckoutSession({
          mode: 'subscription',
          line_items: [{ price: both[0]?.id, quantity: 1, dynamic_tax_rates: ['txr_x'] }],
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('dynamic_tax_rates') });
      // Stripe Tax on an existing customer without an address, and a tax id without its name.
      const customer = await fakeClient.createCustomer({
        idempotencyKey: 'refusals-customer',
        email: null,
        name: 'Acme',
        metadata: {},
      });
      const form = checkoutSessionForm({
        plan: 'pro',
        priceId: both[0]?.id ?? '',
        customer: customer.id,
        accountId: '0192a3b4-0000-7000-8000-000000000001',
        siteUrl: SITE_URL,
        now: Date.now(),
      });
      await expect(
        fakeClient.createCheckoutSession({ ...form, customer_update: { name: 'auto' } }),
      ).rejects.toMatchObject({ message: expect.stringContaining('customer_update[address]') });
      await expect(
        fakeClient.createCheckoutSession({ ...form, customer_update: { address: 'auto' } }),
      ).rejects.toMatchObject({ message: expect.stringContaining('customer_update[name]') });
      // The form of the code is accepted.
      await expect(fakeClient.createCheckoutSession(form)).resolves.toMatchObject({
        url: expect.stringContaining('https://'),
      });
      // The headline of the portal: at most 60 characters (S4), as the sandbox answered.
      const headline = portalConfigurationForm({ siteUrl: SITE_URL }).business_profile as {
        headline: string;
      };
      expect(headline.headline.length).toBeLessThanOrEqual(60);
      await expect(
        fakeClient.createPortalConfiguration({
          business_profile: { headline: 'x'.repeat(61) },
          features: { invoice_history: { enabled: true } },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('at most 60 characters') });
      // And the portal of the code, on the two products the setup makes.
      await expect(
        setupStripeBillingCatalog(fakeClient, { siteUrl: SITE_URL }),
      ).resolves.toMatchObject({ portal: { action: 'created' } });
      // Schedules (T7): a second `from_subscription` on a subscription that has one, and a first
      // phase that moves the start of the phase under way.
      fake.setSubscription({
        id: 'sub_Refusals1',
        customer: customer.id,
        lookupKey: 'bookrail_scale_monthly',
        status: 'active',
        currentPeriodEnd: seconds(Date.now()) + 86_400,
      });
      const schedule = await fakeClient.createScheduleFromSubscription('sub_Refusals1', 'k1');
      await expect(
        fakeClient.createScheduleFromSubscription('sub_Refusals1', 'k2'),
      ).rejects.toMatchObject({ message: expect.stringContaining('already attached') });
      await expect(
        fakeClient.updateSchedule(schedule.id, {
          phases: [
            {
              items: [{ price: 'price_x', quantity: 1 }],
              start_date: (schedule.phaseStart ?? 0) + 60,
              end_date: (schedule.phaseEnd ?? 0) + 60,
            },
          ],
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('current phase') });
      // A move up that waits for its payment takes no `automatic_tax` (T1).
      await expect(
        fakeClient.updateSubscriptionPrice({
          subscription: 'sub_Refusals1',
          item: 'si_sub_Refusals1',
          price: [...fake.prices.values()][0]?.id ?? '',
          idempotencyKey: 'k3',
        }),
      ).resolves.toMatchObject({ pendingUpdate: null });
    } finally {
      await fake.close();
    }
  });

  it('replaces a price that no longer says what the code says, and keeps its lookup key', async () => {
    const pro = [...stripe.prices.values()].find((p) => p.lookup_key === 'bookrail_pro_monthly')!;
    pro.unit_amount = 1900; // somebody edited it by hand
    forgetCatalog(client);
    const report = await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    expect(report.prices.find((p) => p.plan === 'pro')?.action).toBe('replaced');
    expect(pro.active).toBe(false);
    expect(pro.lookup_key).toBeNull();
    const fresh = [...stripe.prices.values()].find((p) => p.lookup_key === 'bookrail_pro_monthly');
    expect(fresh?.unit_amount).toBe(2900);

    // A subscription made on the old price still names its plan: the lookup key has moved and
    // the catalogue no longer lists the price, but its metadata says Pro.
    const catalog = await resolveCatalog(client);
    const old = priceOf(pro)!;
    expect(old.lookupKey).toBeNull();
    expect(catalog.planOfPrice.has(old.id)).toBe(false);
    expect(planOfPrice(old, catalog)).toBe('pro');
    expect(
      planOfPrice(
        {
          id: 'price_x',
          lookupKey: null,
          metadata: {},
          productMetadata: { bookrail_plan: 'scale' },
        },
        catalog,
      ),
    ).toBe('scale');
    expect(planOfPrice({ id: 'price_y', lookupKey: null, metadata: {} }, catalog)).toBeNull();
  });

  it('never sends Stripe-Account: this is the seller, not the platform acting for somebody', () => {
    expect(stripe.requests.length).toBeGreaterThan(0);
    expect(stripe.requests.filter((request) => 'stripe-account' in request.headers)).toEqual([]);
    expect(
      stripe.requests.every((request) => request.headers['stripe-version'] !== undefined),
    ).toBe(true);
  });
});

describe('the setup command', () => {
  const run = promisify(execFile);
  const ENTRY = fileURLToPath(new URL('../src/billing-setup-main.ts', import.meta.url));
  const WRAPPER = fileURLToPath(
    new URL('../../../infra/billing/setup-stripe-billing.mjs', import.meta.url),
  );
  let stripe: FakeBillingStripe;

  beforeAll(async () => {
    stripe = await startFakeBillingStripe();
  });

  afterAll(async () => {
    await stripe.close();
  });

  it('runs twice against the fake, creating everything once and printing no key', async () => {
    const env = {
      ...process.env,
      STRIPE_SECRET_KEY_TEST: 'sk_test_definitely_not_a_real_key',
      STRIPE_API_BASE: stripe.url,
    };
    const first = await run(process.execPath, ['--import', 'tsx', ENTRY, '--mode', 'test'], {
      env,
    });
    const report = JSON.parse(first.stdout) as {
      mode: string;
      prices: { action: string; id: string }[];
    };
    expect(report.mode).toBe('test');
    expect(report.prices.map((price) => price.action)).toEqual(['created', 'created']);
    const counts = [
      stripe.products.size,
      stripe.prices.size,
      stripe.taxRates.size,
      stripe.portalConfigurations.size,
    ];
    const second = await run(process.execPath, ['--import', 'tsx', ENTRY, '--mode', 'test'], {
      env,
    });
    expect([
      stripe.products.size,
      stripe.prices.size,
      stripe.taxRates.size,
      stripe.portalConfigurations.size,
    ]).toEqual(counts);
    expect(
      JSON.parse(second.stdout).prices.map((price: { action: string }) => price.action),
    ).toEqual(['unchanged', 'unchanged']);
    for (const output of [first.stdout, second.stdout, first.stderr, second.stderr]) {
      expect(output).not.toContain('sk_test_definitely_not_a_real_key');
    }
  }, 60_000);

  it('reads its arguments strictly, and refuses a fake Stripe with the live key', async () => {
    expect(parseSetupArgs(['--help'])).toBe('help');
    expect(parseSetupArgs(['--mode', 'live', '--site-url', 'https://bookrail.dev/'])).toEqual({
      mode: 'live',
      siteUrl: 'https://bookrail.dev',
    });
    expect(() => parseSetupArgs([])).toThrow(/--mode/);
    expect(() => parseSetupArgs(['--mode', 'test', '--dry-run'])).toThrow(/Unknown argument/);
    // The live portal sends real customers back to this address: never a development server.
    expect(() => parseSetupArgs(['--mode', 'live', '--site-url', 'http://localhost:4321'])).toThrow(
      /https:\/\/ URL with --mode live/,
    );
    expect(parseSetupArgs(['--mode', 'test', '--site-url', 'http://localhost:4321'])).toEqual({
      mode: 'test',
      siteUrl: 'http://localhost:4321',
    });
    await expect(runSetup({ mode: 'test', siteUrl: SITE_URL }, {})).rejects.toThrow(
      /STRIPE_SECRET_KEY_TEST/,
    );
    await expect(
      runSetup(
        { mode: 'live', siteUrl: SITE_URL },
        { STRIPE_SECRET_KEY_LIVE: 'sk_live_x', STRIPE_API_BASE: stripe.url },
      ),
    ).rejects.toThrow(/refused with --mode live/);
  });

  it('answers --help from the command of the repository, without a build', async () => {
    // The command lives with the private deployment scripts; a checkout without them has only the
    // entry point above to run.
    if (!existsSync(WRAPPER)) {
      expect(parseSetupArgs(['-h'])).toBe('help');
      return;
    }
    const help = await run(process.execPath, [WRAPPER, '--help']);
    expect(help.stdout).toContain('--mode <test|live>');
    expect(help.stdout).toContain('It never prints a key.');
    // The same catalogue as the entry point says: every line of its usage, after the first.
    for (const line of SETUP_USAGE.split('\n').slice(1)) {
      if (line.trim() !== '') expect(help.stdout).toContain(line);
    }
  });
});

/** A Tax Rate as Stripe Tax makes one: the invoices name it by id, and its percentage is here. */
function stripeTaxRate(
  stripe: FakeBillingStripe,
  id: string,
  percentage: number,
  effective?: number,
): void {
  stripe.taxRates.set(id, {
    id,
    object: 'tax_rate',
    active: true,
    percentage,
    effective_percentage: effective ?? percentage,
    inclusive: false,
    metadata: {},
  });
}

// ------------------------------------------------------------------------------------------------

describe('POST /v1/billing/webhook', () => {
  let stripe: FakeBillingStripe;
  let h: Harness;
  let off: Harness;

  beforeAll(async () => {
    stripe = await startFakeBillingStripe();
    const client = new StripeBillingClient({ secretKey: 'sk_test_receiver', apiBase: stripe.url });
    await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    h = createHarness({
      billing: { mode: 'test', client, webhookSecret: SECRET, invoiceTo: INVOICE_TO },
    });
    off = createHarness();
  });

  afterAll(async () => {
    await h.close();
    await off.close();
    await stripe.close();
  });

  it('answers 503 on a deployment where Billing is off', async () => {
    const response = await deliver<ErrorBody>(off, event('invoice.paid', { id: 'in_1' }));
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('billing_not_configured');
  });

  it('refuses a signature made with another secret, and one with no header, touching nothing', async () => {
    const body = event('invoice.paid', { id: 'in_Forged' });
    const forged = await deliver<ErrorBody>(h, body, 'whsec_somebody_else');
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('stripe_signature_invalid');
    const bare = await h.call<ErrorBody>('POST', '/v1/billing/webhook', { body });
    expect(bare.status).toBe(400);
    const { rows } = await admin(h).execute(
      sql`SELECT 1 FROM billing_events WHERE stripe_event_id = ${body.id as string}`,
    );
    expect(rows).toEqual([]);
  });

  it('refuses an event of a connected account: a Connect endpoint pointed at the wrong URL', async () => {
    const response = await deliver<ErrorBody>(
      h,
      event('payment_intent.succeeded', { id: 'pi_1' }, { account: 'acct_1Connected' }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('billing_connect_event');
    expect(response.body.error.fix).toContain('/v1/stripe/webhook/{mode}');
  });

  it('refuses an event of the other mode with a code of its own, not as a bad signature', async () => {
    const response = await deliver<ErrorBody>(
      h,
      event('invoice.paid', { id: 'in_1' }, { livemode: true }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('billing_mode_mismatch');
    expect(response.body.error.fix).toContain('BILLING_STRIPE_MODE');
  });

  it('records an event it does not act on, once, and answers a redelivery as a duplicate', async () => {
    const body = event('customer.discount.created', { id: 'di_1' });
    const first = await deliver<{ received: boolean; duplicate?: boolean }>(h, body);
    expect([first.status, first.body]).toEqual([200, { received: true }]);
    const again = await deliver<{ received: boolean; duplicate?: boolean }>(h, body);
    expect([again.status, again.body]).toEqual([200, { received: true, duplicate: true }]);
    const { rows } = await admin(h).execute<{ outcome: string }>(
      sql`SELECT outcome FROM billing_events WHERE stripe_event_id = ${body.id as string}`,
    );
    expect(rows).toEqual([{ outcome: 'ignored' }]);
  });

  it('carries on after an attempt that failed halfway, rather than calling it a duplicate', async () => {
    const who = await customer(h);
    await h.call('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'pro' },
    });
    const customerId = await customerOf(h, who.accountId);
    const body = event('customer.subscription.updated', { id: 'sub_NotYetAtStripe' });
    // Stripe does not know the subscription yet: the read fails, the claim stays unsettled.
    const failed = await deliver(h, body);
    expect(failed.status).toBe(500);
    stripe.setSubscription({
      id: 'sub_NotYetAtStripe',
      customer: customerId,
      lookupKey: 'bookrail_pro_monthly',
      status: 'active',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
    });
    const retried = await deliver<{ received: boolean; duplicate?: boolean }>(h, body);
    expect([retried.status, retried.body]).toEqual([200, { received: true }]);
    expect(await planOf(h, who.accountId)).toBe('pro');
  });
});

// ------------------------------------------------------------------------------------------------

describe('the checkout and the portal of the dashboard', () => {
  let stripe: FakeBillingStripe;
  let billing: BillingDeps;
  let h: Harness;
  let off: Harness;

  beforeAll(async () => {
    stripe = await startFakeBillingStripe();
    const client = new StripeBillingClient({ secretKey: 'sk_test_dashboard', apiBase: stripe.url });
    await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    billing = { mode: 'test', client, webhookSecret: SECRET, invoiceTo: INVOICE_TO };
    h = createHarness({ billing });
    off = createHarness();
  });

  afterAll(async () => {
    await h.close();
    await off.close();
    await stripe.close();
  });

  it('answers 503 where Billing is off, with the fix', async () => {
    const who = await customer(off);
    const response = await off.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'pro' },
    });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('billing_not_configured');
    const portal = await off.call<ErrorBody>('POST', '/v1/dashboard/billing/portal', {
      token: who.session,
    });
    expect(portal.status).toBe(503);
  });

  it('opens a checkout with the exact parameters, on a customer created once', async () => {
    const who = await customer(h);
    const before = Date.now();
    const opened = await h.call<{ object: string; url: string }>(
      'POST',
      '/v1/dashboard/billing/checkout',
      {
        token: who.session,
        body: { plan: 'pro' },
      },
    );
    const after = Date.now();
    expect(opened.status).toBe(200);
    expect(opened.body.object).toBe('billing_checkout');
    expect(opened.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/);
    expect(opened.headers.get('cache-control')).toBe('no-store');

    const customerId = await customerOf(h, who.accountId);
    const created = stripe.customers.get(customerId)!;
    expect(created).toMatchObject({
      email: who.email,
      metadata: { bookrail_account_id: who.accountId },
    });
    const creation = stripe.of('POST', '/v1/customers').at(-1)!;
    expect(creation.headers['idempotency-key']).toBe(
      `bookrail-customer-${decodeId('account', who.accountId)}`,
    );

    const form = stripe.checkoutSessions.at(-1)!.form as Record<string, unknown>;
    const catalog = await resolveCatalog(billing.client);
    expect(form).toMatchObject({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: who.accountId,
      billing_address_collection: 'required',
      tax_id_collection: { enabled: 'true', required: 'if_supported' },
      consent_collection: { terms_of_service: 'required' },
      customer_update: { address: 'auto', name: 'auto' },
      subscription_data: { proration_behavior: 'create_prorations' },
      success_url: `${SITE_URL}/dashboard/?checkout=success`,
      cancel_url: `${SITE_URL}/dashboard/?checkout=cancel`,
    });
    const items = form.line_items as Record<string, unknown>[];
    expect(items[0]?.price).toBe(catalog.prices.pro.id);
    // Stripe Tax: no rate of our own on the line, the tax computed by Stripe.
    expect(items[0]).not.toHaveProperty('dynamic_tax_rates');
    expect(form.automatic_tax).toEqual({ enabled: 'true' });
    expect((form.subscription_data as Record<string, unknown>).billing_cycle_anchor_config).toEqual(
      { day_of_month: '1', hour: '0', minute: '0', second: '0' },
    );
    const expires = Number(form.expires_at);
    expect(expires).toBeGreaterThanOrEqual(seconds(before) + CHECKOUT_SESSION_LIFETIME_S);
    expect(expires).toBeLessThanOrEqual(seconds(after) + CHECKOUT_SESSION_LIFETIME_S);
    const fields = form.custom_fields as { key: string; optional: string }[];
    expect(fields[0]).toMatchObject({ key: 'sdiorpec', optional: 'true' });

    // A second checkout reuses the customer: one customer per account. And it expires the first
    // session, so that the first page, still open somewhere, can no longer be paid.
    const first = stripe.checkoutSessions.at(-1)!;
    const customersBefore = stripe.customers.size;
    expect(
      (
        await h.call('POST', '/v1/dashboard/billing/checkout', {
          token: who.session,
          body: { plan: 'scale' },
        })
      ).status,
    ).toBe(200);
    expect(stripe.customers.size).toBe(customersBefore);
    expect((stripe.checkoutSessions.at(-1)!.form as Record<string, unknown>).customer).toBe(
      customerId,
    );
    expect(first.status).toBe('expired');
    expect(stripe.of('POST', `/v1/checkout/sessions/${first.id}/expire`)).toHaveLength(1);
    expect(stripe.checkoutSessions.at(-1)!.status).toBe('open');
  });

  it('leaves one payable checkout per account, even when two tabs open one at the same instant', async () => {
    const who = await customer(h);
    // The customer exists first, as it would after any earlier checkout.
    expect(
      (
        await h.call('POST', '/v1/dashboard/billing/checkout', {
          token: who.session,
          body: { plan: 'pro' },
        })
      ).status,
    ).toBe(200);
    const customerId = await customerOf(h, who.accountId);
    const [a, b] = await Promise.all(
      (['pro', 'scale'] as const).map((plan) =>
        h.call('POST', '/v1/dashboard/billing/checkout', { token: who.session, body: { plan } }),
      ),
    );
    expect([a?.status, b?.status]).toEqual([200, 200]);
    const mine = stripe.checkoutSessions.filter(
      (session) => (session.form as Record<string, unknown>).customer === customerId,
    );
    expect(mine).toHaveLength(3);
    expect(mine.filter((session) => session.status === 'open')).toHaveLength(1);
  });

  it('refuses a checkout while a paid one is on its way, or while Stripe already has a live subscription', async () => {
    const who = await customer(h);
    expect(
      (
        await h.call('POST', '/v1/dashboard/billing/checkout', {
          token: who.session,
          body: { plan: 'pro' },
        })
      ).status,
    ).toBe(200);
    // The first page was paid; its event has not arrived yet.
    const paid = stripe.checkoutSessions.at(-1)!;
    stripe.completeSession(paid.id);
    const onItsWay = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'scale' },
    });
    expect(onItsWay.status).toBe(409);
    expect(onItsWay.body.error.code).toBe('subscription_exists');

    // The subscription exists at Stripe, and the database has not heard of it.
    const customerId = await customerOf(h, who.accountId);
    stripe.setSubscription({
      id: `sub_${who.accountId.slice(5, 21)}early`,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'active',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
    });
    // The recorded session is no longer the paid one, so only the list of Stripe can refuse.
    await admin(h).execute(sql`
      UPDATE accounts SET stripe_checkout_session_id = NULL WHERE id = ${decodeId('account', who.accountId)}
    `);
    const atStripe = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'scale' },
    });
    expect(atStripe.status).toBe(409);
    expect(atStripe.body.error.code).toBe('subscription_exists');
    const listing = stripe.of('GET', '/v1/subscriptions').at(-1)!;
    expect(listing.query.get('customer')).toBe(customerId);
    expect(listing.query.get('status')).toBe('all');

    // An unpaid one is dead: the account may buy again.
    stripe.subscriptions.get(`sub_${who.accountId.slice(5, 21)}early`)!.status = 'unpaid';
    expect(
      (
        await h.call('POST', '/v1/dashboard/billing/checkout', {
          token: who.session,
          body: { plan: 'scale' },
        })
      ).status,
    ).toBe(200);
  });

  it('says a live subscription the way the database says it, on every status Stripe has', async () => {
    const { rows } = await admin(h).execute<{ status: string; live: boolean }>(sql`
      SELECT s AS status, billing_subscription_is_live(s) AS live
        FROM unnest(string_to_array(${SUBSCRIPTION_STATUSES.join(',')}, ',')) s
    `);
    expect(rows).toHaveLength(SUBSCRIPTION_STATUSES.length);
    for (const row of rows) {
      expect(isLiveSubscriptionStatus(row.status), row.status).toBe(row.live);
    }
    expect([...LIVE_SUBSCRIPTION_STATUSES]).toEqual(
      rows.filter((row) => row.live).map((row) => row.status),
    );
  });

  it('asks an account that has not accepted the terms for both ticks first, and records them', async () => {
    // An account made before the terms existed: no acceptance on file.
    const email = freshEmail();
    const accountId = crypto.randomUUID();
    await admin(h).execute(sql`
      INSERT INTO accounts (id, name, origin, owner_email) VALUES (${accountId}::uuid, 'Before the terms', 'self_serve', ${email})
    `);
    await admin(h).execute(sql`
      INSERT INTO projects (id, account_id, name) VALUES (gen_random_uuid(), ${accountId}::uuid, 'Default')
    `);
    const session = await signIn(h, email);

    const read = await account(h, session);
    expect(read.terms).toEqual({
      terms_version: LEGAL_VERSIONS.terms,
      dpa_version: LEGAL_VERSIONS.dpa,
      accepted_at: null,
    });

    const refused = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: session,
      body: { plan: 'pro' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('terms_not_accepted');
    const half = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: session,
      body: { plan: 'pro', accept_terms: true },
    });
    expect(half.status).toBe(400);

    const accepted = await h.call('POST', '/v1/dashboard/billing/checkout', {
      token: session,
      body: { plan: 'pro', accept_terms: true, approve_clauses: true },
    });
    expect(accepted.status).toBe(200);
    const { rows } = await admin(h).execute<{
      channel: string;
      terms_version: string;
      dpa_version: string;
    }>(sql`
      SELECT channel, terms_version, dpa_version FROM terms_acceptances WHERE account_id = ${accountId}::uuid
    `);
    expect(rows).toEqual([
      {
        channel: 'dashboard',
        terms_version: LEGAL_VERSIONS.terms,
        dpa_version: LEGAL_VERSIONS.dpa,
      },
    ]);
    expect((await account(h, session)).terms.accepted_at).not.toBeNull();
  });

  it('sends an account with a subscription to the portal, and refuses a contract', async () => {
    const who = await customer(h);
    await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now()),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    const again = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'scale' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('subscription_exists');
    expect(again.body.error.fix).toContain('portal');

    const portal = await h.call<{ object: string; url: string }>(
      'POST',
      '/v1/dashboard/billing/portal',
      { token: who.session },
    );
    expect(portal.status).toBe(200);
    expect(portal.body).toMatchObject({ object: 'billing_portal' });
    const request = stripe.of('POST', '/v1/billing_portal/sessions').at(-1)!;
    expect(request.form).toMatchObject({
      customer: await customerOf(h, who.accountId),
      return_url: `${SITE_URL}/dashboard/`,
      configuration: [...stripe.portalConfigurations.keys()][0],
    });

    const contract = await customer(h);
    await admin(h).execute(
      sql`UPDATE accounts SET plan = 'enterprise' WHERE id = ${decodeId('account', contract.accountId)}`,
    );
    const refused = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: contract.session,
      body: { plan: 'pro' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('plan_is_contract');
  });

  it('opens no portal for an account that never started a checkout', async () => {
    const who = await customer(h);
    const portal = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/portal', {
      token: who.session,
    });
    expect(portal.status).toBe(409);
    expect(portal.body.error.code).toBe('billing_customer_missing');
  });

  it('carries the plan through the sign in link, for the checkout after sign in', async () => {
    const who = await customer(h);
    const asked = await h.call('POST', '/v1/dashboard/login', {
      body: { email: who.email, upgrade: 'scale' },
      headers: freshCaller(),
    });
    expect(asked.status).toBe(202);
    const message = [...(h.mailer?.sent ?? [])].reverse().find((sent) => sent.to === who.email);
    expect(message?.text).toMatch(/\/dashboard\/confirm#token=bls_[A-Za-z0-9_-]+&upgrade=scale/);
  });
});

// ------------------------------------------------------------------------------------------------

describe('from Free to a paid plan and back, end to end', () => {
  let stripe: FakeBillingStripe;
  let billing: BillingDeps;
  let h: Harness;

  beforeAll(async () => {
    stripe = await startFakeBillingStripe();
    const client = new StripeBillingClient({ secretKey: 'sk_test_e2e', apiBase: stripe.url });
    await setupStripeBillingCatalog(client, { siteUrl: SITE_URL });
    billing = { mode: 'test', client, webhookSecret: SECRET, invoiceTo: INVOICE_TO };
    h = createHarness({ billing, plans: SMALL });
  });

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  /** What the worker hands the Billing jobs. */
  const jobDeps = () => ({
    db: createDatabase(h.pools.app),
    logger: silentLogger,
    billing,
    mailer: h.mailer,
    plans: SMALL,
  });

  it('moves Free to Pro on the checkout, lets the next live booking through, and says so everywhere', async () => {
    const who = await customer(h);
    const scenario = await buildScenario(h, who.liveKey, { resources: 6, group: {} });
    const monday = nextMonday();
    const slots = await slotsFor(h, who.liveKey, scenario.serviceId, monday, plusDays(monday, 1));
    const book = (index: number) =>
      h.call<ErrorBody>('POST', '/v1/bookings', {
        token: who.liveKey,
        body: { service_id: scenario.serviceId, start: slots[index]!.start },
      });
    expect((await book(0)).status).toBe(201);
    expect((await book(1)).status).toBe(201);
    const blocked = await book(2);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.fix).toBe(
      'Upgrade in the dashboard: https://bookrail.dev/dashboard/?upgrade=pro. Then retry with a new Idempotency-Key.',
    );

    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now()),
      periodEnd,
    );
    expect(await planOf(h, who.accountId)).toBe('pro');
    expect((await book(2)).status).toBe(201);

    const events = await planChanges(h, who.projectId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environment: 'live',
      data: {
        object: 'plan_change',
        account_id: who.accountId,
        from: 'free',
        to: 'pro',
        reason: 'checkout',
      },
    });
    // The owner is told, after the commit.
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === who.email && m.subject === 'Your Bookrail plan is now Pro',
        ),
      (found) => found.length === 1,
      'the message that the plan is now Pro',
    );

    const read = await account(h, who.session);
    expect(read.account.plan).toBe('pro');
    expect(read.billing).toEqual({
      status: 'active',
      live: true,
      plan: 'pro',
      current_period_end: new Date(periodEnd * 1000).toISOString(),
      cancel_at_period_end: false,
      scheduled_plan: null,
      past_due_since: null,
      grace_ends_at: null,
      unpaid_invoice: null,
    });
    const { rows } = await admin(h).execute<{ sdi_or_pec: string }>(sql`
      SELECT sdi_or_pec FROM billing_subscriptions WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ sdi_or_pec: 'M5UXCR1' }]);

    // `customer.subscription.created` arrives too, and changes nothing more.
    const created = await deliver(
      h,
      event('customer.subscription.created', {
        id: `sub_${who.accountId.slice(5, 21)}pro`,
        customer: customerId,
      }),
    );
    expect(created.status).toBe(200);
    expect(await planChanges(h, who.projectId)).toHaveLength(1);
  });

  it('adds the overage of the closed month to the draft of the renewal once, with the quantities pro rata by day', async () => {
    const who = await customer(h);
    // Pro since the middle of August: 14 days on Free, 17 on Pro. Included bookings
    // ceil((2 × 14 + 3 × 17) / 31) = 3, so 7 over; included volume ceil(100,000 × 14 / 31) =
    // 45,162 cents (Free's 1,000 € for its days), so the per mille is on 123,450 - 45,162 =
    // 78,288 cents: 313 cents.
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 7, 15)),
      seconds(Date.UTC(2026, 8, 1)),
    );
    await seedUsage(h, who.projectId, '2026-08', 10, 123_450);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 8, 1)), {
      customer_address: { country: 'IT' },
    });
    const itemsBefore = stripe.invoiceItems.size;
    expect(
      (
        await deliver(
          h,
          event('invoice.created', invoice, { created: seconds(Date.UTC(2026, 8, 1)) }),
        )
      ).status,
    ).toBe(200);
    const added = [...stripe.invoiceItems.values()].slice(itemsBefore);
    expect(added).toHaveLength(2);
    const [bookings, payments] = added as Record<string, unknown>[];
    expect(bookings).toMatchObject({
      invoice: draft,
      customer: customerId,
      quantity: '7',
      price_data: { unit_amount: '3', currency: 'eur', product: 'bookrail_bookings_over_quota' },
      metadata: { bookrail_month: '2026-08', bookrail_kind: 'bookings' },
    });
    expect(bookings).not.toHaveProperty('tax_rates');
    expect(payments).toMatchObject({
      invoice: draft,
      quantity: '1',
      price_data: { unit_amount: '313', product: 'bookrail_orchestrated_payments' },
    });
    expect(payments?.description).toBe(
      'Orchestrated payments, August 2026: 0.4% of €782.88 (€1,234.50 paid, €451.62 included)',
    );
    const keys = stripe
      .of('POST', '/v1/invoiceitems')
      .slice(-2)
      .map((request) => request.headers['idempotency-key']);
    const account = decodeId('account', who.accountId);
    expect(keys).toEqual([
      `bookrail-overage-${account}-2026-08-bookings-invoice`,
      `bookrail-overage-${account}-2026-08-payments-invoice`,
    ]);

    // A second `invoice.created` for the same renewal (another event id) adds nothing.
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    expect(stripe.invoiceItems.size).toBe(itemsBefore + 2);
    const { rows } = await admin(h).execute<{
      status: string;
      placement: string;
      bookings_amount: string;
      payments_amount: string;
    }>(sql`
      SELECT status, placement, bookings_amount::text AS bookings_amount,
             payments_amount::text AS payments_amount
        FROM billing_overages WHERE account_id = ${account}
    `);
    expect(rows).toEqual([
      {
        status: 'applied',
        placement: 'invoice',
        bookings_amount: '21',
        payments_amount: '313',
      },
    ]);
  });

  it('puts the lines on the next invoice when the draft is no longer a draft, and still once', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 6, 20)),
      seconds(Date.UTC(2026, 7, 1)),
    );
    await seedUsage(h, who.projectId, '2026-07', 5, 0);
    const late = stripe.draftInvoice(customerId);
    stripe.finalize(late);
    const invoice = renewal(late, customerId, subscription, seconds(Date.UTC(2026, 7, 1)));
    const before = stripe.invoiceItems.size;
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      invoice: null,
      quantity: '2',
      price_data: { unit_amount: '3' },
    });
    // The placement was decided by reading the invoice, not by the words of the refusal.
    expect(stripe.of('GET', `/v1/invoices/${late}`)).toHaveLength(1);
    expect(added[0]).not.toHaveProperty('tax_rates');
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    expect(stripe.invoiceItems.size).toBe(before + 1);
    const { rows } = await admin(h).execute<{ placement: string }>(sql`
      SELECT placement FROM billing_overages WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ placement: 'next_invoice' }]);
  });

  it('puts the lines on the next invoice when the draft was deleted', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 5, 20)),
      seconds(Date.UTC(2026, 6, 1)),
    );
    await seedUsage(h, who.projectId, '2026-06', 4, 0);
    const gone = stripe.draftInvoice(customerId);
    stripe.deleteInvoice(gone);
    const before = stripe.invoiceItems.size;
    const invoice = renewal(gone, customerId, subscription, seconds(Date.UTC(2026, 6, 1)));
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    expect(added).toMatchObject([{ invoice: null, quantity: '1' }]);
    const { rows } = await admin(h).execute<{ placement: string; status: string }>(sql`
      SELECT placement, status FROM billing_overages WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ placement: 'next_invoice', status: 'applied' }]);
  });

  it('never takes an idempotency error, or any refusal of a draft that is still a draft, for a finalized invoice', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 4, 20)),
      seconds(Date.UTC(2026, 5, 1)),
    );
    await seedUsage(h, who.projectId, '2026-05', 6, 0);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 5, 1)));
    const before = stripe.invoiceItems.size;

    stripe.failNext('POST', '/v1/invoiceitems', 400, {
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters.',
    });
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(500);
    // Nothing was put anywhere else, and the draft was not even asked about.
    expect(stripe.invoiceItems.size).toBe(before);
    expect(stripe.of('GET', `/v1/invoices/${draft}`)).toHaveLength(0);

    // A redelivery is not the caller that claimed: it adds nothing, and the claim stays open.
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    expect(stripe.invoiceItems.size).toBe(before);

    // The daily reconciliation takes the claim once its lease is over, and puts the line on the
    // draft, which is still a draft.
    await admin(h).execute(sql`
      UPDATE billing_overages SET leased_until = now() - interval '1 second'
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    stripe.failNext('POST', '/v1/invoiceitems', 400, {
      type: 'invalid_request_error',
      message: 'Something else went wrong with this item.',
    });
    const failed = await runBillingReconcile(jobDeps(), { now: Date.UTC(2026, 5, 1, 6, 40) });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    // Still a draft: the refusal was an error, not a reason to move the line.
    expect(stripe.of('GET', `/v1/invoices/${draft}`)).toHaveLength(1);
    expect(stripe.invoiceItems.size).toBe(before);

    await admin(h).execute(sql`
      UPDATE billing_overages SET leased_until = now() - interval '1 second'
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    await runBillingReconcile(jobDeps(), { now: Date.UTC(2026, 5, 1, 6, 40) });
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    expect(added).toMatchObject([{ invoice: draft, quantity: '3' }]);
    const { rows } = await admin(h).execute<{ placement: string; status: string }>(sql`
      SELECT placement, status FROM billing_overages WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ placement: 'invoice', status: 'applied' }]);
  });

  it('adds the lines once when two deliveries of the renewal are handled at the same instant', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'scale',
      seconds(Date.UTC(2026, 3, 20)),
      seconds(Date.UTC(2026, 4, 1)),
    );
    await seedUsage(h, who.projectId, '2026-04', 9, 100_000);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 4, 1)));
    const before = stripe.invoiceItems.size;
    const answers = await Promise.all(
      [0, 1, 2, 3].map(() => deliver(h, event('invoice.created', invoice))),
    );
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    expect(added).toHaveLength(2);
    expect(added.every((item) => item.invoice === draft)).toBe(true);
  });

  it('finds a line already at Stripe before making it again as a pending item', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 2, 20)),
      seconds(Date.UTC(2026, 3, 1)),
    );
    await seedUsage(h, who.projectId, '2026-03', 4, 400_000);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 3, 1)));
    // An earlier attempt put the bookings line on the draft and its answer was lost (or Stripe
    // stored an error under its key while making it): nothing was recorded.
    const before = stripe.invoiceItems.size;
    await billing.client.createInvoiceItem(
      {
        customer: customerId,
        invoice: draft,
        currency: 'eur',
        quantity: 1,
        price_data: {
          currency: 'eur',
          product: 'bookrail_bookings_over_quota',
          unit_amount: 3,
          tax_behavior: 'exclusive',
        },
        metadata: { bookrail_month: '2026-03', bookrail_kind: 'bookings', bookrail_plan: 'pro' },
      },
      'an-earlier-attempt',
    );
    const onDraft = [...stripe.invoiceItems.values()].slice(before);
    expect(onDraft).toHaveLength(1);
    // Then the draft was finalized before the claim was taken.
    stripe.finalize(draft);
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    // The bookings line was found on the invoice, not made again; only the payments line is new,
    // and pending.
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({
      invoice: null,
      metadata: { bookrail_kind: 'payments' },
    });
    const { rows } = await admin(h).execute<{
      stripe_booking_item_id: string;
      placement: string;
    }>(sql`
      SELECT stripe_booking_item_id, placement FROM billing_overages
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ stripe_booking_item_id: onDraft[0]?.id, placement: 'next_invoice' }]);
  });

  it('takes an abandoned claim back when Stripe delivers the renewal again', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 1, 20)),
      seconds(Date.UTC(2026, 2, 1)),
    );
    await seedUsage(h, who.projectId, '2026-02', 5, 0);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 2, 1)));
    const before = stripe.invoiceItems.size;
    stripe.failNext('POST', '/v1/invoiceitems', 500, { type: 'api_error', message: 'boom' });
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(500);
    expect(stripe.invoiceItems.size).toBe(before);
    // Inside the lease of the first caller, a redelivery leaves it alone.
    const within = event('invoice.created', invoice);
    expect((await deliver(h, within)).status).toBe(200);
    expect(stripe.invoiceItems.size).toBe(before);
    // Once the lease is over, the same kind of redelivery takes it back and finishes it.
    await admin(h).execute(sql`
      UPDATE billing_overages SET leased_until = now() - interval '1 second'
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(200);
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    expect(added).toMatchObject([{ invoice: draft, quantity: '2' }]);
    // Stripe keeps the first `500` under its key (T14): the retry that succeeded used its own key,
    // after looking at the draft for a line the failed attempt might have made anyway.
    const keys = stripe
      .of('POST', '/v1/invoiceitems')
      .slice(-2)
      .map((request) => request.headers['idempotency-key'] ?? '');
    expect(keys[0]).not.toMatch(/-retry/);
    expect(keys[1]).toMatch(/-invoice-retry1$/);
    const { rows } = await admin(h).execute<{ status: string; attempts: number }>(sql`
      SELECT status, attempts FROM billing_overages
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ status: 'applied', attempts: 1 }]);
  });

  it('adds no overage to an enterprise account that kept a subscription, and says so', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 1, 20)),
      seconds(Date.UTC(2026, 2, 1)),
    );
    await admin(h).execute(sql`
      UPDATE accounts SET plan = 'enterprise' WHERE id = ${decodeId('account', who.accountId)}
    `);
    await seedUsage(h, who.projectId, '2026-02', 50, 500_000);
    const draft = stripe.draftInvoice(customerId);
    const before = stripe.invoiceItems.size;
    const answer = await deliver(
      h,
      event(
        'invoice.created',
        renewal(draft, customerId, subscription, seconds(Date.UTC(2026, 2, 1))),
      ),
    );
    expect(answer.status).toBe(200);
    expect(stripe.invoiceItems.size).toBe(before);
    const { rows } = await admin(h).execute(sql`
      SELECT 1 FROM billing_overages WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([]);
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) =>
            m.to === INVOICE_TO && m.subject.startsWith('Account Enterprise con un abbonamento'),
        ),
      (found) => found.some((m) => m.text.includes(customerId)),
      'the notice about the enterprise account',
    );
  });

  it('bills the last month of a subscription cancelled at the end of its period, on an invoice of its own', async () => {
    const who = await customer(h);
    const periodEnd = seconds(Date.UTC(2026, 0, 1));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2025, 11, 5)),
      periodEnd,
    );
    await seedUsage(h, who.projectId, '2025-12', 8, 200_000);
    // The portal cancels at the end of the period; on the first Stripe ends it, with no renewal.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'canceled',
      currentPeriodEnd: periodEnd,
      endedAt: periodEnd,
      defaultPaymentMethod: 'pm_Card1',
    });
    const before = stripe.invoiceItems.size;
    const invoicesBefore = stripe.of('POST', '/v1/invoices').length;
    await deliver(
      h,
      event('customer.subscription.deleted', { id: subscription }, { created: periodEnd + 2 }),
    );
    expect(await planOf(h, who.accountId)).toBe('free');
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    // Five bookings over Pro's three at three cents, and 0.4 % of 2 000,00.
    expect(added).toHaveLength(2);
    expect(added.map((item) => item.quantity)).toEqual(['5', '1']);
    const created = stripe.of('POST', '/v1/invoices').slice(invoicesBefore);
    expect(created).toHaveLength(1);
    expect(created[0]?.form).toMatchObject({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: 'true',
      pending_invoice_items_behavior: 'include',
      default_payment_method: 'pm_Card1',
      metadata: { bookrail_month: '2025-12', bookrail_kind: 'final_overage' },
    });
    const invoiceId = [...stripe.invoices.values()].at(-1)!.id;
    expect(added.every((item) => item.invoice === invoiceId)).toBe(true);
    const { rows } = await admin(h).execute<{
      origin: string;
      placement: string;
      status: string;
    }>(sql`
      SELECT origin, placement, status FROM billing_overages
       WHERE account_id = ${decodeId('account', who.accountId)} AND month = '2025-12'
    `);
    expect(rows).toEqual([{ origin: 'final', placement: 'final_invoice', status: 'applied' }]);

    // Another delivery of the end changes nothing and bills nothing more.
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(stripe.of('POST', '/v1/invoices').length).toBe(invoicesBefore + 1);
  });

  it('puts an account where Stripe says it is when the event that ended its subscription never arrived', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'scale',
      seconds(Date.now() - 20 * 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    expect(await planOf(h, who.accountId)).toBe('scale');
    // Ended at Stripe; the receiver was down and `customer.subscription.deleted` is lost.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'canceled',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
      endedAt: seconds(Date.now() - 86_400_000),
    });
    const report = await runBillingReconcile(jobDeps());
    expect(report.subscriptions).toBeGreaterThanOrEqual(1);
    expect(await planOf(h, who.accountId)).toBe('free');
    const last = (await planChanges(h, who.projectId)).at(-1);
    expect(last?.data).toMatchObject({ from: 'scale', to: 'free', reason: 'canceled' });

    // A subscription Stripe no longer knows at all is applied as cancelled too.
    const other = await customer(h);
    const gone = await subscribe(
      h,
      stripe,
      other,
      'pro',
      seconds(Date.now() - 5 * 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    stripe.subscriptions.delete(gone.subscription);
    await runBillingReconcile(jobDeps());
    expect(await planOf(h, other.accountId)).toBe('free');
  });

  it('reports a second live subscription for one account, once, and never swaps it for the first', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    // A second checkout that got through anyway (paid in another tab before it was expired).
    const second = `sub_${who.accountId.slice(5, 21)}second`;
    stripe.setSubscription({
      id: second,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
      metadata: { bookrail_account_id: who.accountId },
    });
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) {
      expect((await deliver(h, event(type, { id: second }))).status).toBe(200);
    }
    expect(await planOf(h, who.accountId)).toBe('pro');
    expect((await account(h, who.session)).billing?.plan).toBe('pro');
    const notices = await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Abbonamento doppio da annullare'),
        ),
      (found) => found.some((m) => m.text.includes(second)),
      'the notice about the second subscription',
    );
    const mine = notices.filter((m) => m.text.includes(second));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain(`da tenere: ${subscription}`);
    expect(mine[0]?.text).toContain(`da annullare e rimborsare: ${second}`);
  });

  it('moves Scale down to Pro from the first, and bills the closed month with Scale', async () => {
    const who = await customer(h);
    const periodEnd = seconds(Date.UTC(2026, 8, 1));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'scale',
      seconds(Date.UTC(2026, 7, 10)),
      periodEnd,
    );
    // The portal schedules the move down at the end of the period.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: 'bookrail_scale_monthly',
      status: 'active',
      currentPeriodEnd: periodEnd,
      scheduleNextLookupKey: 'bookrail_pro_monthly',
    });
    await deliver(
      h,
      event(
        'customer.subscription.updated',
        { id: subscription },
        { created: seconds(Date.UTC(2026, 7, 20)) },
      ),
    );
    expect(await planOf(h, who.accountId)).toBe('scale');
    expect((await account(h, who.session)).billing?.scheduled_plan).toBe('pro');

    // On the first, Stripe moves the subscription and renews it; the move arrives first.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: 'bookrail_pro_monthly',
      status: 'active',
      currentPeriodEnd: seconds(Date.UTC(2026, 9, 1)),
    });
    await deliver(
      h,
      event('customer.subscription.updated', { id: subscription }, { created: periodEnd + 3 }),
    );
    expect(await planOf(h, who.accountId)).toBe('pro');
    expect((await account(h, who.session)).billing?.scheduled_plan).toBeNull();
    const reasons = (await planChanges(h, who.projectId)).map((e) => [
      e.data.from,
      e.data.to,
      e.data.reason,
    ]);
    expect(reasons).toEqual([
      ['free', 'scale', 'checkout'],
      ['scale', 'pro', 'subscription_update'],
    ]);

    await seedUsage(h, who.projectId, '2026-08', 6, 0);
    const draft = stripe.draftInvoice(customerId);
    const before = stripe.invoiceItems.size;
    await deliver(
      h,
      event(
        'invoice.created',
        renewal(draft, customerId, subscription, periodEnd, {
          customer_address: { country: 'IT' },
        }),
      ),
    );
    const added = [...stripe.invoiceItems.values()].slice(before) as Record<string, unknown>[];
    // Scale: four included and two cents each, not Pro's three and three cents.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ quantity: '2', price_data: { unit_amount: '2' } });
  });

  it('gives a failed payment fourteen days, then closes the subscription and the threshold blocks again', async () => {
    const who = await customer(h);
    const scenario = await buildScenario(h, who.liveKey, { resources: 6, group: {} });
    const monday = nextMonday();
    const slots = await slotsFor(h, who.liveKey, scenario.serviceId, monday, plusDays(monday, 1));
    const book = (index: number) =>
      h.call<ErrorBody>('POST', '/v1/bookings', {
        token: who.liveKey,
        body: { service_id: scenario.serviceId, start: slots[index]!.start },
      });
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 40 * 86_400_000),
      seconds(Date.now() - 16 * 86_400_000),
    );
    for (const index of [0, 1, 2]) expect((await book(index)).status).toBe(201);

    // The payment of the renewal fails; Stripe says so fifteen days ago.
    const failedAt = seconds(Date.now() - 15 * 86_400_000);
    // Stripe holds the subscription past_due when it says the payment of the renewal failed, and
    // the failure is delivered before the update of the subscription.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: 'bookrail_pro_monthly',
      status: 'past_due',
      currentPeriodEnd: seconds(Date.now() + 14 * 86_400_000),
    });
    const failed = await deliver(
      h,
      event(
        'invoice.payment_failed',
        {
          id: 'in_FailedRenewal',
          object: 'invoice',
          customer: customerId,
          parent: { type: 'subscription_details', subscription_details: { subscription } },
        },
        { created: failedAt },
      ),
    );
    expect(failed.status).toBe(200);
    await deliver(
      h,
      event('customer.subscription.updated', { id: subscription }, { created: failedAt + 5 }),
    );
    expect(await planOf(h, who.accountId)).toBe('pro');

    const read = await account(h, who.session);
    expect(read.billing).toMatchObject({
      status: 'past_due',
      past_due_since: new Date(failedAt * 1000).toISOString(),
      grace_ends_at: new Date((failedAt + 14 * 86_400) * 1000).toISOString(),
    });
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === who.email && m.subject === 'Your Bookrail payment failed',
        ),
      (found) => found.length === 1,
      'the message about the failed payment',
    );
    // A second failure of the same period does not start anything again, nor write again.
    await deliver(
      h,
      event('invoice.payment_failed', {
        id: 'in_FailedRenewal',
        object: 'invoice',
        customer: customerId,
        parent: { type: 'subscription_details', subscription_details: { subscription } },
      }),
    );

    // A month of use so far: the three bookings, and a paid volume of 1 000,00.
    const month = new Date().toISOString().slice(0, 7);
    await seedUsage(h, who.projectId, month, 3, 100_000);
    const invoicesBefore = stripe.of('POST', '/v1/invoices').length;

    // The net of the fourteen days: the worker cancels at Stripe, with a final invoice of what
    // is pending and no credit, then reads the subscription back and applies it at once.
    const report = await runBillingOverdue(jobDeps());
    expect(report.cancelled).toBeGreaterThanOrEqual(1);
    const deletes = stripe.of('DELETE', `/v1/subscriptions/${subscription}`);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.query.get('invoice_now')).toBe('true');
    expect(deletes[0]?.query.get('prorate')).toBe('false');
    expect(await planOf(h, who.accountId)).toBe('free');
    const last = (await planChanges(h, who.projectId)).at(-1);
    expect(last?.data).toMatchObject({ from: 'pro', to: 'free', reason: 'payment_failed' });
    // The month it ended in is billed on an invoice of its own, at Pro's prices, with the
    // quantities pro rata: Pro until yesterday, Free from today (the day of the change counts on
    // the plan it moved to). The volume Free includes for its days is not charged.
    const today = new Date();
    const daysInMonth = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const proDays = today.getUTCDate() - 1;
    const freeDays = daysInMonth - proDays;
    const includedVolume = Math.ceil((100_000 * freeDays) / daysInMonth);
    const includedBookings = Math.ceil((2 * freeDays + 3 * proDays) / daysInMonth);
    const finals = stripe.of('POST', '/v1/invoices').slice(invoicesBefore);
    if (proDays === 0) {
      // The first of the month: the month was never on Pro, nothing to bill.
      expect(finals).toHaveLength(0);
    } else {
      expect(finals).toHaveLength(1);
      expect(finals[0]?.form).toMatchObject({
        customer: customerId,
        pending_invoice_items_behavior: 'include',
        metadata: { bookrail_month: month, bookrail_kind: 'final_overage' },
      });
      const finalItems = [...stripe.invoiceItems.values()].filter(
        (item) =>
          item.customer === customerId && item.invoice === [...stripe.invoices.values()].at(-1)?.id,
      );
      const payments = perMilleOf(100_000 - includedVolume, 4);
      expect(finalItems).toMatchObject([
        ...(3 > includedBookings
          ? [{ quantity: String(3 - includedBookings), price_data: { unit_amount: '3' } }]
          : []),
        { quantity: '1', price_data: { unit_amount: String(payments) } },
      ]);
    }
    // The event arrives afterwards and changes nothing more.
    const changes = (await planChanges(h, who.projectId)).length;
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(await planOf(h, who.accountId)).toBe('free');
    expect(await planChanges(h, who.projectId)).toHaveLength(changes);

    // Back on Free: three confirmed this month, the threshold is two, the next one is refused.
    expect((await book(3)).status).toBe(402);
    // And nothing was deleted.
    const { rows } = await admin(h).execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM bookings WHERE project_id = ${decodeId('project', who.projectId)} AND environment = 'live'
    `);
    expect(rows[0]?.n).toBe('3');
    // A second run finds nothing more to cancel.
    const again = await runBillingOverdue(jobDeps());
    expect(stripe.of('DELETE', `/v1/subscriptions/${subscription}`)).toHaveLength(1);
    expect(again.failed).toBe(0);
  });

  it('records every paid invoice once, mails its data, and lists the month with a CSV', async () => {
    const italian = await customer(h);
    const german = await customer(h);
    const american = await customer(h);
    // The taxes as Stripe Tax computes them: a reason for each, and the amount they were
    // computed on; the rate is Stripe's own.
    const cases = [
      {
        who: italian,
        country: 'IT',
        taxId: { type: 'eu_vat', value: 'IT12345678901', country: 'IT', verification: 'verified' },
        reason: 'standard_rated',
        tax: 638,
        rate: { id: 'txr_ItVat22', percentage: 22 },
      },
      {
        who: german,
        country: 'DE',
        taxId: { type: 'eu_vat', value: 'DE123456789', country: 'DE', verification: 'unverified' },
        reason: 'reverse_charge',
        tax: 0,
        // Stripe Tax's rate of a reverse charge: the German statutory 19 % as `percentage`, and 0
        // as `effective_percentage`, the one applied.
        rate: { id: 'txr_ReverseChargeDe', percentage: 19, effective: 0 },
      },
      {
        who: american,
        country: 'US',
        taxId: { type: 'us_ein', value: '12-3456789', country: 'US', verification: 'unavailable' },
        reason: 'not_collecting',
        tax: 0,
        rate: { id: 'txr_NotCollectingUs', percentage: 0 },
      },
    ];
    for (const item of cases) {
      stripeTaxRate(stripe, item.rate.id, item.rate.percentage, item.rate.effective);
    }
    const paidAt = seconds(Date.UTC(2026, 9, 1, 6, 0));
    for (const [index, item] of cases.entries()) {
      const { customer: customerId } = await subscribe(
        h,
        stripe,
        item.who,
        'pro',
        seconds(Date.UTC(2026, 8, 20)),
        seconds(Date.UTC(2026, 9, 1)),
      );
      stripe.taxIds.set(customerId, [item.taxId]);
      const invoice = {
        id: `in_Paid${String(index)}${item.who.accountId.slice(5, 15)}`,
        object: 'invoice',
        customer: customerId,
        number: `BR-${String(1000 + index)}`,
        hosted_invoice_url: `https://invoice.stripe.test/${String(index)}`,
        currency: 'eur',
        customer_name: `Company ${item.country}`,
        customer_email: item.who.email,
        customer_address: {
          line1: 'Street 1',
          city: 'City',
          postal_code: '1000',
          country: item.country,
        },
        customer_tax_ids: [{ type: item.taxId.type, value: item.taxId.value }],
        status_transitions: { paid_at: paidAt },
        subtotal: 2900,
        total_excluding_tax: 2900,
        total: 2900 + item.tax,
        amount_paid: 2900 + item.tax,
        total_taxes: [
          {
            amount: item.tax,
            taxable_amount: 2900,
            taxability_reason: item.reason,
            tax_behavior: 'exclusive',
            type: 'tax_rate_details',
            tax_rate_details: { tax_rate: item.rate.id },
          },
        ],
        lines: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'il_1',
              description: '1 × Bookrail (at €29.00 / month)',
              amount: 2900,
              period: { start: seconds(Date.UTC(2026, 9, 1)), end: seconds(Date.UTC(2026, 10, 1)) },
              taxes: [
                {
                  amount: item.tax,
                  taxable_amount: 2900,
                  taxability_reason: item.reason,
                  tax_behavior: 'exclusive',
                  type: 'tax_rate_details',
                  tax_rate_details: { tax_rate: item.rate.id },
                },
              ],
            },
          ],
        },
      };
      const paid = event('invoice.paid', invoice);
      expect((await deliver(h, paid)).status).toBe(200);
      // The same invoice paid again, as another event: recorded once, mailed once.
      expect((await deliver(h, event('invoice.paid', invoice))).status).toBe(200);
    }

    const sent = await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Fattura da emettere: Company'),
        ),
      (found) => found.length === 3,
      'the three messages of the paid invoices',
    );
    const bySubject = (country: string) =>
      sent.find((m) => m.subject.includes(`Company ${country}`))!;
    expect(bySubject('IT').subject).toBe('Fattura da emettere: Company IT 35,38 EUR');
    expect(bySubject('IT').text).toContain('aliquota 22 % (standard_rated)');
    expect(bySubject('IT').text).toContain(
      "Calcolo dell'imposta: Stripe Tax, motivi standard_rated",
    );
    expect(bySubject('IT').text).toContain('Codice SdI o PEC: M5UXCR1');
    expect(bySubject('IT').text).toContain('Verifica di Stripe: verified');
    expect(
      bySubject('DE').text.startsWith(
        'ATTENZIONE: la partita IVA UE non risulta verificata da VIES (stato Stripe: unverified)',
      ),
    ).toBe(true);
    expect(bySubject('DE').text).toContain(
      'inversione contabile (reverse charge), art. 7-ter DPR 633/72',
    );
    expect(bySubject('DE').text).toContain('aliquota 0 % (reverse_charge)');
    expect(bySubject('US').text).toContain('Operazione non soggetta ad IVA, art. 7-ter DPR 633/72');
    expect(bySubject('US').text).toContain('aliquota 0 % (not_collecting)');
    // Outside the Union, not collecting is the expected answer: no warning.
    expect(bySubject('US').text.startsWith('ATTENZIONE')).toBe(false);

    await until(
      async () => {
        const { rows } = await admin(h).execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM billing_invoices WHERE paid_at = ${new Date(paidAt * 1000).toISOString()}::timestamptz AND mailed_at IS NOT NULL
        `);
        return Number(rows[0]?.n ?? 0);
      },
      (n) => n === 3,
      'the three invoices marked as mailed',
    );

    // An invoice of zero is nobody's electronic invoice.
    const zero = await deliver(
      h,
      event('invoice.paid', {
        id: 'in_Zero',
        object: 'invoice',
        customer: 'cus_x',
        total: 0,
        amount_paid: 0,
      }),
    );
    expect(zero.status).toBe(200);

    const listBefore = (h.mailer?.sent ?? []).length;
    const listed = await runBillingInvoiceList(
      { db: createDatabase(h.pools.app), logger: silentLogger, mailer: h.mailer! },
      { to: INVOICE_TO, month: '2026-10' },
    );
    expect(listed.invoices).toBeGreaterThanOrEqual(3);
    const list = (h.mailer?.sent ?? [])[listBefore]!;
    expect(list.subject).toMatch(/^Incassi di Bookrail di ottobre 2026: \d+ fatture da emettere$/);
    expect(list.text).toContain('partite IVA UE non verificate da VIES');
    const csv = list.attachments?.[0];
    expect(csv?.filename).toBe('bookrail-incassi-2026-10.csv');
    expect(csv?.contentType).toBe('text/csv; charset=utf-8');
    expect(csv?.content).toContain(
      ';Company IT;IT12345678901;verified;IT;M5UXCR1;it_vat;EUR;29,00;6,38;35,38;',
    );
    expect(csv?.content).toContain(
      ';Company DE;DE123456789;unverified;DE;M5UXCR1;eu_reverse_charge;EUR;29,00;0,00;29,00;',
    );
    expect(previousMonthInRome(Date.UTC(2026, 10, 2, 7, 0))).toBe('2026-10');
    expect(previousMonthInRome(Date.UTC(2027, 0, 2, 7, 0))).toBe('2026-12');
  });

  it('takes the VAT of an invoice from the taxes Stripe Tax computed, and says so when the address disagrees', async () => {
    const who = await customer(h);
    const { customer: customerId } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 8, 20)),
      seconds(Date.UTC(2026, 9, 1)),
    );
    // An EU business charged Italian VAT: Stripe did not have its VAT number, so no reverse
    // charge. The electronic invoice must not follow the address blindly. The amounts are those
    // of the proof in the sandbox (S5): 1.20 of tax on 5.45, which divided says 22.02 %; the rate
    // is read from the Tax Rate, which says 22.
    stripeTaxRate(stripe, 'txr_StripeTaxIT', 22);
    const italian = {
      amount: 120,
      taxable_amount: 545,
      taxability_reason: 'standard_rated',
      type: 'tax_rate_details',
      tax_rate_details: { tax_rate: 'txr_StripeTaxIT' },
    };
    const invoice = {
      id: `in_Moved${who.accountId.slice(5, 15)}`,
      object: 'invoice',
      customer: customerId,
      currency: 'eur',
      customer_name: 'Moved Srl',
      customer_address: { country: 'DE' },
      status_transitions: { paid_at: seconds(Date.UTC(2026, 9, 1, 7)) },
      total: 665,
      amount_paid: 665,
      total_excluding_tax: 545,
      total_taxes: [italian],
      lines: {
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'il_m',
            description: 'Remaining time on Bookrail Pro after 26 Sep 2026',
            amount: 545,
            taxes: [italian],
          },
        ],
      },
    };
    expect((await deliver(h, event('invoice.paid', invoice))).status).toBe(200);
    const [message] = await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Fattura da emettere: Moved Srl'),
        ),
      (found) => found.length === 1,
      'the message of the invoice of a customer who moved',
    );
    expect(message?.text.startsWith('ATTENZIONE: ')).toBe(true);
    expect(message?.text).toContain("il paese dell'indirizzo (DE)");
    expect(message?.text).toContain('Regime IVA: IVA ordinaria, cliente italiano');
    expect(message?.text).toContain('aliquota 22 % (standard_rated)');
    expect(message?.text).not.toContain('22,02');
    const { rows } = await admin(h).execute<{ vat_treatment: string }>(sql`
      SELECT vat_treatment FROM billing_invoices WHERE stripe_invoice_id = ${invoice.id}
    `);
    expect(rows).toEqual([{ vat_treatment: 'it_vat' }]);
  });

  it('tells whoever issues the invoices when the fiscal data of a subscribed customer change', async () => {
    const who = await customer(h);
    const { customer: customerId } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    const noticesOf = () =>
      (h.mailer?.sent ?? []).filter(
        (m) =>
          m.to === INVOICE_TO &&
          m.subject.startsWith('Dati fiscali cambiati') &&
          m.text.includes(customerId),
      );
    const later = { created: seconds(Date.now() + 11 * 60_000) };
    const updated = (
      previous: Record<string, unknown>,
      address: unknown,
      options: { created?: number } = later,
    ) => {
      const body = event(
        'customer.updated',
        { id: customerId, object: 'customer', address },
        options,
      );
      (body.data as Record<string, unknown>).previous_attributes = previous;
      return body;
    };
    // What the checkout itself writes, in its first ten minutes, says nothing: the address
    // filled, and the VAT number collected.
    expect(
      (await deliver(h, updated({ address: null, name: null }, { country: 'IT' }, {}))).status,
    ).toBe(200);
    expect(
      (
        await deliver(
          h,
          event('customer.tax_id.created', { id: 'txi_0', object: 'tax_id', customer: customerId }),
        )
      ).status,
    ).toBe(200);
    // Nor, later, a change that is not fiscal, or an address that stays in its country.
    expect((await deliver(h, updated({ invoice_settings: {} }, { country: 'IT' }))).status).toBe(
      200,
    );
    expect(
      (
        await deliver(
          h,
          updated({ address: { country: 'IT', city: 'Roma' } }, { country: 'IT', city: 'Milano' }),
        )
      ).status,
    ).toBe(200);
    // Nor the verification of the same VAT number, whenever VIES answers.
    const verified = event(
      'customer.tax_id.updated',
      { id: 'txi_0', object: 'tax_id', customer: customerId },
      later,
    );
    (verified.data as Record<string, unknown>).previous_attributes = {
      verification: { status: 'pending' },
    };
    expect((await deliver(h, verified)).status).toBe(200);
    expect(noticesOf()).toEqual([]);
    // A move to another country, later, is said, for information.
    expect(
      (await deliver(h, updated({ address: { country: 'IT' } }, { country: 'DE' }))).status,
    ).toBe(200);
    await until(
      async () => noticesOf(),
      (found) => found.length === 1,
      'the notice of the move',
    );
    expect(noticesOf()[0]?.text).toContain('Cosa è cambiato: paese IT -> DE');
    expect(noticesOf()[0]?.text).toContain('Stripe Tax');
    expect(
      (
        await deliver(
          h,
          event(
            'customer.tax_id.deleted',
            { id: 'txi_1', object: 'tax_id', customer: customerId },
            later,
          ),
        )
      ).status,
    ).toBe(200);
    await until(
      async () => noticesOf(),
      (found) => found.length === 2,
      'the notice of the tax id',
    );
    expect(noticesOf()[1]?.text).toContain('partita IVA deleted');
    // And the portal no longer lets a customer change them.
    const configuration = [...stripe.portalConfigurations.values()].at(-1) as Record<
      string,
      unknown
    >;
    const features = configuration.features as Record<string, Record<string, unknown>>;
    expect(features.customer_update?.allowed_updates).toEqual(['email', 'name']);
  });

  it('cancels at Stripe an unpaid or paused subscription, whose account is already free', async () => {
    for (const status of ['unpaid', 'paused'] as const) {
      const who = await customer(h);
      const { customer: customerId, subscription } = await subscribe(
        h,
        stripe,
        who,
        'pro',
        seconds(Date.now() - 40 * 86_400_000),
        seconds(firstOfNextMonthUtc(Date.now())),
      );
      stripe.setSubscription({
        id: subscription,
        customer: customerId,
        lookupKey: PLAN_LOOKUP_KEYS.pro,
        status,
        currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
      });
      await deliver(h, event('customer.subscription.updated', { id: subscription }));
      expect(await planOf(h, who.accountId)).toBe('free');
      // Dead: a new checkout is allowed.
      expect((await account(h, who.session)).billing?.status).toBe(status);
      await runBillingOverdue(jobDeps());
      expect(stripe.of('DELETE', `/v1/subscriptions/${subscription}`)).toHaveLength(1);
      expect(stripe.subscriptions.get(subscription)?.status).toBe('canceled');
    }
  });

  it('moves Pro to Scale at once, and Scale to Pro on the first with a schedule that can be cancelled', async () => {
    const who = await customer(h);
    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      periodEnd,
    );
    const change = (plan: 'pro' | 'scale') =>
      h.call<ErrorBody & { plan: string; effective: string; effective_at: string }>(
        'POST',
        '/v1/dashboard/billing/change',
        { token: who.session, body: { plan } },
      );

    // Already on Pro.
    const same = await change('pro');
    expect([same.status, same.body.error.code]).toEqual([409, 'plan_change_refused']);

    // Up: the price of the item is replaced at once, the difference invoiced now.
    const up = await change('scale');
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ object: 'billing_change', plan: 'scale', effective: 'now' });
    const update = stripe.of('POST', `/v1/subscriptions/${subscription}`).at(-1)!;
    const catalog = await resolveCatalog(billing.client);
    expect(update.form).toMatchObject({
      items: [{ id: `si_${subscription}`, price: catalog.prices.scale.id }],
      proration_behavior: 'always_invoice',
      // Applied only once the difference is paid (T1); `automatic_tax` is the subscription's
      // already, and a pending update does not take it.
      payment_behavior: 'pending_if_incomplete',
    });
    expect(update.form).not.toHaveProperty('automatic_tax');
    expect(update.headers['idempotency-key']).toMatch(/^bookrail-upgrade-sub_/);
    expect(await planOf(h, who.accountId)).toBe('scale');

    // Down: a schedule from the subscription, the current phase to the end, then Pro.
    const down = await change('pro');
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({
      plan: 'pro',
      effective: 'period_end',
      effective_at: new Date(periodEnd * 1000).toISOString(),
    });
    const created = stripe.of('POST', '/v1/subscription_schedules').at(-1)!;
    expect(created.form).toEqual({ from_subscription: subscription });
    // One schedule per period, even for two clicks at once (T7).
    expect(created.headers['idempotency-key']).toBe(
      `bookrail-schedule-${subscription}-${String(periodEnd)}`,
    );
    const schedule = [...stripe.schedules.values()].at(-1)!;
    const phases = stripe.of('POST', `/v1/subscription_schedules/${schedule.id}`).at(-1)!.form;
    expect(phases).toMatchObject({
      end_behavior: 'release',
      metadata: { bookrail_account_id: who.accountId },
      phases: [
        {
          items: [{ price: catalog.prices.scale.id, quantity: '1' }],
          // The start of the current phase, as the schedule answered it (T7).
          start_date: String(
            (schedule as { current_phase?: { start_date?: number } }).current_phase?.start_date ??
              (schedule.phases as { start_date: number }[])[0]?.start_date,
          ),
          end_date: String(periodEnd),
          automatic_tax: { enabled: 'true' },
          proration_behavior: 'none',
        },
        {
          items: [{ price: catalog.prices.pro.id, quantity: '1' }],
          duration: { interval: 'month', interval_count: '1' },
          automatic_tax: { enabled: 'true' },
        },
      ],
    });
    // The account stays on Scale until the first, and the dashboard says what is coming.
    expect(await planOf(h, who.accountId)).toBe('scale');
    expect((await account(h, who.session)).billing?.scheduled_plan).toBe('pro');
    const again = await change('pro');
    expect([again.status, again.body.error.code]).toEqual([409, 'plan_change_refused']);

    // Cancelled: the schedule is released and Scale stays.
    const cancel = await h.call<{ plan: string }>('POST', '/v1/dashboard/billing/change/cancel', {
      token: who.session,
    });
    expect(cancel.status).toBe(200);
    expect(stripe.of('POST', `/v1/subscription_schedules/${schedule.id}/release`)).toHaveLength(1);
    expect((await account(h, who.session)).billing?.scheduled_plan).toBeNull();
    const nothing = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/change/cancel', {
      token: who.session,
    });
    expect([nothing.status, nothing.body.error.code]).toEqual([409, 'plan_change_refused']);

    // A schedule event from Stripe reads the subscription back too. A released schedule names its
    // subscription only in `released_subscription` (T6).
    expect(schedule).toMatchObject({ subscription: null, released_subscription: subscription });
    const readsBefore = stripe.of('GET', `/v1/subscriptions/${subscription}`).length;
    expect(
      (
        await deliver(
          h,
          event('subscription_schedule.released', {
            id: schedule.id,
            object: 'subscription_schedule',
            subscription: null,
            released_subscription: subscription,
          }),
        )
      ).status,
    ).toBe(200);
    expect(stripe.of('GET', `/v1/subscriptions/${subscription}`).length).toBe(readsBefore + 1);
    expect(customerId).toMatch(/^cus_/);
  });

  it('refuses a change of plan without a live, settled subscription', async () => {
    const free = await customer(h);
    const none = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/change', {
      token: free.session,
      body: { plan: 'scale' },
    });
    expect([none.status, none.body.error.code]).toEqual([409, 'billing_subscription_missing']);

    const late = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      late,
      'pro',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'past_due',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
    });
    await deliver(h, event('customer.subscription.updated', { id: subscription }));
    const refused = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/change', {
      token: late.session,
      body: { plan: 'scale' },
    });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'plan_change_refused']);

    // A subscription set to end at the end of the period is not moved down: there is no next
    // period to put Pro in.
    const ending = await customer(h);
    const endingSub = await subscribe(
      h,
      stripe,
      ending,
      'scale',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    stripe.setSubscription({
      id: endingSub.subscription,
      customer: endingSub.customer,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
    });
    await deliver(h, event('customer.subscription.updated', { id: endingSub.subscription }));
    const schedulesBefore = stripe.of('POST', '/v1/subscription_schedules').length;
    const down = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/change', {
      token: ending.session,
      body: { plan: 'pro' },
    });
    expect([down.status, down.body.error.code]).toEqual([409, 'plan_change_refused']);
    expect(stripe.of('POST', '/v1/subscription_schedules')).toHaveLength(schedulesBefore);
  });

  it('leaves the unpaid invoice of a closed subscription visible, payable, and in the way of a new checkout', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 40 * 86_400_000),
      seconds(Date.now() - 16 * 86_400_000),
    );
    const failedAt = seconds(Date.now() - 15 * 86_400_000);
    await deliver(
      h,
      event(
        'invoice.payment_failed',
        {
          id: 'in_Unpaid',
          object: 'invoice',
          customer: customerId,
          parent: { type: 'subscription_details', subscription_details: { subscription } },
        },
        { created: failedAt },
      ),
    );
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'past_due',
      currentPeriodEnd: seconds(Date.now() + 14 * 86_400_000),
    });
    await deliver(
      h,
      event('customer.subscription.updated', { id: subscription }, { created: failedAt + 5 }),
    );
    const open = stripe.openInvoice(customerId, { amount: 8455, number: 'BR-UNPAID-1' });

    await runBillingOverdue(jobDeps());
    expect(await planOf(h, who.accountId)).toBe('free');

    // The dashboard shows it with the link to pay it.
    const read = await account(h, who.session);
    expect(read.billing?.unpaid_invoice).toEqual({
      id: open,
      number: 'BR-UNPAID-1',
      amount_due: 8455,
      currency: 'eur',
      url: `https://invoice.stripe.test/i/${open}`,
    });
    // The owner has the link, whoever issues the invoices the list; nothing was voided.
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) =>
            m.to === who.email &&
            m.subject === 'Your Bookrail subscription was closed: an invoice is unpaid',
        ),
      (found) =>
        found.length === 1 && found[0]!.text.includes(`https://invoice.stripe.test/i/${open}`),
      'the message with the link to pay',
    );
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Fatture non pagate dopo la chiusura'),
        ),
      (found) => found.some((m) => m.text.includes('BR-UNPAID-1: 84,55 EUR')),
      'the list of the unpaid invoices',
    );
    expect(stripe.of('POST', `/v1/invoices/${open}/void`)).toEqual([]);

    // A new checkout waits for the payment.
    const refused = await h.call<ErrorBody>('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'pro' },
    });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'invoice_unpaid']);
    expect(refused.body.error.fix).toContain(`https://invoice.stripe.test/i/${open}`);

    // Paid at last: no longer due, and the checkout opens.
    stripe.invoices.get(open)!.status = 'paid';
    await deliver(
      h,
      event('invoice.paid', {
        id: open,
        object: 'invoice',
        customer: customerId,
        total: 8455,
        amount_paid: 8455,
        currency: 'eur',
        lines: { object: 'list', has_more: false, data: [] },
      }),
    );
    expect((await account(h, who.session)).billing?.unpaid_invoice).toBeNull();
    expect(
      (
        await h.call('POST', '/v1/dashboard/billing/checkout', {
          token: who.session,
          body: { plan: 'pro' },
        })
      ).status,
    ).toBe(200);
  });

  it('applies a recorded duplicate at once when the subscription on file ends, and says so again', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    const second = `sub_${who.accountId.slice(5, 21)}dup2`;
    stripe.setSubscription({
      id: second,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
    });
    await deliver(h, event('customer.subscription.created', { id: second }));
    expect(await planOf(h, who.accountId)).toBe('pro');
    // The one on file ends; the duplicate keeps taking money.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'canceled',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
      endedAt: seconds(Date.now()),
    });
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(await planOf(h, who.accountId)).toBe('scale');
    const { rows } = await admin(h).execute<{ stripe_subscription_id: string }>(sql`
      SELECT stripe_subscription_id FROM billing_subscriptions
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ stripe_subscription_id: second }]);
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Abbonamento doppio ancora attivo'),
        ),
      (found) => found.some((m) => m.text.includes(second)),
      'the second notice about the duplicate',
    );
  });

  it('records a change it finds by reconciling at the instant Stripe gives, not at its own', async () => {
    const start = seconds(Date.UTC(2026, 7, 1));
    expect(
      stripeInstantOf({
        id: 'sub_x',
        customer: 'cus_x',
        status: 'active',
        price: null,
        currentPeriodEnd: seconds(Date.UTC(2026, 8, 1)),
        currentPeriodStart: start,
        cancelAtPeriodEnd: false,
        metadata: {},
        itemId: null,
        defaultPaymentMethod: null,
        endedAt: null,
        canceledAt: null,
        scheduleId: null,
        schedulePhases: [],
        scheduleStatus: null,
        scheduleIsBookrail: false,
        pendingUpdate: null,
        latestInvoice: null,
      }),
    ).toBe(start);
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2026, 6, 20)),
      seconds(Date.UTC(2026, 8, 1)),
    );
    // Moved up to Scale on 30 August at Stripe; the event was lost.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: seconds(Date.UTC(2026, 8, 1)),
      currentPeriodStart: start,
    });
    await runBillingReconcile(jobDeps(), { now: Date.UTC(2026, 8, 1, 6, 40) });
    expect(await planOf(h, who.accountId)).toBe('scale');
    const { rows } = await admin(h).execute<{ plan_since: string }>(sql`
      SELECT plan_since::text AS plan_since FROM billing_subscriptions
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    // August was served by Scale on its last day, as it was.
    expect(new Date(rows[0]!.plan_since).getTime()).toBe(start * 1000);
  });

  it('claims the month whose renewal was lost, from the second, as pending lines, once', async () => {
    const who = await customer(h);
    const { customer: customerId } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2025, 9, 5)),
      seconds(Date.UTC(2025, 10, 1)),
    );
    await seedUsage(h, who.projectId, '2025-10', 6, 0);
    const itemsOf = () =>
      [...stripe.invoiceItems.values()].filter((item) => item.customer === customerId) as Record<
        string,
        unknown
      >[];
    // Counted on this account, not on the report of a run over every account of the database.
    const claimsOfAccount = async (): Promise<number> => {
      const { rows } = await admin(h).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM billing_overages
         WHERE account_id = ${decodeId('account', who.accountId)} AND month = '2025-10'
      `);
      return rows[0]?.n ?? 0;
    };
    // The first of the month is too early: the renewal may still be on its way.
    await runBillingReconcile(jobDeps(), { now: Date.UTC(2025, 10, 1, 6, 40) });
    expect(await claimsOfAccount()).toBe(0);
    expect(itemsOf()).toEqual([]);
    await runBillingReconcile(jobDeps(), { now: Date.UTC(2025, 10, 2, 6, 40) });
    expect(await claimsOfAccount()).toBe(1);
    expect(itemsOf()).toMatchObject([
      {
        customer: customerId,
        invoice: null,
        quantity: '3',
        metadata: { bookrail_month: '2025-10' },
      },
    ]);
    const { rows } = await admin(h).execute<{ origin: string; placement: string }>(sql`
      SELECT origin, placement FROM billing_overages
       WHERE account_id = ${decodeId('account', who.accountId)} AND month = '2025-10'
    `);
    expect(rows).toEqual([{ origin: 'renewal', placement: 'next_invoice' }]);
    await runBillingReconcile(jobDeps(), { now: Date.UTC(2025, 10, 3, 6, 40) });
    expect(itemsOf()).toHaveLength(1);
    expect(await claimsOfAccount()).toBe(1);
  });

  it('tells a person once when a claim has failed five times', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2025, 7, 5)),
      seconds(Date.UTC(2025, 8, 1)),
    );
    await seedUsage(h, who.projectId, '2025-08', 5, 0);
    const draft = stripe.draftInvoice(customerId);
    stripe.failNext('POST', '/v1/invoiceitems', 500, { type: 'api_error', message: 'boom' });
    await deliver(
      h,
      event(
        'invoice.created',
        renewal(draft, customerId, subscription, seconds(Date.UTC(2025, 8, 1))),
      ),
    );
    const stuck = () =>
      (h.mailer?.sent ?? []).filter(
        (m) => m.to === INVOICE_TO && m.subject.startsWith('Eccedenza di 2025-08 non fatturata'),
      );
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await admin(h).execute(sql`
        UPDATE billing_overages SET leased_until = now() - interval '1 second'
         WHERE account_id = ${decodeId('account', who.accountId)}
      `);
      // Every attempt fails: the draft refuses, and it is still a draft.
      stripe.failNext('POST', '/v1/invoiceitems', 400, {
        type: 'invalid_request_error',
        message: 'This tax configuration is not valid.',
      });
      await runBillingReconcile(jobDeps(), { now: Date.UTC(2025, 8, 1, 6, 40) });
    }
    const { rows } = await admin(h).execute<{ attempts: number; status: string }>(sql`
      SELECT attempts, status FROM billing_overages
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toEqual([{ attempts: 6, status: 'claimed' }]);
    expect(stuck()).toHaveLength(1);
    expect(stuck()[0]?.text).toContain('This tax configuration is not valid.');
  });

  it('tells a person on the fifth attempt also when a redelivery of the renewal makes it', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2025, 5, 5)),
      seconds(Date.UTC(2025, 6, 1)),
    );
    await seedUsage(h, who.projectId, '2025-06', 5, 0);
    const draft = stripe.draftInvoice(customerId);
    const invoice = renewal(draft, customerId, subscription, seconds(Date.UTC(2025, 6, 1)));
    stripe.failNext('POST', '/v1/invoiceitems', 500, { type: 'api_error', message: 'boom' });
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(500);
    // Four attempts already made by the reconciliation; the lease is over.
    await admin(h).execute(sql`
      UPDATE billing_overages SET attempts = 4, leased_until = now() - interval '1 second'
       WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    stripe.failNext('POST', '/v1/invoiceitems', 400, {
      type: 'invalid_request_error',
      message: 'Refused on the fifth attempt.',
    });
    expect((await deliver(h, event('invoice.created', invoice))).status).toBe(500);
    const notices = (h.mailer?.sent ?? []).filter(
      (m) => m.to === INVOICE_TO && m.subject.startsWith('Eccedenza di 2025-06 non fatturata'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('Refused on the fifth attempt.');
  });

  it('moves up only once the difference is paid: a refused card leaves Pro, and the dashboard the link', async () => {
    const who = await customer(h);
    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      periodEnd,
    );
    stripe.declineNextPayment(subscription);
    const up = await h.call<{
      effective: string;
      effective_at: string | null;
      payment_url: string;
    }>('POST', '/v1/dashboard/billing/change', { token: who.session, body: { plan: 'scale' } });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ effective: 'pending_payment', effective_at: null });
    expect(up.body.payment_url).toMatch(/^https:\/\/invoice\.stripe\.test\/i\/in_/);
    // Nothing moved: the account, the row and the subscription at Stripe are on Pro, active.
    expect(await planOf(h, who.accountId)).toBe('pro');
    expect((await account(h, who.session)).billing).toMatchObject({
      plan: 'pro',
      status: 'active',
      past_due_since: null,
    });
    // The failed payment of that invoice starts no grace and tells nobody: the subscription is
    // active.
    const mailsBefore = (h.mailer?.sent ?? []).length;
    const failed = await deliver(
      h,
      event('invoice.payment_failed', {
        id: `in_Update${who.accountId.slice(5, 15)}`,
        object: 'invoice',
        customer: customerId,
        billing_reason: 'subscription_update',
        parent: { type: 'subscription_details', subscription_details: { subscription } },
      }),
    );
    expect(failed.status).toBe(200);
    expect((await account(h, who.session)).billing?.past_due_since).toBeNull();
    expect((h.mailer?.sent ?? []).slice(mailsBefore)).toEqual([]);
    // Paid from the link: Stripe applies the change and says so.
    const catalog = await resolveCatalog(billing.client);
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: periodEnd,
    });
    expect(catalog.prices.scale.id).toMatch(/^price_/);
    await deliver(h, event('customer.subscription.pending_update_applied', { id: subscription }));
    expect(await planOf(h, who.accountId)).toBe('scale');
  });

  it('releases the schedule of a move down once its last phase has begun, so the portal can cancel', async () => {
    const who = await customer(h);
    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'scale',
      seconds(Date.now() - 86_400_000),
      periodEnd,
    );
    const down = await h.call('POST', '/v1/dashboard/billing/change', {
      token: who.session,
      body: { plan: 'pro' },
    });
    expect(down.status).toBe(200);
    const schedule = [...stripe.schedules.values()].at(-1)!;
    // Before the first: the schedule stays, and the move is shown.
    await deliver(h, event('customer.subscription.updated', { id: subscription }));
    expect(stripe.of('POST', `/v1/subscription_schedules/${schedule.id}/release`)).toEqual([]);
    // The first has come: Stripe moved the item to Pro and the second phase is under way.
    const phases = schedule.phases as { start_date: number | null }[];
    for (const phase of phases)
      phase.start_date = Math.min(phase.start_date ?? 0, seconds(Date.now()) - 60);
    const item = (
      stripe.subscriptions.get(subscription)!.items as {
        data: Record<string, unknown>[];
      }
    ).data[0]!;
    const catalog = await resolveCatalog(billing.client);
    item.price = stripe.prices.get(catalog.prices.pro.id);
    await deliver(h, event('customer.subscription.updated', { id: subscription }));
    expect(stripe.of('POST', `/v1/subscription_schedules/${schedule.id}/release`)).toHaveLength(1);
    expect(schedule).toMatchObject({ status: 'released', released_subscription: subscription });
    expect(await planOf(h, who.accountId)).toBe('pro');
    // A second delivery does not try again.
    await deliver(h, event('customer.subscription.updated', { id: subscription }));
    expect(stripe.of('POST', `/v1/subscription_schedules/${schedule.id}/release`)).toHaveLength(1);
    expect(customerId).toMatch(/^cus_/);
  });

  it('shows the cancellation the portal writes as cancel_at, with the schedule released (S8)', async () => {
    const who = await customer(h);
    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'scale',
      seconds(Date.now() - 86_400_000),
      periodEnd,
    );
    await h.call('POST', '/v1/dashboard/billing/change', {
      token: who.session,
      body: { plan: 'pro' },
    });
    expect((await account(h, who.session)).billing?.scheduled_plan).toBe('pro');
    const schedule = [...stripe.schedules.values()].at(-1)!;
    // What the portal did in the sandbox: it released the schedule and wrote `cancel_at` at the
    // end of the period, with `cancel_at_period_end: false`.
    await billing.client.releaseSchedule(schedule.id);
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      cancelAt: periodEnd,
    });
    expect(stripe.subscriptions.get(subscription)).toMatchObject({
      cancel_at_period_end: false,
      cancel_at: periodEnd,
      schedule: null,
    });
    expect(
      (
        await deliver(
          h,
          event('subscription_schedule.released', {
            id: schedule.id,
            object: 'subscription_schedule',
            subscription: null,
            released_subscription: subscription,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await account(h, who.session)).billing).toMatchObject({
      plan: 'scale',
      cancel_at_period_end: true,
      scheduled_plan: null,
    });
  });

  it('reads the SdI code from the Checkout Session when the paid invoice comes before the checkout', async () => {
    const who = await customer(h);
    // The checkout is paid; its event is late. The subscription is known from its own event.
    const opened = await h.call('POST', '/v1/dashboard/billing/checkout', {
      token: who.session,
      body: { plan: 'pro' },
    });
    expect(opened.status).toBe(200);
    const customerId = await customerOf(h, who.accountId);
    const session = stripe.checkoutSessions.at(-1)!;
    const subscription = `sub_${who.accountId.slice(5, 21)}sdi`;
    stripe.completeSession(session.id, subscription);
    session.custom_fields = [{ key: 'sdiorpec', type: 'text', text: { value: '0000000' } }];
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'active',
      currentPeriodEnd: seconds(firstOfNextMonthUtc(Date.now())),
      metadata: { bookrail_account_id: who.accountId },
    });
    await deliver(h, event('customer.subscription.created', { id: subscription }));
    stripeTaxRate(stripe, 'txr_SdiIt22', 22);
    const tax = {
      amount: 120,
      taxable_amount: 545,
      taxability_reason: 'standard_rated',
      type: 'tax_rate_details',
      tax_rate_details: { tax_rate: 'txr_SdiIt22' },
    };
    const invoice = {
      id: `in_Sdi${who.accountId.slice(5, 15)}`,
      object: 'invoice',
      customer: customerId,
      billing_reason: 'subscription_create',
      parent: { type: 'subscription_details', subscription_details: { subscription } },
      currency: 'eur',
      customer_name: 'Primo Srl',
      customer_address: { country: 'IT' },
      status_transitions: { paid_at: seconds(Date.now()) },
      total: 665,
      amount_paid: 665,
      total_excluding_tax: 545,
      total_taxes: [tax],
      lines: {
        object: 'list',
        has_more: false,
        data: [{ id: 'il_s', description: 'Bookrail Pro', amount: 545, taxes: [tax] }],
      },
    };
    expect((await deliver(h, event('invoice.paid', invoice))).status).toBe(200);
    const [message] = await until(
      async () =>
        (h.mailer?.sent ?? []).filter(
          (m) => m.to === INVOICE_TO && m.subject.startsWith('Fattura da emettere: Primo Srl'),
        ),
      (found) => found.length === 1,
      'the message of the first invoice',
    );
    expect(message?.text).toContain('0000000');
    const { rows } = await admin(h).execute<{ sdi: string | null; sub: string | null }>(sql`
      SELECT i.sdi_or_pec AS sdi, b.sdi_or_pec AS sub
        FROM billing_invoices i JOIN billing_subscriptions b ON b.account_id = i.account_id
       WHERE i.stripe_invoice_id = ${invoice.id}
    `);
    expect(rows).toEqual([{ sdi: '0000000', sub: '0000000' }]);
    // The event of the checkout, late, changes nothing.
    await deliver(
      h,
      event('checkout.session.completed', {
        id: session.id,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: who.accountId,
        customer: customerId,
        subscription,
        custom_fields: session.custom_fields,
      }),
    );
    expect(await planOf(h, who.accountId)).toBe('pro');
  });

  it('bills the lines left pending when a subscription ends and its last month owes nothing (T3)', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.UTC(2025, 3, 1)),
      seconds(Date.UTC(2025, 5, 1)),
    );
    // April's lines went pending (a draft that was no longer a draft).
    await seedUsage(h, who.projectId, '2025-04', 5, 0);
    const late = stripe.draftInvoice(customerId);
    stripe.finalize(late);
    await deliver(
      h,
      event(
        'invoice.created',
        renewal(late, customerId, subscription, seconds(Date.UTC(2025, 4, 1))),
      ),
    );
    const pending = [...stripe.invoiceItems.values()].filter(
      (item) => item.customer === customerId && item.invoice === null,
    );
    expect(pending).toHaveLength(1);
    // Cancelled at the end of May, which is under the quantity: no final claim to bill.
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'canceled',
      currentPeriodEnd: seconds(Date.UTC(2025, 5, 1)),
      endedAt: seconds(Date.UTC(2025, 5, 1)),
    });
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    const invoices = stripe
      .of('POST', '/v1/invoices')
      .filter((request) => request.form.customer === customerId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.form).toMatchObject({
      pending_invoice_items_behavior: 'include',
      automatic_tax: { enabled: 'true' },
      metadata: { bookrail_kind: 'final_pending', bookrail_subscription: subscription },
    });
    expect(invoices[0]?.headers['idempotency-key']).toBe(`bookrail-final-pending-${subscription}`);
    expect(pending[0]?.invoice).not.toBeNull();
    // A second delivery finds nothing pending and invoices nothing.
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(
      stripe.of('POST', '/v1/invoices').filter((request) => request.form.customer === customerId),
    ).toHaveLength(1);
  });

  it('records and tells the invoices left open by a closure even when the first delivery failed (T4)', async () => {
    const who = await customer(h);
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 40 * 86_400_000),
      seconds(Date.now() - 16 * 86_400_000),
    );
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'past_due',
      currentPeriodEnd: seconds(Date.now() + 14 * 86_400_000),
    });
    await deliver(
      h,
      event('invoice.payment_failed', {
        id: 'in_T4Failed',
        object: 'invoice',
        customer: customerId,
        parent: { type: 'subscription_details', subscription_details: { subscription } },
      }),
    );
    const open = stripe.openInvoice(customerId, { amount: 3538, number: 'BR-T4' });
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.pro,
      status: 'canceled',
      currentPeriodEnd: seconds(Date.now()),
      endedAt: seconds(Date.now()),
    });
    stripe.failNext('GET', '/v1/invoices', 500, { type: 'api_error', message: 'boom' });
    const first = await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(first.status).toBe(500);
    // The plan moved in the first delivery (committed before Stripe answered badly).
    expect(await planOf(h, who.accountId)).toBe('free');
    expect((await account(h, who.session)).billing?.unpaid_invoice).toBeNull();
    // Stripe delivers again: the plan does not move twice, and the open invoice is recorded and
    // told.
    const changes = (await planChanges(h, who.projectId)).length;
    const again = await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(again.status).toBe(200);
    expect(await planChanges(h, who.projectId)).toHaveLength(changes);
    expect((await account(h, who.session)).billing?.unpaid_invoice).toMatchObject({ id: open });
    await until(
      async () =>
        (h.mailer?.sent ?? []).filter((m) => m.to === INVOICE_TO && m.text.includes('BR-T4')),
      (found) => found.length === 1,
      'the notice of the invoice left open',
    );
    // A third delivery tells nobody again.
    await deliver(h, event('customer.subscription.deleted', { id: subscription }));
    expect(
      (h.mailer?.sent ?? []).filter((m) => m.to === INVOICE_TO && m.text.includes('BR-T4')),
    ).toHaveLength(1);
  });

  it('refuses a reading of Stripe older than one already applied (T8)', async () => {
    const who = await customer(h);
    const periodEnd = seconds(firstOfNextMonthUtc(Date.now()));
    const { customer: customerId, subscription } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      periodEnd,
    );
    // The reconciliation read Pro, then the dashboard moved up and applied Scale; the
    // reconciliation commits last.
    const oldReading = await billing.client.retrieveSubscription(subscription);
    const readAt = Date.now() - 1000;
    stripe.setSubscription({
      id: subscription,
      customer: customerId,
      lookupKey: PLAN_LOOKUP_KEYS.scale,
      status: 'active',
      currentPeriodEnd: periodEnd,
    });
    await deliver(h, event('customer.subscription.updated', { id: subscription }));
    expect(await planOf(h, who.accountId)).toBe('scale');
    const changes = (await planChanges(h, who.projectId)).length;
    const outcome = await applySubscriptionState(
      jobDeps(),
      oldReading,
      null,
      null,
      seconds(Date.now()),
      readAt,
    );
    expect(outcome).toBe('ignored');
    expect(await planOf(h, who.accountId)).toBe('scale');
    expect(await planChanges(h, who.projectId)).toHaveLength(changes);
  });

  it('records and tells a final invoice whose payment failed (T11)', async () => {
    const who = await customer(h);
    const { customer: customerId } = await subscribe(
      h,
      stripe,
      who,
      'pro',
      seconds(Date.now() - 86_400_000),
      seconds(firstOfNextMonthUtc(Date.now())),
    );
    const id = `in_Final${who.accountId.slice(5, 15)}`;
    const failed = await deliver(
      h,
      event('invoice.payment_failed', {
        id,
        object: 'invoice',
        customer: customerId,
        customer_email: who.email,
        number: 'BR-FIN1',
        status: 'open',
        amount_due: 1234,
        amount_remaining: 1234,
        currency: 'eur',
        hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
        metadata: { bookrail_kind: 'final_overage', bookrail_month: '2026-09' },
        parent: null,
      }),
    );
    expect(failed.status).toBe(200);
    expect((await account(h, who.session)).billing?.unpaid_invoice).toMatchObject({
      id,
      amount_due: 1234,
    });
    await until(
      async () => (h.mailer?.sent ?? []).filter((m) => m.to === who.email && m.text.includes(id)),
      (found) => found.length === 1,
      'the link to pay the final invoice, to the owner',
    );
  });

  it('writes the rate of each line from its Tax Rate, credits included, and warns of two regimes on one invoice (T12)', async () => {
    const lines = invoiceLinesOf({
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'il_c',
          description: 'Unused time on Bookrail Pro',
          amount: -1500,
          taxes: [
            {
              amount: -330,
              taxable_amount: -1500,
              taxability_reason: 'standard_rated',
              tax_rate_details: { tax_rate: 'txr_x' },
            },
          ],
        },
      ],
    }).lines;
    expect(lines[0]).toMatchObject({ taxRateIds: ['txr_x'], taxPercent: 22 });
    const mixed = appliedVatTreatment(
      [
        { ...lines[0]!, taxabilityReasons: ['standard_rated'], taxAmount: 330 },
        { ...lines[0]!, taxabilityReasons: ['reverse_charge'], taxAmount: 0 },
      ],
      [],
      'IT',
    );
    expect(mixed.warning).toContain('regimi diversi');
  });

  it('never sent Stripe-Account on any call of Billing', () => {
    expect(stripe.requests.filter((request) => 'stripe-account' in request.headers)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------

describe('the terms at sign up', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('refuses a sign up without both ticks, and sends nothing', async () => {
    const before = h.mailer?.sent.length ?? 0;
    for (const body of [
      { email: freshEmail(), client: 'web' },
      { email: freshEmail(), client: 'web', accept_terms: true },
      { email: freshEmail(), client: 'cli', accept_terms: true, approve_clauses: false },
    ]) {
      const response = await h.call<ErrorBody>('POST', '/v1/signups', {
        body,
        headers: freshCaller(),
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('terms_not_accepted');
      expect(response.body.error.fix).toContain('https://bookrail.dev/terms');
      expect(response.headers.get('access-control-allow-origin')).toBe(SITE_URL);
    }
    expect(h.mailer?.sent.length ?? 0).toBe(before);
  });

  it('records the acceptance of the versions in force next to the account the link creates', async () => {
    const who = await customer(h);
    const { rows } = await admin(h).execute<{
      channel: string;
      terms_version: string;
      dpa_version: string;
      terms_accepted: boolean;
      clauses_approved: boolean;
      ip_hash: string;
    }>(sql`
      SELECT channel, terms_version, dpa_version, terms_accepted, clauses_approved, ip_hash
        FROM terms_acceptances WHERE account_id = ${decodeId('account', who.accountId)}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'web',
      terms_version: LEGAL_VERSIONS.terms,
      dpa_version: LEGAL_VERSIONS.dpa,
      terms_accepted: true,
      clauses_approved: true,
    });
    expect(rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await account(h, who.session)).terms.accepted_at).not.toBeNull();
  });
});
