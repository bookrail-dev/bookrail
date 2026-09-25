/**
 * The three jobs of Billing.
 *
 * ## The fourteen days of a failed payment, and the dead subscriptions
 *
 * Stripe retries a failed payment and writes to the customer; the dashboard shows the date the
 * grace ends. If no payment has succeeded fourteen days after the first failure, the subscription
 * is cancelled at Stripe (`DELETE /v1/subscriptions/{id}` with `invoice_now=true`, so that what
 * is pending on the customer is invoiced, and `prorate=false`, so that nothing is credited). So
 * is every `unpaid` or `paused` one: the account is already on the free plan, and the
 * subscription would otherwise stay at Stripe. After the cancellation, or a refusal, the
 * subscription is read back and applied with the receiver's own code: the plan moves when Stripe
 * says the subscription has ended, which the reading shows at once, and the last overage is
 * billed. The comparison with the fourteen days is made with the database's own clock
 * (`billing_overdue_subscriptions`).
 *
 * ## The daily reconciliation
 *
 * Every subscription the database holds as live, and every recorded duplicate, is read back
 * from Stripe and applied with the same code as an event: an event that was lost (a receiver
 * down for longer than Stripe retries, an endpoint registered wrong) changes nothing for more
 * than a day. The change is recorded at the instant Stripe gives (the end of a subscription, the
 * start of its current period), not at the instant of the reconciliation, so that the plan of
 * the last day of a month stays right. A subscription Stripe no longer knows (`404`) is applied
 * as cancelled. From the second of the month, a live subscription whose closed month has no claim
 * (its `invoice.created` was lost) gets one, as pending items for the next invoice. Then every
 * claim of overage left open by a caller that did not finish, whose lease has run out, is
 * finished; after five failed attempts a person is told.
 *
 * ## The monthly list of paid invoices
 *
 * On the second day of the month at 08:00 in Rome, the paid invoices of the month before (in the
 * calendar of the Italian accounts), one line each and a CSV attached, to whoever issues the
 * electronic invoices. The message of each invoice has already gone when it was paid; this is the
 * list to check them against.
 */
import { sql, withAuthContext } from '@bookrail/db';
import { encodeId, planMonthOf, type Logger } from '@bookrail/shared';
import type { AppDeps, BillingDeps } from '../context.js';
import type { Mailer } from '../mail/index.js';
import { StripeApiError } from '../stripe/client.js';
import type { BillingSubscription } from '../stripe/billing-client.js';
import { monthlyInvoiceListMessage, type MonthlyInvoiceRow } from '../billing/invoice-mail.js';
import type { VatTreatment } from '../billing/catalog.js';
import { isLiveSubscriptionStatus } from '../billing/live.js';
import {
  applySubscriptionState,
  claimMissedRenewal,
  processClaim,
  reportIfStuck,
  takeOpenClaims,
  type Deps,
} from '../billing/events.js';

export type BillingJobDeps = Pick<AppDeps, 'db' | 'logger' | 'mailer' | 'plans'> & {
  billing: BillingDeps;
};

export interface OverdueReport {
  found: number;
  cancelled: number;
  failed: number;
}

