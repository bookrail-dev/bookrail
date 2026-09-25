/**
 * Stripe Billing and the acceptance of the terms (migration 0027), from the point of view of the
 * application role.
 *
 * What is measured: the five tables are closed; the functions have the four properties, and the
 * writer of `plan.changed` is executable by nobody but its owner; a subscription moves the plan
 * of the account it belongs to and of no other, with one event in every project and the reason
 * that matches the move; a late event of an old subscription does not undo a new one; a failed
 * payment starts the fourteen days once; the usage the overage reads is the usage the free plan's
 * gate reads, computed on the same data; an overage and an invoice are claimed once; the list of
 * subscriptions to cancel uses the database's own clock; and an acceptance travels from a sign up
 * request to the account it creates.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError } from './helpers.js';

const BILLING_TABLES = [
  'billing_subscriptions',
  'billing_events',
  'billing_overages',
  'billing_invoices',
  'billing_unpaid_invoices',
  'terms_acceptances',
  'billing_plan_history',
] as const;

const CLAIM =
  'SELECT * FROM billing_overage_claim($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';

const APP_FUNCTIONS = [
  'billing_account_state',
  'billing_checkout_record',
  'billing_customer_account',
  'billing_customer_bind',
  'billing_event_claim',
  'billing_event_settle',
  'billing_invoice_mailed',
  'billing_invoice_record',
  'billing_invoice_sdi',
  'billing_invoices_of_month',
  'billing_live_subscriptions',
  'billing_overage_claim',
  'billing_overage_context',
  'billing_overage_settle',
  'billing_overage_take',
  'billing_overdue_subscriptions',
  'billing_payment_failed',
  'billing_subscription_apply',
  'billing_unpaid_invoice_record',
  'billing_unpaid_invoice_settle',
  'billing_usage_for_month',
  'terms_accept_dashboard',
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function alnum(): string {
  return uuidv7().replace(/-/g, '');
}

interface Account {
  accountId: string;
  projectIds: string[];
  email: string;
  customer: string;
}

/** A self service account with `projects` projects and a Stripe customer already bound. */
async function account(admin: Client, projects = 1, bindCustomer = true): Promise<Account> {
  const accountId = uuidv7();
  const email = `billing-${alnum()}@example.com`;
  const customer = `cus_${alnum()}`;
  await admin.query(
    `INSERT INTO accounts (id, name, origin, owner_email, stripe_customer_id)
     VALUES ($1, $2, 'self_serve', $3, $4)`,
    [accountId, `Billing ${accountId.slice(-6)}`, email, bindCustomer ? customer : null],
  );
  const projectIds: string[] = [];
  for (let i = 0; i < projects; i += 1) {
    const projectId = uuidv7();
    await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)`, [
      projectId,
      accountId,
      `P${String(i)}`,
    ]);
    projectIds.push(projectId);
  }
  return { accountId, projectIds, email, customer };
}

interface ApplyArgs {
  customer: string;
  subscription: string;
  reference?: string | null;
  plan: 'pro' | 'scale' | null;
  status: string;
  periodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  scheduled?: 'pro' | 'scale' | null;
  sdi?: string | null;
  at?: string;
  readAt?: string | null;
}

interface ApplyRow {
  account_id: string | null;
  outcome: string;
  plan_from: string | null;
  plan_to: string | null;
  reason: string | null;
  ended_unpaid: boolean;
}

async function apply(app: Client, args: ApplyArgs): Promise<ApplyRow> {
  const { rows } = await app.query<ApplyRow>(
    `SELECT * FROM billing_subscription_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      args.customer,
      args.subscription,
      args.reference ?? null,
      args.plan,
      args.status,
      args.periodEnd ?? null,
      args.cancelAtPeriodEnd ?? false,
      args.scheduled ?? null,
      args.sdi ?? null,
      args.at ?? new Date().toISOString(),
      args.readAt === undefined ? new Date().toISOString() : args.readAt,
    ],
  );
  return rows[0]!;
}

async function planOf(admin: Client, accountId: string): Promise<string> {
  const { rows } = await admin.query<{ plan: string }>('SELECT plan FROM accounts WHERE id = $1', [
    accountId,
  ]);
  return rows[0]!.plan;
}

async function planEvents(
  admin: Client,
  projectId: string,
): Promise<{ environment: string; data: Record<string, unknown>; actor: unknown }[]> {
  const { rows } = await admin.query<{
    environment: string;
    data: Record<string, unknown>;
    actor: unknown;
  }>(
    `SELECT environment, data, actor FROM events
      WHERE project_id = $1 AND type = 'plan.changed' ORDER BY seq`,
    [projectId],
  );
  return rows;
}