function missingAtStripe(error: unknown): boolean {
  return (
    error instanceof StripeApiError && (error.status === 404 || error.code === 'resource_missing')
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The instant a change read back from Stripe is recorded at: the end of a subscription that has
 * ended, the start of the current period of one that is alive (a move down takes effect there, a
 * move up is counted from there, which is what the overage of a closed month needs), and now only
 * when Stripe gives neither.
 */
export function stripeInstantOf(subscription: BillingSubscription): number {
  if (!isLiveSubscriptionStatus(subscription.status))
    return subscription.endedAt ?? subscription.canceledAt ?? nowSeconds();
  return subscription.currentPeriodStart ?? nowSeconds();
}

/**
 * Cancels at Stripe every subscription past due for more than fourteen days, and every unpaid
 * or paused one, then applies what Stripe then says about each.
 */
export async function runBillingOverdue(deps: BillingJobDeps): Promise<OverdueReport> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      account_id: string;
      stripe_subscription_id: string;
      status: string;
      past_due_since: string | null;
    }>(sql`
      SELECT account_id, stripe_subscription_id, status, past_due_since::text AS past_due_since
        FROM billing_overdue_subscriptions()
    `),
  );
  const report: OverdueReport = { found: rows.length, cancelled: 0, failed: 0 };
  for (const row of rows) {
    const fields = {
      account_id: encodeId('account', row.account_id),
      subscription: row.stripe_subscription_id,
      status: row.status,
      past_due_since:
        row.past_due_since === null ? null : new Date(row.past_due_since).toISOString(),
    };
    try {
      await deps.billing.client.cancelSubscription(row.stripe_subscription_id, {
        invoiceNow: true,
        prorate: false,
      });
      report.cancelled += 1;
      deps.logger.info('billing_subscription_cancelled_overdue', fields);
    } catch (error) {
      // A subscription that is already gone at Stripe is the state that was asked for.
      if (missingAtStripe(error)) {
        deps.logger.info('billing_subscription_already_gone', fields);
      } else {
        report.failed += 1;
        deps.logger.error('billing_subscription_cancel_failed', {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Whatever the answer, what Stripe now holds is applied: a cancellation moves the plan at
    // once, and a refusal because the subscription had already ended is recognised as such.
    await reconcileOne(deps, row.stripe_subscription_id, null);
  }
  return report;
}

export interface ReconcileReport {
  subscriptions: number;
  failed: number;
  claims: number;
  /** Claims made for a closed month whose renewal never brought its `invoice.created`. */
  missed: number;
}

/**
 * Reads back one subscription and applies it. A `404` means Stripe no longer has it: it is
 * applied as cancelled, which moves the account to the free plan.
 */
async function reconcileOne(
  deps: BillingJobDeps,
  subscriptionId: string,
  customer: string | null,
): Promise<boolean> {
  const handler: Deps = deps;
  // The instant of the reading, taken before it: a reading older than one the receiver or the
  // dashboard applied in the meantime is refused by the database (`stale_read`).
  const readAt = Date.now();
  try {
    const subscription = await deps.billing.client.retrieveSubscription(subscriptionId);
    await applySubscriptionState(
      handler,
      subscription,
      null,
      null,
      stripeInstantOf(subscription),
      readAt,
    );
    return true;
  } catch (error) {
    if (missingAtStripe(error) && customer !== null) {
      const gone: BillingSubscription = {
        id: subscriptionId,
        customer,
        status: 'canceled',
        price: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        metadata: {},
        itemId: null,
        currentPeriodStart: null,
        defaultPaymentMethod: null,
        endedAt: null,
        canceledAt: null,
        scheduleId: null,
        schedulePhases: [],
        scheduleStatus: null,
        scheduleIsBookrail: false,
        pendingUpdate: null,
        latestInvoice: null,
      };
      await applySubscriptionState(handler, gone, null, null, nowSeconds(), readAt);
      deps.logger.warn('billing_subscription_missing_at_stripe', { subscription: subscriptionId });
      return true;
    }
    deps.logger.error('billing_reconcile_failed', {
      subscription: subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The daily reconciliation: every live subscription read back and applied, then every claim of
 * overage left open finished.
 */
export async function runBillingReconcile(
  deps: BillingJobDeps,
  options: { now?: number } = {},
): Promise<ReconcileReport> {
  const now = options.now ?? Date.now();
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      stripe_subscription_id: string;
      stripe_customer_id: string | null;
      status: string;
    }>(sql`
      SELECT stripe_subscription_id, stripe_customer_id, status FROM billing_live_subscriptions()
    `),
  );
  const report: ReconcileReport = { subscriptions: rows.length, failed: 0, claims: 0, missed: 0 };
  for (const row of rows) {
    if (!(await reconcileOne(deps, row.stripe_subscription_id, row.stripe_customer_id))) {
      report.failed += 1;
    }
  }

  // From the second of the month: the closed month of every live subscription has a claim.
  if (new Date(now).getUTCDate() >= 2) {
    const month = planMonthOf(
      Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) - 1,
    );
    const customers = new Set(
      rows
        .filter((row) => row.status !== 'duplicate' && row.stripe_customer_id !== null)
        .map((row) => row.stripe_customer_id as string),
    );
    for (const customer of customers) {
      try {
        if ((await claimMissedRenewal(deps, customer, month)) === 'claimed') report.missed += 1;
      } catch (error) {
        report.failed += 1;
        deps.logger.error('billing_missed_renewal_failed', {
          month,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  for (;;) {
    const claims = await takeOpenClaims(deps, 50);
    if (claims.length === 0) break;
    for (const claim of claims) {
      try {
        await processClaim(deps, claim);
        report.claims += 1;
      } catch (error) {
        report.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error('billing_overage_resume_failed', {
          account_id: encodeId('account', claim.account_id),
          month: claim.month,
          attempts: claim.attempts,
          error: message,
        });
        await reportIfStuck(deps, claim, error);
      }
    }
    // A claim that failed keeps its new lease for ten minutes, so it is not taken again in
    // this run: the loop ends when nothing is left to take.
  }
  deps.logger.info('billing_reconciled', { ...report });
  return report;
}

/** `YYYY-MM` of the month before the one `now` is in, in the calendar of Rome. */
export function previousMonthInRome(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(now));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${String(previousYear)}-${String(previousMonth).padStart(2, '0')}`;
}

/** Sends the list of the paid invoices of one month. */
export async function runBillingInvoiceList(
  deps: { db: AppDeps['db']; logger: Logger; mailer: Mailer },
  options: { to: string; now?: number; month?: string },
): Promise<{ month: string; invoices: number }> {
  const month = options.month ?? previousMonthInRome(options.now ?? Date.now());
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      stripe_invoice_id: string;
      number: string | null;
      paid_at: string;
      customer_name: string | null;
      tax_id_value: string | null;
      tax_id_verification: string | null;
      country: string | null;
      sdi_or_pec: string | null;
      vat_treatment: VatTreatment;
      currency: string;
      subtotal: string;
      tax: string;
      total: string;
      hosted_invoice_url: string | null;
    }>(sql`
      SELECT stripe_invoice_id, number, paid_at::text AS paid_at, customer_name, tax_id_value,
             tax_id_verification, country, sdi_or_pec, vat_treatment, currency,
             subtotal::text AS subtotal, tax::text AS tax, total::text AS total,
             hosted_invoice_url
        FROM billing_invoices_of_month(${month})
    `),
  );
  const invoices: MonthlyInvoiceRow[] = rows.map((row) => ({
    stripeInvoiceId: row.stripe_invoice_id,
    number: row.number,
    paidAt: new Date(row.paid_at).toISOString(),
    customerName: row.customer_name,
    taxIdValue: row.tax_id_value,
    taxIdVerification: row.tax_id_verification,
    country: row.country,
    sdiOrPec: row.sdi_or_pec,
    vatTreatment: row.vat_treatment,
    currency: row.currency,
    subtotal: Number(row.subtotal),
    tax: Number(row.tax),
    total: Number(row.total),
    hostedInvoiceUrl: row.hosted_invoice_url,
  }));
  await deps.mailer.send(monthlyInvoiceListMessage(options.to, month, invoices));
  deps.logger.info('billing_invoice_list_sent', { month, invoices: invoices.length });
  return { month, invoices: invoices.length };
}