describe('the billing tables and functions', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('are closed: row security forced, no policy, and nothing the application role can read', async () => {
    const a = await account(admin);
    await apply(app, {
      customer: a.customer,
      subscription: `sub_${alnum()}`,
      plan: 'pro',
      status: 'active',
    });
    for (const table of BILLING_TABLES) {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = $1`,
        [table],
      );
      expect(rows[0]?.relrowsecurity, table).toBe(true);
      expect(rows[0]?.relforcerowsecurity, table).toBe(true);
      const { rows: policies } = await admin.query(
        `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      expect(policies, table).toEqual([]);
      const refused = await expectPgError(app.query(`SELECT * FROM ${table}`));
      expect(refused.code, table).toBe('42501');
    }
  });

  it('are definer functions with a fixed search path, and the event writer is its owner alone', async () => {
    const { rows } = await admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      app_can: boolean;
      public_can: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('bookrail_app', p.oid, 'EXECUTE') AS app_can,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                       WHERE x.grantee = 0) AS public_can
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = ANY($1)`,
      [[...APP_FUNCTIONS, 'billing_write_plan_changed']],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(
      [...APP_FUNCTIONS, 'billing_write_plan_changed'].sort(),
    );
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(
        (row.proconfig ?? []).some((c) => c.startsWith('search_path=')),
        row.proname,
      ).toBe(true);
      expect(row.public_can, row.proname).toBe(false);
      expect(row.app_can, row.proname).toBe(row.proname !== 'billing_write_plan_changed');
    }
    const refused = await expectPgError(
      app.query(
        `SELECT billing_write_plan_changed($1, 'free', 'pro', 'admin', now(), '{}'::jsonb)`,
        [uuidv7()],
      ),
    );
    expect(refused.code).toBe('42501');
  });

  it('say what a live subscription is in one place, which reads nothing', async () => {
    const statuses = [
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ];
    const { rows } = await app.query<{ status: string; live: boolean }>(
      'SELECT s AS status, billing_subscription_is_live(s) AS live FROM unnest($1::text[]) s',
      [statuses],
    );
    expect(rows.filter((r) => r.live).map((r) => r.status)).toEqual([
      'incomplete',
      'trialing',
      'active',
      'past_due',
    ]);
    const { rows: fn } = await admin.query<{
      prosecdef: boolean;
      provolatile: string;
      public_can: boolean;
    }>(
      `SELECT p.prosecdef, p.provolatile,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                       WHERE x.grantee = 0) AS public_can
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'billing_subscription_is_live'`,
    );
    expect(fn).toEqual([{ prosecdef: false, provolatile: 'i', public_can: false }]);
  });
});

describe('a subscription and the plan of its account', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('moves free to pro on activation, with one plan.changed in the live log of every project', async () => {
    const a = await account(admin, 2);
    const other = await account(admin, 1);
    const subscription = `sub_${alnum()}`;

    // The first payment still in progress: nothing moves.
    const pending = await apply(app, {
      customer: a.customer,
      subscription,
      reference: a.accountId,
      plan: 'pro',
      status: 'incomplete',
    });
    expect(pending.outcome).toBe('unchanged');
    expect(await planOf(admin, a.accountId)).toBe('free');

    const at = '2026-09-15T10:00:00.000Z';
    const active = await apply(app, {
      customer: a.customer,
      subscription,
      reference: a.accountId,
      plan: 'pro',
      status: 'active',
      periodEnd: '2026-10-01T00:00:00.000Z',
      sdi: 'M5UXCR1',
      at,
    });
    expect(active).toMatchObject({
      outcome: 'changed',
      plan_from: 'free',
      plan_to: 'pro',
      reason: 'checkout',
    });
    expect(await planOf(admin, a.accountId)).toBe('pro');
    expect(await planOf(admin, other.accountId)).toBe('free');

    for (const projectId of a.projectIds) {
      const events = await planEvents(admin, projectId);
      expect(events).toHaveLength(1);
      expect(events[0]?.environment).toBe('live');
      expect(events[0]?.data).toEqual({
        object: 'plan_change',
        account_id: `acct_${a.accountId.replace(/-/g, '')}`,
        from: 'free',
        to: 'pro',
        reason: 'checkout',
        effective_at: at,
      });
      expect(events[0]?.actor).toEqual({ type: 'provider', id: null });
    }
    expect(await planEvents(admin, other.projectIds[0]!)).toEqual([]);

    // The same state again changes nothing and writes nothing.
    const again = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'active',
    });
    expect(again.outcome).toBe('unchanged');
    expect(await planEvents(admin, a.projectIds[0]!)).toHaveLength(1);

    const { rows } = await admin.query(
      `SELECT plan, status, sdi_or_pec, previous_plan, plan_since FROM billing_subscriptions
        WHERE account_id = $1`,
      [a.accountId],
    );
    expect(rows[0]).toMatchObject({
      plan: 'pro',
      status: 'active',
      sdi_or_pec: 'M5UXCR1',
      previous_plan: 'free',
    });
    expect((rows[0] as { plan_since: Date }).plan_since.toISOString()).toBe(at);
  });

  it('refuses a reference to another account than the one of the customer', async () => {
    const a = await account(admin);
    const b = await account(admin);
    const result = await apply(app, {
      customer: a.customer,
      subscription: `sub_${alnum()}`,
      reference: b.accountId,
      plan: 'pro',
      status: 'active',
    });
    expect(result.outcome).toBe('mismatch');
    expect(await planOf(admin, a.accountId)).toBe('free');
    expect(await planOf(admin, b.accountId)).toBe('free');
  });

  it('binds an unbound customer to the referenced account, and ignores a customer nobody knows', async () => {
    const a = await account(admin, 1, false);
    const customer = `cus_${alnum()}`;
    const bound = await apply(app, {
      customer,
      subscription: `sub_${alnum()}`,
      reference: a.accountId,
      plan: 'scale',
      status: 'active',
    });
    expect(bound).toMatchObject({ outcome: 'changed', plan_to: 'scale' });
    const { rows } = await admin.query('SELECT stripe_customer_id FROM accounts WHERE id = $1', [
      a.accountId,
    ]);
    expect(rows[0]).toEqual({ stripe_customer_id: customer });

    const nobody = await apply(app, {
      customer: `cus_${alnum()}`,
      subscription: `sub_${alnum()}`,
      plan: 'pro',
      status: 'active',
    });
    expect(nobody.outcome).toBe('unmatched');
  });

  it('keeps the plan through past_due, and returns to free with payment_failed after it', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'active' });

    const { rows: failed } = await app.query<{ first_failure: boolean; grace_ends_at: Date }>(
      "SELECT * FROM billing_payment_failed($1, $2, 'past_due', $3)",
      [a.customer, subscription, '2026-10-01T00:05:00Z'],
    );
    expect(failed[0]?.first_failure).toBe(true);
    expect(failed[0]?.grace_ends_at.toISOString()).toBe('2026-10-15T00:05:00.000Z');
    // A second failure in the same period is not the start of anything.
    const { rows: second } = await app.query<{ first_failure: boolean; grace_ends_at: Date }>(
      "SELECT * FROM billing_payment_failed($1, $2, 'past_due', $3)",
      [a.customer, subscription, '2026-10-04T00:05:00Z'],
    );
    expect(second[0]?.first_failure).toBe(false);
    expect(second[0]?.grace_ends_at.toISOString()).toBe('2026-10-15T00:05:00.000Z');

    const pastDue = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'past_due',
    });
    expect(pastDue.outcome).toBe('unchanged');
    expect(await planOf(admin, a.accountId)).toBe('pro');

    const canceled = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'canceled',
    });
    expect(canceled).toMatchObject({
      outcome: 'changed',
      plan_from: 'pro',
      plan_to: 'free',
      reason: 'payment_failed',
    });
    expect(await planOf(admin, a.accountId)).toBe('free');
  });

  it('clears the failure when a payment succeeds, and a plain cancellation is canceled', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription, plan: 'scale', status: 'active' });
    await app.query("SELECT * FROM billing_payment_failed($1, $2, 'past_due', now())", [
      a.customer,
      subscription,
    ]);
    await apply(app, { customer: a.customer, subscription, plan: 'scale', status: 'active' });
    const { rows } = await admin.query(
      'SELECT past_due_since FROM billing_subscriptions WHERE account_id = $1',
      [a.accountId],
    );
    expect(rows[0]).toEqual({ past_due_since: null });
    const canceled = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'scale',
      status: 'canceled',
    });
    expect(canceled).toMatchObject({ plan_to: 'free', reason: 'canceled' });
  });

  it('moves between paid plans as subscription_update and remembers which plan served a month', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'scale',
      status: 'active',
      at: '2026-09-10T00:00:00Z',
    });
    // The move down scheduled at the end of the period, applied by Stripe on the first.
    const down = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'active',
      at: '2026-10-01T00:00:03Z',
    });
    expect(down).toMatchObject({
      outcome: 'changed',
      plan_from: 'scale',
      plan_to: 'pro',
      reason: 'subscription_update',
    });

    const context = async (month: string) => {
      const { rows } = await app.query<{
        plan: string;
        days_in_month: number;
        free_days: number;
        pro_days: number;
        scale_days: number;
      }>('SELECT * FROM billing_overage_context($1, $2)', [a.customer, month]);
      return rows[0];
    };
    // September: free until the 9th, scale from the 10th (the day of the move counts on the new
    // plan), and scale on its last day; October entirely pro (the move down at midnight of the
    // first).
    expect(await context('2026-09')).toMatchObject({
      plan: 'scale',
      days_in_month: 30,
      free_days: 9,
      pro_days: 0,
      scale_days: 21,
    });
    expect(await context('2026-10')).toMatchObject({
      plan: 'pro',
      days_in_month: 31,
      free_days: 0,
      pro_days: 31,
      scale_days: 0,
    });
    // The history the context read, written by the one writer of plan.changed.
    const { rows: history } = await admin.query(
      `SELECT plan_from, plan_to, at FROM billing_plan_history WHERE account_id = $1 ORDER BY at`,
      [a.accountId],
    );
    expect(history).toEqual([
      { plan_from: 'free', plan_to: 'scale', at: new Date('2026-09-10T00:00:00Z') },
      { plan_from: 'scale', plan_to: 'pro', at: new Date('2026-10-01T00:00:03Z') },
    ]);
  });

  it('counts each day of a month on the plan in force at its end, from the history (T5)', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    // February 2027 has 28 days. Pro from the 15th at 00:00 exactly: the 15th counts on Pro.
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'active',
      at: '2027-02-15T00:00:00Z',
    });
    // Up to Scale on the last day at 23:59: the last day counts on Scale.
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'scale',
      status: 'active',
      at: '2027-02-28T23:59:00Z',
    });
    // Down to Pro at midnight of the first: March is Pro, February is untouched.
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'active',
      at: '2027-03-01T00:00:00Z',
    });
    const context = async (month: string) =>
      (await app.query('SELECT * FROM billing_overage_context($1, $2)', [a.customer, month]))
        .rows[0] as Record<string, unknown>;
    expect(await context('2027-02')).toMatchObject({
      plan: 'scale',
      days_in_month: 28,
      free_days: 14,
      pro_days: 13,
      scale_days: 1,
    });
    expect(await context('2027-03')).toMatchObject({
      plan: 'pro',
      days_in_month: 31,
      pro_days: 31,
    });
    // Before the first change the plan is the one the first change moved from.
    expect(await context('2027-01')).toMatchObject({ plan: null, free_days: 31 });
    // Cancelled on 10 April for a failed payment: billed at Pro's prices for its nine days.
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'canceled',
      at: '2027-04-10T08:00:00Z',
    });
    expect(await context('2027-04')).toMatchObject({ plan: 'pro', pro_days: 9, free_days: 21 });
  });

  it('refuses a reading of Stripe older than the last one applied to the row (T8)', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'active',
      readAt: '2026-09-25T06:40:01Z',
    });
    const stale = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'scale',
      status: 'active',
      readAt: '2026-09-25T06:40:00Z',
    });
    expect(stale.outcome).toBe('stale_read');
    expect(await planOf(admin, a.accountId)).toBe('pro');
    const newer = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'scale',
      status: 'active',
      readAt: '2026-09-25T06:40:02Z',
    });
    expect(newer.outcome).toBe('changed');
  });

  it('starts the fourteen days only for a subscription Stripe holds past_due, and tells once whatever the order', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'active' });
    // A failed payment that leaves the subscription active: a move up waiting for its payment.
    const { rows: none } = await app.query(
      "SELECT * FROM billing_payment_failed($1, $2, 'active', now())",
      [a.customer, subscription],
    );
    expect(none).toEqual([]);
    // The update of the subscription processed before the failure: the notice still goes, once.
    await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'past_due' });
    const failed = async () =>
      (
        await app.query<{ first_failure: boolean }>(
          "SELECT * FROM billing_payment_failed($1, $2, 'past_due', now())",
          [a.customer, subscription],
        )
      ).rows[0]?.first_failure;
    expect(await failed()).toBe(true);
    expect(await failed()).toBe(false);
    const ended = await apply(app, {
      customer: a.customer,
      subscription,
      plan: 'pro',
      status: 'canceled',
    });
    expect(ended).toMatchObject({
      outcome: 'changed',
      reason: 'payment_failed',
      ended_unpaid: true,
    });
    // Every later delivery of the end still says it ended unpaid (T4).
    expect(
      await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'canceled' }),
    ).toMatchObject({ outcome: 'unchanged', ended_unpaid: true });
  });

  it('keeps with row checks what the code used to be alone to keep (T13)', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'active' });
    await expect(
      admin.query(`UPDATE billing_subscriptions SET past_due_since = now() WHERE account_id = $1`, [
        a.accountId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `UPDATE billing_subscriptions SET duplicate_subscription_id = stripe_subscription_id
          WHERE account_id = $1`,
        [a.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const { rows } = await app.query<{ id: string }>(CLAIM, [
      a.accountId,
      '2026-01',
      'pro',
      'renewal',
      null,
      10,
      5,
      3,
      1001,
      0,
      4,
      null,
    ]);
    const id = rows[0]!.id;
    for (const change of [
      'SET payments_amount = payments_amount + 1',
      "SET status = 'applied'",
      'SET leased_until = NULL',
      "SET placement = 'final_invoice'",
      "SET status = 'nothing_due'",
    ]) {
      await expect(
        admin.query(`UPDATE billing_overages ${change} WHERE id = $1`, [id]),
        change,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('records the SdI code read from the Checkout Session on the invoice and the subscription (S6)', async () => {
    const a = await account(admin);
    const subscription = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'active' });
    const invoice = `in_${alnum()}`;
    await app.query(
      `SELECT * FROM billing_invoice_record($1, $2, NULL, NULL, now(), 'eur', 'Acme', NULL, NULL,
         NULL, NULL, 'IT', '{}'::jsonb, 'it_vat', '[]'::jsonb, 545, 120, 665)`,
      [invoice, a.customer],
    );
    const { rows } = await app.query('SELECT billing_invoice_sdi($1, $2) AS sdi', [
      invoice,
      '0000000',
    ]);
    expect(rows[0]).toEqual({ sdi: '0000000' });
    // Never over one already there.
    await app.query('SELECT billing_invoice_sdi($1, $2)', [invoice, 'OTHER01']);
    const { rows: stored } = await admin.query(
      `SELECT i.sdi_or_pec AS invoice, b.sdi_or_pec AS subscription
         FROM billing_invoices i JOIN billing_subscriptions b ON b.account_id = i.account_id
        WHERE i.stripe_invoice_id = $1`,
      [invoice],
    );
    expect(stored).toEqual([{ invoice: '0000000', subscription: '0000000' }]);
  });

  it('does not let the late death of an old subscription take the plan from a new one', async () => {
    const a = await account(admin);
    const old = `sub_${alnum()}`;
    const fresh = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription: old, plan: 'pro', status: 'active' });
    await apply(app, { customer: a.customer, subscription: old, plan: 'pro', status: 'canceled' });
    await apply(app, {
      customer: a.customer,
      subscription: fresh,
      plan: 'scale',
      status: 'active',
    });
    expect(await planOf(admin, a.accountId)).toBe('scale');
    const stale = await apply(app, {
      customer: a.customer,
      subscription: old,
      plan: 'pro',
      status: 'canceled',
    });
    expect(stale.outcome).toBe('stale');
    expect(await planOf(admin, a.accountId)).toBe('scale');
  });

  it('never moves an enterprise account', async () => {
    const a = await account(admin);
    await admin.query(`UPDATE accounts SET plan = 'enterprise' WHERE id = $1`, [a.accountId]);
    const subscription = `sub_${alnum()}`;
    expect(
      (await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'active' }))
        .outcome,
    ).toBe('enterprise_untouched');
    expect(
      (await apply(app, { customer: a.customer, subscription, plan: 'pro', status: 'canceled' }))
        .outcome,
    ).toBe('enterprise_untouched');
    expect(await planOf(admin, a.accountId)).toBe('enterprise');
  });

  it('lists only the subscriptions past due for more than fourteen days, by its own clock', async () => {
    const late = await account(admin);
    const recent = await account(admin);
    const lateSub = `sub_${alnum()}`;
    const recentSub = `sub_${alnum()}`;
    for (const [a, sub] of [
      [late, lateSub],
      [recent, recentSub],
    ] as const) {
      await apply(app, { customer: a.customer, subscription: sub, plan: 'pro', status: 'active' });
    }
    await app.query(
      `SELECT * FROM billing_payment_failed($1, $2, 'past_due', now() - interval '15 days')`,
      [late.customer, lateSub],
    );
    await app.query(
      `SELECT * FROM billing_payment_failed($1, $2, 'past_due', now() - interval '13 days')`,
      [recent.customer, recentSub],
    );
    await apply(app, {
      customer: late.customer,
      subscription: lateSub,
      plan: 'pro',
      status: 'past_due',
    });
    await apply(app, {
      customer: recent.customer,
      subscription: recentSub,
      plan: 'pro',
      status: 'past_due',
    });
    const { rows } = await app.query<{ stripe_subscription_id: string }>(
      'SELECT * FROM billing_overdue_subscriptions()',
    );
    const ids = rows.map((r) => r.stripe_subscription_id);
    expect(ids).toContain(lateSub);
    expect(ids).not.toContain(recentSub);
  });

  it('lists every unpaid or paused subscription to cancel, and never a live one', async () => {
    const unpaid = await account(admin);
    const paused = await account(admin);
    const active = await account(admin);
    const subs = { unpaid: `sub_${alnum()}`, paused: `sub_${alnum()}`, active: `sub_${alnum()}` };
    await apply(app, {
      customer: unpaid.customer,
      subscription: subs.unpaid,
      plan: 'pro',
      status: 'active',
    });
    await apply(app, {
      customer: paused.customer,
      subscription: subs.paused,
      plan: 'pro',
      status: 'active',
    });
    await apply(app, {
      customer: active.customer,
      subscription: subs.active,
      plan: 'pro',
      status: 'active',
    });
    // Dead: the account is back on free the moment Stripe says so.
    expect(
      await apply(app, {
        customer: unpaid.customer,
        subscription: subs.unpaid,
        plan: 'pro',
        status: 'unpaid',
      }),
    ).toMatchObject({ outcome: 'changed', plan_to: 'free', reason: 'payment_failed' });
    await apply(app, {
      customer: paused.customer,
      subscription: subs.paused,
      plan: 'pro',
      status: 'paused',
    });
    expect(await planOf(admin, paused.accountId)).toBe('free');

    const { rows } = await app.query<{ stripe_subscription_id: string; status: string }>(
      'SELECT * FROM billing_overdue_subscriptions()',
    );
    const found = new Map(rows.map((r) => [r.stripe_subscription_id, r.status]));
    expect(found.get(subs.unpaid)).toBe('unpaid');
    expect(found.get(subs.paused)).toBe('paused');
    expect(found.has(subs.active)).toBe(false);

    const { rows: live } = await app.query<{
      stripe_subscription_id: string;
      stripe_customer_id: string;
    }>('SELECT * FROM billing_live_subscriptions()');
    const liveIds = live.map((r) => r.stripe_subscription_id);
    expect(liveIds).toContain(subs.active);
    expect(liveIds).not.toContain(subs.unpaid);
    expect(liveIds).not.toContain(subs.paused);
    expect(live.find((r) => r.stripe_subscription_id === subs.active)?.stripe_customer_id).toBe(
      active.customer,
    );

    const { rows: owner } = await app.query('SELECT * FROM billing_customer_account($1)', [
      active.customer,
    ]);
    expect(owner).toEqual([
      {
        account_id: active.accountId,
        account_name: expect.any(String) as unknown,
        account_plan: 'pro',
        stripe_subscription_id: subs.active,
        subscription_status: 'active',
        subscription_live: true,
        subscription_created_at: expect.any(Date) as unknown,
      },
    ]);
  });

  it('never replaces a live subscription with a second live one, and reports each duplicate once', async () => {
    const a = await account(admin, 2);
    const first = `sub_${alnum()}`;
    const second = `sub_${alnum()}`;
    await apply(app, { customer: a.customer, subscription: first, plan: 'pro', status: 'active' });
    const report = async (status: string): Promise<Record<string, unknown>> =>
      (
        await app.query(
          'SELECT * FROM billing_subscription_apply($1, $2, NULL, $3, $4, NULL, false, NULL, NULL, now(), now())',
          [a.customer, second, 'scale', status],
        )
      ).rows[0] as Record<string, unknown>;

    for (const status of ['incomplete', 'active']) {
      const duplicate = await report(status);
      expect(duplicate).toMatchObject({
        outcome: 'duplicate_subscription',
        plan_from: 'pro',
        plan_to: 'pro',
        other_subscription_id: first,
        first_notice: status === 'incomplete',
      });
    }
    expect(await planOf(admin, a.accountId)).toBe('pro');
    const { rows } = await admin.query(
      'SELECT stripe_subscription_id, plan, duplicate_subscription_id FROM billing_subscriptions WHERE account_id = $1',
      [a.accountId],
    );
    expect(rows).toEqual([
      { stripe_subscription_id: first, plan: 'pro', duplicate_subscription_id: second },
    ]);
    expect(await planEvents(admin, a.projectIds[0]!)).toHaveLength(1);

    // The recorded duplicate is read back by the reconciliation too.
    const { rows: live } = await app.query<{ stripe_subscription_id: string; status: string }>(
      'SELECT * FROM billing_live_subscriptions() WHERE account_id = $1',
      [a.accountId],
    );
    expect(live.map((r) => [r.stripe_subscription_id, r.status]).sort()).toEqual(
      [
        [first, 'active'],
        [second, 'duplicate'],
      ].sort(),
    );

    // Once the first is gone, the answer names the duplicate, for the caller to apply it at once.
    const ended = (await apply(app, {
      customer: a.customer,
      subscription: first,
      plan: 'pro',
      status: 'canceled',
    })) as ApplyRow & { other_subscription_id: string | null };
    expect(ended).toMatchObject({ outcome: 'changed', plan_to: 'free' });
    expect(ended.other_subscription_id).toBe(second);
    expect(await planOf(admin, a.accountId)).toBe('free');
    const replaced = await report('active');
    expect(replaced).toMatchObject({ outcome: 'changed', plan_from: 'free', plan_to: 'scale' });
    const { rows: after } = await admin.query(
      'SELECT stripe_subscription_id, duplicate_subscription_id FROM billing_subscriptions WHERE account_id = $1',
      [a.accountId],
    );
    expect(after).toEqual([{ stripe_subscription_id: second, duplicate_subscription_id: null }]);
  });
});

describe('the overage of a month', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  async function seedUsage(
    projectId: string,
    month: string,
    bookings: number,
    volume: number,
    currency: string | null,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed, payment_volume, currency)
       VALUES ($1, $2, 'live', $3, $4, $5, $6)`,
      [uuidv7(), projectId, month, bookings, volume, currency],
    );
  }

  it('reads the same usage as the free plan gate, across projects, live only, one month', async () => {
    const a = await account(admin, 2);
    const b = await account(admin, 1);
    await seedUsage(a.projectIds[0]!, '2026-09', 3000, 150_000, 'EUR');
    await seedUsage(a.projectIds[1]!, '2026-09', 2500, -10_000, 'USD');
    await seedUsage(a.projectIds[0]!, '2026-08', 99, 99, 'EUR');
    await seedUsage(b.projectIds[0]!, '2026-09', 7, 7, 'EUR');

    const billing = await app.query('SELECT * FROM billing_usage_for_month($1, $2)', [
      a.accountId,
      '2026-09',
    ]);
    const gate = await asProject(app, { projectId: a.projectIds[0]!, environment: 'live' }, () =>
      app.query('SELECT * FROM plan_usage_for_account($1, $2)', [a.accountId, '2026-09']),
    );
    expect(billing.rows).toEqual(gate.rows);
    expect(billing.rows[0]).toEqual({
      bookings_confirmed: '5500',
      payment_volume: '140000',
      currency: 'mixed',
    });
  });

  it('is claimed once, and a month with nothing to bill is recorded as such', async () => {
    const a = await account(admin);
    const args = [
      a.accountId,
      '2026-09',
      'pro',
      'renewal',
      'in_1Test',
      5200,
      5000,
      3,
      123_450,
      0,
      4,
      'EUR',
    ];
    const first = await app.query(CLAIM, args);
    expect(first.rows[0]).toMatchObject({
      claimed: true,
      status: 'claimed',
      account_id: a.accountId,
      stripe_customer_id: a.customer,
      origin: 'renewal',
      stripe_invoice_id: 'in_1Test',
      attempts: 0,
      bookings_included: '5000',
      bookings_over: '200',
      bookings_amount: '600',
      payments_amount: '494',
    });
    const second = await app.query(CLAIM, args);
    expect(second.rows[0]).toMatchObject({
      claimed: false,
      status: 'claimed',
      id: (first.rows[0] as { id: string }).id,
    });

    // The first item is recorded as soon as it exists; a retry would skip it.
    await app.query('SELECT billing_overage_settle($1, $2, $3, $4, $5, $6)', [
      (first.rows[0] as { id: string }).id,
      'invoice',
      null,
      'ii_1',
      null,
      false,
    ]);
    const midway = await app.query(CLAIM, args);
    expect(midway.rows[0]).toMatchObject({
      claimed: false,
      status: 'claimed',
      stripe_booking_item_id: 'ii_1',
      stripe_payment_item_id: null,
    });
    await app.query('SELECT billing_overage_settle($1, $2, $3, $4, $5, $6)', [
      (first.rows[0] as { id: string }).id,
      'invoice',
      null,
      'ii_other',
      'ii_2',
      true,
    ]);
    const third = await app.query(CLAIM, args);
    expect(third.rows[0]).toMatchObject({
      claimed: false,
      status: 'applied',
      placement: 'invoice',
      stripe_booking_item_id: 'ii_1',
      stripe_payment_item_id: 'ii_2',
    });

    const empty = await app.query(CLAIM, [
      a.accountId,
      '2026-10',
      'pro',
      'renewal',
      'in_2Test',
      10,
      5000,
      3,
      0,
      0,
      4,
      null,
    ]);
    expect(empty.rows[0]).toMatchObject({
      claimed: true,
      status: 'nothing_due',
      bookings_over: '0',
    });
  });

  it('is claimed once when twenty callers claim at the same instant', async () => {
    const a = await account(admin);
    const clients = await Promise.all(Array.from({ length: 20 }, () => appClient()));
    try {
      const results = await Promise.all(
        clients.map((client) =>
          client.query<{ claimed: boolean }>(CLAIM, [
            a.accountId,
            '2026-09',
            'scale',
            'renewal',
            'in_3Test',
            50_010,
            50_000,
            2,
            0,
            0,
            3,
            null,
          ]),
        ),
      );
      expect(results.filter((r) => r.rows[0]?.claimed === true)).toHaveLength(1);
      const { rows } = await admin.query(
        'SELECT count(*)::int AS n FROM billing_overages WHERE account_id = $1',
        [a.accountId],
      );
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('gives a claim left open back to the reconciliation once its lease has run out, one at a time', async () => {
    const a = await account(admin);
    const claim = (month: string, amount: number) =>
      app.query<{ id: string; claimed: boolean }>(CLAIM, [
        a.accountId,
        month,
        'pro',
        'final',
        null,
        0,
        5000,
        3,
        amount * 250,
        0,
        4,
        'EUR',
      ]);
    const open = (await claim('2026-05', 100)).rows[0]!;
    const done = (await claim('2026-06', 100)).rows[0]!;
    await claim('2026-07', 0); // nothing due: never taken
    await app.query('SELECT billing_overage_settle($1, $2, $3, $4, $5, $6)', [
      done.id,
      'final_invoice',
      'in_Final1',
      null,
      'ii_f',
      true,
    ]);

    const take = async (): Promise<string[]> =>
      (
        await app.query<{ id: string; account_id: string }>(
          'SELECT * FROM billing_overage_take(200)',
        )
      ).rows
        .filter((r) => r.account_id === a.accountId)
        .map((r) => r.id);
    // Still inside the lease of the caller that claimed it.
    expect(await take()).toEqual([]);
    await admin.query(
      `UPDATE billing_overages SET leased_until = now() - interval '1 second' WHERE id = $1`,
      [open.id],
    );
    const { rows: taken } = await app.query<Record<string, unknown>>(
      'SELECT * FROM billing_overage_take(200) WHERE account_id = $1',
      [a.accountId],
    );
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({
      id: open.id,
      claimed: true,
      origin: 'final',
      month: '2026-05',
      attempts: 1,
      stripe_customer_id: a.customer,
      payments_amount: '100',
    });
    // Leased again: a second reconciliation running at the same time does not get it.
    expect(await take()).toEqual([]);
    const { rows: applied } = await admin.query(
      'SELECT status, placement, stripe_invoice_id, leased_until FROM billing_overages WHERE id = $1',
      [done.id],
    );
    expect(applied).toEqual([
      {
        status: 'applied',
        placement: 'final_invoice',
        stripe_invoice_id: 'in_Final1',
        leased_until: null,
      },
    ]);
  });
});

describe('events, invoices and acceptances', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('claims an event once, and a claim that was never settled is not a duplicate', async () => {
    const id = `evt_${alnum()}`;
    const first = await app.query<{ id: string; duplicate: boolean }>(
      'SELECT * FROM billing_event_claim($1, $2, $3)',
      [id, 'invoice.paid', false],
    );
    expect(first.rows[0]?.duplicate).toBe(false);
    const retry = await app.query<{ id: string; duplicate: boolean }>(
      'SELECT * FROM billing_event_claim($1, $2, $3)',
      [id, 'invoice.paid', false],
    );
    expect(retry.rows[0]).toEqual(first.rows[0]);
    await app.query('SELECT billing_event_settle($1, $2)', [first.rows[0]!.id, 'applied']);
    const duplicate = await app.query<{ duplicate: boolean }>(
      'SELECT * FROM billing_event_claim($1, $2, $3)',
      [id, 'invoice.paid', false],
    );
    expect(duplicate.rows[0]?.duplicate).toBe(true);
  });

  it('records a paid invoice once, with the SdI code of the subscription, and lists it in its month', async () => {
    const a = await account(admin);
    await apply(app, {
      customer: a.customer,
      subscription: `sub_${alnum()}`,
      plan: 'pro',
      status: 'active',
      sdi: 'pec@example.com',
    });
    const invoice = `in_${alnum()}`;
    const args = [
      invoice,
      a.customer,
      'BR-0001',
      'https://invoice.stripe.com/i/x',
      '2026-09-30T22:30:00Z',
      'eur',
      'Padel Roma Srl',
      a.email,
      'eu_vat',
      'IT12345678901',
      'verified',
      'IT',
      JSON.stringify({ line1: 'Via Roma 1', city: 'Roma', postal_code: '00100', country: 'IT' }),
      'it_vat',
      JSON.stringify([{ description: 'Bookrail Pro', amount: 2900 }]),
      2900,
      638,
      3538,
    ];
    const sql =
      'SELECT * FROM billing_invoice_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)';
    const first = await app.query<{
      id: string;
      recorded: boolean;
      account_id: string;
      sdi_or_pec: string;
      mailed: boolean;
    }>(sql, args);
    expect(first.rows[0]).toMatchObject({
      recorded: true,
      account_id: a.accountId,
      sdi_or_pec: 'pec@example.com',
      mailed: false,
    });
    await app.query('SELECT billing_invoice_mailed($1)', [first.rows[0]!.id]);
    const second = await app.query<{ recorded: boolean; mailed: boolean }>(sql, args);
    expect(second.rows[0]).toMatchObject({ recorded: false, mailed: true });

    // 22:30 UTC on 30 September is 00:30 on 1 October in Rome: the October list.
    const september = await app.query('SELECT * FROM billing_invoices_of_month($1)', ['2026-09']);
    const october = await app.query<{ stripe_invoice_id: string }>(
      'SELECT * FROM billing_invoices_of_month($1)',
      ['2026-10'],
    );
    expect(
      september.rows.map((r) => (r as { stripe_invoice_id: string }).stripe_invoice_id),
    ).not.toContain(invoice);
    expect(october.rows.map((r) => r.stripe_invoice_id)).toContain(invoice);
  });

  it('carries an acceptance from a sign up request to the account the confirm creates', async () => {
    const email = `terms-${alnum()}@example.com`;
    const linkToken = token('tok');
    const ip = sha256(`ip-${alnum()}`);
    await app.query(
      'SELECT * FROM signup_start($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        uuidv7(),
        email,
        sha256(linkToken),
        null,
        'web',
        ip,
        'Terms Srl',
        'Default',
        'UTC',
        'EUR',
        'v-terms',
        'v-dpa',
      ],
    );
    const accountId = uuidv7();
    await app.query(
      'SELECT * FROM signup_confirm($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        sha256(linkToken),
        accountId,
        uuidv7(),
        uuidv7(),
        'aaaaaaaa',
        sha256(`t-${alnum()}`),
        'test',
        uuidv7(),
        'bbbbbbbb',
        sha256(`l-${alnum()}`),
        'live',
        null,
      ],
    );
    const { rows } = await admin.query(
      `SELECT terms_version, dpa_version, terms_accepted, clauses_approved, ip_hash, channel
         FROM terms_acceptances WHERE account_id = $1`,
      [accountId],
    );
    expect(rows).toEqual([
      {
        terms_version: 'v-terms',
        dpa_version: 'v-dpa',
        terms_accepted: true,
        clauses_approved: true,
        ip_hash: ip,
        channel: 'web',
      },
    ]);
  });

  it('refuses a sign up request that carries no acceptance', async () => {
    const refused = await expectPgError(
      app.query('SELECT * FROM signup_start($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
        uuidv7(),
        `terms-${alnum()}@example.com`,
        sha256(token('tok')),
        null,
        'web',
        sha256('ip'),
        'X',
        'Default',
        'UTC',
        'EUR',
        '',
        'v-dpa',
      ]),
    );
    expect(refused.code).toBe('P0400');
  });

  it('records an acceptance from a live dashboard session, and reads it back for those versions only', async () => {
    const a = await account(admin);
    const link = token('bls');
    const session = token('bds');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      a.email,
      sha256(link),
      sha256(`ip-${alnum()}`),
    ]);
    await app.query('SELECT * FROM dashboard_login_confirm($1, $2)', [
      sha256(link),
      sha256(session),
    ]);

    const before = await app.query<{ terms_accepted_at: Date | null }>(
      'SELECT * FROM billing_account_state($1, $2, $3)',
      [sha256(session), 'v1', 'd1'],
    );
    expect(before.rows[0]?.terms_accepted_at).toBeNull();
    await app.query('SELECT * FROM terms_accept_dashboard($1, $2, $3, $4)', [
      sha256(session),
      'v1',
      'd1',
      sha256('ip'),
    ]);
    const after = await app.query<{ terms_accepted_at: Date | null; stripe_customer_id: string }>(
      'SELECT * FROM billing_account_state($1, $2, $3)',
      [sha256(session), 'v1', 'd1'],
    );
    expect(after.rows[0]?.terms_accepted_at).not.toBeNull();
    expect(after.rows[0]?.stripe_customer_id).toBe(a.customer);
    // A new version is a new question.
    const newer = await app.query<{ terms_accepted_at: Date | null }>(
      'SELECT * FROM billing_account_state($1, $2, $3)',
      [sha256(session), 'v2', 'd1'],
    );
    expect(newer.rows[0]?.terms_accepted_at).toBeNull();

    const invalid = await expectPgError(
      app.query('SELECT * FROM terms_accept_dashboard($1, $2, $3, $4)', [
        sha256(token('bds')),
        'v1',
        'd1',
        null,
      ]),
    );
    expect(invalid.code).toBe('P0401');
  });

  it('binds the customer of a session once, and answers the one in force', async () => {
    const a = await account(admin, 1, false);
    const link = token('bls');
    const session = token('bds');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      a.email,
      sha256(link),
      sha256(`ip-${alnum()}`),
    ]);
    await app.query('SELECT * FROM dashboard_login_confirm($1, $2)', [
      sha256(link),
      sha256(session),
    ]);
    const first = `cus_${alnum()}`;
    const bound = await app.query<{ billing_customer_bind: string }>(
      'SELECT billing_customer_bind($1, $2)',
      [sha256(session), first],
    );
    expect(bound.rows[0]?.billing_customer_bind).toBe(first);
    const again = await app.query<{ billing_customer_bind: string }>(
      'SELECT billing_customer_bind($1, $2)',
      [sha256(session), `cus_${alnum()}`],
    );
    expect(again.rows[0]?.billing_customer_bind).toBe(first);
  });

  it('keeps an acceptance, with the account and the address it was given for, after the account is gone', async () => {
    const a = await account(admin);
    const link = token('bls');
    const session = token('bds');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      a.email,
      sha256(link),
      sha256(`ip-${alnum()}`),
    ]);
    await app.query('SELECT * FROM dashboard_login_confirm($1, $2)', [
      sha256(link),
      sha256(session),
    ]);
    const { rows: accepted } = await app.query<{ id: string }>(
      'SELECT * FROM terms_accept_dashboard($1, $2, $3, $4)',
      [sha256(session), 'v1', 'd1', null],
    );
    await admin.query('DELETE FROM accounts WHERE id = $1', [a.accountId]);
    const { rows } = await admin.query(
      'SELECT account_id, account_ref, owner_email, channel FROM terms_acceptances WHERE id = $1',
      [accepted[0]!.id],
    );
    expect(rows).toEqual([
      { account_id: null, account_ref: a.accountId, owner_email: a.email, channel: 'dashboard' },
    ]);
  });

  it('records the checkout session of an account and answers the one it replaces', async () => {
    const a = await account(admin);
    const link = token('bls');
    const session = token('bds');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      a.email,
      sha256(link),
      sha256(`ip-${alnum()}`),
    ]);
    await app.query('SELECT * FROM dashboard_login_confirm($1, $2)', [
      sha256(link),
      sha256(session),
    ]);
    const record = async (id: string): Promise<string | null> =>
      (
        await app.query<{ billing_checkout_record: string | null }>(
          'SELECT billing_checkout_record($1, $2)',
          [sha256(session), id],
        )
      ).rows[0]!.billing_checkout_record;
    const first = `cs_test_${alnum()}`;
    const second = `cs_test_${alnum()}`;
    expect(await record(first)).toBeNull();
    expect(await record(second)).toBe(first);
    expect(await record(second)).toBeNull();
    const { rows } = await app.query<{ checkout_session_id: string }>(
      'SELECT checkout_session_id FROM billing_account_state($1, $2, $3)',
      [sha256(session), 'v1', 'd1'],
    );
    expect(rows[0]?.checkout_session_id).toBe(second);
    const invalid = await expectPgError(
      app.query('SELECT billing_checkout_record($1, $2)', [sha256(token('bds')), first]),
    );
    expect(invalid.code).toBe('P0401');
  });

  it('keeps the invoices a closed subscription left open until Stripe says they are settled', async () => {
    const a = await account(admin);
    const link = token('bls');
    const session = token('bds');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      a.email,
      sha256(link),
      sha256(`ip-${alnum()}`),
    ]);
    await app.query('SELECT * FROM dashboard_login_confirm($1, $2)', [
      sha256(link),
      sha256(session),
    ]);
    const invoice = `in_${alnum()}`;
    const record = () =>
      app.query<{ account_id: string; recorded: boolean }>(
        'SELECT * FROM billing_unpaid_invoice_record($1, $2, $3, $4, $5, $6)',
        [a.customer, invoice, 'BR-9', 8455, 'EUR', 'https://invoice.stripe.com/i/x'],
      );
    expect((await record()).rows).toEqual([{ account_id: a.accountId, recorded: true }]);
    expect((await record()).rows).toEqual([{ account_id: a.accountId, recorded: false }]);
    // A customer nobody has records nothing.
    const nobody = await app.query(
      'SELECT * FROM billing_unpaid_invoice_record($1, $2, $3, $4, $5, $6)',
      [`cus_${alnum()}`, `in_${alnum()}`, null, 1, 'eur', null],
    );
    expect(nobody.rows).toEqual([]);
    const state = async () =>
      (
        await app.query<{
          unpaid_invoice_id: string | null;
          unpaid_amount_due: string | null;
          unpaid_currency: string | null;
          unpaid_invoice_url: string | null;
        }>('SELECT * FROM billing_account_state($1, $2, $3)', [sha256(session), 'v1', 'd1'])
      ).rows[0];
    expect(await state()).toMatchObject({
      unpaid_invoice_id: invoice,
      unpaid_amount_due: '8455',
      unpaid_currency: 'eur',
      unpaid_invoice_url: 'https://invoice.stripe.com/i/x',
    });
    const settled = await app.query<{ billing_unpaid_invoice_settle: number }>(
      'SELECT billing_unpaid_invoice_settle($1)',
      [invoice],
    );
    expect(settled.rows[0]?.billing_unpaid_invoice_settle).toBe(1);
    expect((await state())?.unpaid_invoice_id).toBeNull();
  });
});
