/**
 * What each Stripe Billing event does, once its signature has been verified and it has been
 * claimed, and what the daily jobs do with the same code.
 *
 * ## The order of things, in every handler
 *
 * Stripe is called first, **outside** any transaction of the database (a subscription read back,
 * the tax ids of a customer, an invoice item added); then one short transaction through a
 * `SECURITY DEFINER` function writes what the answer means; then, after the commit, a message is
 * sent without anybody waiting for it. A call to Stripe inside a transaction would hold row locks
 * for the length of somebody else's network.
 *
 * ## Why a subscription is read back instead of trusted
 *
 * Stripe does not deliver events in order, and a `customer.subscription.updated` can arrive
 * after the `customer.subscription.deleted` that followed it. Applying the object inside each
 * event would let an old state overwrite a newer one. So a subscription event is treated as a
 * notice that something changed, and the subscription is read back from Stripe as it is now:
 * whatever the order of arrival, the last one applied is the newest state. The schedule is read
 * with it, which is where a move down at the end of the period is. The daily reconciliation
 * applies the same reading to every subscription the database holds as live, so an event that
 * never arrived changes nothing for more than a day.
 *
 * ## The overage, from the claim
 *
 * The overage of a month is claimed once in `billing_overages` before Stripe is called, and the
 * lines are written from that row: the quantities, the amounts and the invoice as they were at
 * the claim (the tax of the lines is Stripe Tax's, on the invoice they go on). Only the caller that wrote the claim goes on; a
 * claim left open (a process that died halfway) is finished by the daily reconciliation. A line
 * refused by the draft is put on the next invoice only when a reading of the invoice says it is
 * no longer a draft, or no longer exists: an `idempotency_error`, or any refusal of a draft that
 * is still a draft, is an error, never a placement; and a line already at Stripe (found by its
 * metadata on the draft, among the pending items, or as the invoice of a last month) is recorded,
 * never created again.
 *
 * ## The tax
 *
 * Stripe Tax computes it, on the checkout, the subscription and every invoice Bookrail creates
 * (`automatic_tax`). The data of the electronic invoice take the rate, the taxable amount and the
 * reason (`reverse_charge`, `standard_rated`, ...) from the taxes Stripe put on the invoice.
 */
import { sql, withAuthContext } from '@bookrail/db';
import {
  PLANS,
  decodeId,
  encodeId,
  planMonthOf,
  type Logger,
  type PlanTable,
} from '@bookrail/shared';
import type { AppDeps, BillingDeps } from '../context.js';
import {
  paymentFailedMessage,
  planChangedMessage,
  subscriptionClosedUnpaidMessage,
} from '../mail/messages.js';
import { StripeApiError } from '../stripe/client.js';
import {
  invoiceLinesOf,
  type BillingInvoiceLine,
  type BillingInvoiceSummary,
  type BillingSubscription,
} from '../stripe/billing-client.js';
import { isLiveSubscriptionStatus } from './live.js';
import {
  CatalogIncomplete,
  planOfPrice,
  resolveCatalog,
  vatTreatmentOf,
  type Catalog,
  type VatTreatment,
} from './catalog.js';
import { invoiceDataMessage, type InvoiceData } from './invoice-mail.js';
import {
  duplicateEndedMessage,
  duplicateSubscriptionMessage,
  enterpriseSubscriptionMessage,
  fiscalDataChangedMessage,
  overageStuckMessage,
  unpaidInvoicesMessage,
} from './notices.js';
import {
  computeOverage,
  finalInvoiceIdempotencyKey,
  monthName,
  overageIdempotencyKey,
  overageLines,
  type ClaimedOverage,
  type Overage,
} from './overage.js';
import { SDI_FIELD_KEY } from './checkout.js';

export type Outcome = 'applied' | 'ignored' | 'unmatched';

export interface BillingEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** Unix seconds: when Stripe says it happened. */
  created: number;
  account: string | null;
  object: Record<string, unknown>;
  /** `data.previous_attributes` of an `*.updated` event: what changed, with the old values. */
  previousAttributes?: Record<string, unknown> | null;
}

export type Deps = Pick<AppDeps, 'db' | 'logger' | 'mailer' | 'plans'> & { billing: BillingDeps };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An identifier that may come as a string or as an expanded object. */
function idOf(value: unknown): string | null {
  return typeof value === 'string' ? asString(value) : asString(asObject(value)?.id);
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function plansOf(deps: Pick<AppDeps, 'plans'>): PlanTable {
  return deps.plans ?? PLANS;
}

function freeIncludedOf(deps: Pick<AppDeps, 'plans'>): number {
  return plansOf(deps).free.bookingsIncluded ?? 0;
}

// --- Subscriptions ------------------------------------------------------------------------------

interface ApplyRow {
  [column: string]: unknown;
  account_id: string | null;
  outcome: string;
  plan_from: string | null;
  plan_to: string | null;
  reason: string | null;
  owner_email: string | null;
  account_name: string | null;
  other_subscription_id: string | null;
  first_notice: boolean;
  /** The subscription on file has ended after a failed payment (migration 0028). */
  ended_unpaid: boolean;
}

/** The plan the schedule moves the subscription to at the end of the period, if it does. */
function scheduledPlanOf(
  subscription: BillingSubscription,
  catalog: Catalog | null,
): string | null {
  const end = subscription.currentPeriodEnd;
  if (end === null) return null;
  const next = subscription.schedulePhases.find(
    (phase) => phase.startDate !== null && phase.startDate >= end,
  );
  if (next === undefined) return null;
  const plan =
    planOfPrice({ id: next.priceIds[0] ?? '', lookupKey: next.lookupKeys[0] ?? null }, catalog) ??
    null;
  const current = planOfPrice(subscription.price, catalog);
  return plan === current ? null : plan;
}

/**
 * Reads a subscription back from Stripe and applies it to the account of its customer.
 *
 * `reference` is the account the checkout was opened for, when the event names one, and the
 * database verifies it against the customer. `sdi` is the SdI code or PEC typed in the checkout.
 */
export async function applySubscription(
  deps: Deps,
  subscriptionId: string,
  reference: string | null,
  sdi: string | null,
  at: number,
): Promise<Outcome> {
  // The instant of the reading, taken before it: two readings applied out of order are told
  // apart by it (`stale_read`).
  const readAt = Date.now();
  const subscription = await deps.billing.client.retrieveSubscription(subscriptionId);
  return applySubscriptionState(deps, subscription, reference, sdi, at, readAt);
}

/**
 * Applies a subscription as Stripe holds it now: the receiver after reading it back, and the
 * daily reconciliation with the same reading. When the subscription has ended, its last overage
 * is billed on an invoice of its own.
 */
export async function applySubscriptionState(
  deps: Deps,
  subscription: BillingSubscription,
  reference: string | null,
  sdi: string | null,
  at: number,
  readAt: number | null = null,
): Promise<Outcome> {
  const catalog = await catalogOrNull(deps);
  const plan = planOfPrice(subscription.price, catalog);
  const scheduled = scheduledPlanOf(subscription, catalog);
  const customer = subscription.customer;
  if (customer === null) {
    deps.logger.error('billing_subscription_without_customer', { subscription: subscription.id });
    return 'ignored';
  }
  const accountReference =
    reference ?? decodeAccount(subscription.metadata.bookrail_account_id ?? null);

  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<ApplyRow>(sql`
      SELECT * FROM billing_subscription_apply(
        ${customer},
        ${subscription.id},
        ${accountReference}::uuid,
        ${plan},
        ${subscription.status},
        ${subscription.currentPeriodEnd === null ? null : iso(subscription.currentPeriodEnd)}::timestamptz,
        ${subscription.cancelAtPeriodEnd},
        ${scheduled},
        ${sdi},
        ${iso(at)}::timestamptz,
        ${readAt === null ? null : new Date(readAt).toISOString()}::timestamptz
      )
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('billing_subscription_apply answered no row.');
  const fields = {
    subscription: subscription.id,
    status: subscription.status,
    account_id: row.account_id === null ? null : encodeId('account', row.account_id),
    outcome: row.outcome,
  };
  switch (row.outcome) {
    case 'changed':
      deps.logger.info('billing_plan_changed', {
        ...fields,
        from: row.plan_from,
        to: row.plan_to,
        reason: row.reason,
      });
      if (row.owner_email !== null && row.plan_from !== null && row.plan_to !== null) {
        sendLater(
          deps,
          planChangedMessage({
            to: row.owner_email,
            accountName: row.account_name ?? '',
            from: row.plan_from,
            to_plan: row.plan_to,
            reason: row.reason ?? 'subscription_update',
            freeBookingsIncluded: freeIncludedOf(deps),
          }),
          'billing_plan_changed_mail_failed',
        );
      }
      await afterApplied(deps, subscription, customer, row, at, readAt);
      return 'applied';
    case 'unchanged':
      await afterApplied(deps, subscription, customer, row, at, readAt);
      return 'applied';
    case 'stale_read':
      // A reading of Stripe older than one already applied: a newer state is on file.
      deps.logger.info('billing_subscription_stale_read', fields);
      return 'ignored';
    case 'duplicate_subscription':
      // Two checkouts were paid: two subscriptions take money for one account. Nothing is
      // applied, and a person is told which one to cancel and refund.
      deps.logger.error('billing_duplicate_subscription', {
        ...fields,
        kept: row.other_subscription_id,
        first_notice: row.first_notice,
      });
      if (row.first_notice && row.account_id !== null && row.other_subscription_id !== null) {
        sendLater(
          deps,
          duplicateSubscriptionMessage(deps.billing.invoiceTo, {
            accountId: encodeId('account', row.account_id),
            accountName: row.account_name,
            customer,
            kept: row.other_subscription_id,
            duplicate: subscription.id,
          }),
          'billing_duplicate_mail_failed',
        );
      }
      return 'ignored';
    case 'unmatched':
      deps.logger.warn('billing_subscription_unmatched', fields);
      return 'unmatched';
    case 'mismatch':
      // A customer bound to one account and a checkout opened for another. Nothing is applied,
      // loudly: this is the one outcome that means something is wrong on our side.
      deps.logger.error('billing_account_mismatch', fields);
      return 'ignored';
    case 'unknown_price':
      deps.logger.error('billing_unknown_price', {
        ...fields,
        price: subscription.price?.id ?? null,
      });
      return 'ignored';
    case 'enterprise_untouched':
      deps.logger.warn('billing_enterprise_subscription', fields);
      return 'ignored';
    default:
      deps.logger.info('billing_subscription_not_applied', fields);
      return 'ignored';
  }
}

/**
 * What follows an applied subscription, on every delivery and not only on the one that moved the
 * plan (each step is idempotent, so a delivery that failed halfway is finished by the next one or
 * by the daily reconciliation):
 *
 * 1. a subscription ended after a failed payment: the invoices it left open, **first**, because
 *    it is the step the customer and the founder must hear about;
 * 2. a subscription that has ended: the overage of its last month, and any line of an earlier
 *    month still pending on the customer;
 * 3. a recorded duplicate of a subscription that has ended: applied now;
 * 4. a schedule of the dashboard whose last phase has begun: released, so that it does not stay
 *    attached for a month and keep the customer from cancelling in the portal.
 */
async function afterApplied(
  deps: Deps,
  subscription: BillingSubscription,
  customer: string,
  row: ApplyRow,
  at: number,
  readAt: number | null,
): Promise<void> {
  if (row.ended_unpaid && row.account_id !== null) {
    await closedForNonPayment(deps, customer, row);
  }
  if (subscription.status === 'canceled') await finalOverage(deps, subscription, at);
  await applyDuplicateAfterEnd(deps, subscription, row, at);
  await releaseFinishedSchedule(deps, subscription, readAt ?? Date.now());
}

/**
 * The move down of the dashboard is a schedule of two phases: the current plan to the end of the
 * period, then Pro. Once Pro has begun the schedule has nothing left to do, but while it stays
 * attached Stripe refuses to change the cancellation of the subscription, which is what the
 * portal does when the customer cancels. So it is released as soon as its last phase has begun;
 * the subscription keeps its price. Only a schedule the dashboard made (its metadata names a
 * Bookrail account), and never one that is not active.
 */
async function releaseFinishedSchedule(
  deps: Deps,
  subscription: BillingSubscription,
  now: number,
): Promise<void> {
  if (subscription.scheduleId === null || !subscription.scheduleIsBookrail) return;
  if (subscription.scheduleStatus !== null && subscription.scheduleStatus !== 'active') return;
  if (!isLiveSubscriptionStatus(subscription.status)) return;
  const starts = subscription.schedulePhases.map((phase) => phase.startDate);
  if (starts.length === 0 || starts.some((start) => start === null || start * 1000 > now)) return;
  try {
    await deps.billing.client.releaseSchedule(subscription.scheduleId);
    deps.logger.info('billing_schedule_released', {
      subscription: subscription.id,
      schedule: subscription.scheduleId,
    });
  } catch (error) {
    // Released by somebody else in between, or already completed: the reconciliation reads it
    // again tomorrow.
    deps.logger.warn('billing_schedule_release_failed', {
      subscription: subscription.id,
      schedule: subscription.scheduleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function decodeAccount(value: string | null): string | null {
  if (value === null) return null;
  return decodeId('account', value);
}

async function catalogOrNull(deps: Deps): Promise<Catalog | null> {
  try {
    return await resolveCatalog(deps.billing.client);
  } catch (error) {
    if (error instanceof CatalogIncomplete) {
      deps.logger.warn('billing_catalog_incomplete', { missing: error.missing.join(', ') });
      return null;
    }
    throw error;
  }
}

/**
 * The subscription on file has ended while a duplicate was recorded: the duplicate is read back
 * and applied now, instead of waiting up to a month for its next event (it replaces the one that
 * ended, and the account is on its plan again), and a person is told once more, because the
 * duplicate is still taking money.
 */
async function applyDuplicateAfterEnd(
  deps: Deps,
  ended: BillingSubscription,
  row: ApplyRow,
  at: number,
): Promise<void> {
  const duplicate = row.other_subscription_id;
  if (duplicate === null || row.account_id === null || ended.customer === null) return;
  deps.logger.error('billing_duplicate_after_end', {
    account_id: encodeId('account', row.account_id),
    ended: ended.id,
    duplicate,
  });
  sendLater(
    deps,
    duplicateEndedMessage(deps.billing.invoiceTo, {
      accountId: encodeId('account', row.account_id),
      accountName: row.account_name,
      customer: ended.customer,
      ended: ended.id,
      duplicate,
    }),
    'billing_duplicate_mail_failed',
  );
  await applySubscription(deps, duplicate, null, null, at);
}

/**
 * A subscription closed for a payment that never came leaves its last invoice open, and Stripe
 * no longer collects it. The open invoices of the customer are recorded (the dashboard shows
 * them, a new checkout is refused until they are paid), the owner is sent the link to pay each,
 * and whoever issues the invoices gets the list. Nothing is voided: that is a person's decision.
 */
async function closedForNonPayment(deps: Deps, customer: string, row: ApplyRow): Promise<void> {
  const open = (await deps.billing.client.listOpenInvoices(customer)).filter(
    (invoice) => invoice.amountRemaining > 0,
  );
  if (open.length === 0 || row.account_id === null) return;
  // Recorded once each: a delivery that comes back after one that failed halfway records what
  // is missing, and only what it recorded is written about.
  const recorded = await recordUnpaid(deps, customer, open);
  if (recorded.length === 0) return;
  notifyUnpaid(deps, customer, row.account_id, row.account_name, row.owner_email, recorded);
}

async function recordUnpaid(
  deps: Deps,
  customer: string,
  invoices: readonly BillingInvoiceSummary[],
): Promise<BillingInvoiceSummary[]> {
  const recorded: BillingInvoiceSummary[] = [];
  for (const invoice of invoices) {
    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<{ recorded: boolean }>(sql`
        SELECT recorded FROM billing_unpaid_invoice_record(${customer}, ${invoice.id},
                                                           ${invoice.number},
                                                           ${invoice.amountRemaining},
                                                           ${invoice.currency},
                                                           ${invoice.hostedInvoiceUrl})
      `),
    );
    if (rows[0]?.recorded === true) recorded.push(invoice);
  }
  return recorded;
}

function notifyUnpaid(
  deps: Deps,
  customer: string,
  account: string,
  accountName: string | null,
  ownerEmail: string | null,
  invoices: readonly BillingInvoiceSummary[],
): void {
  const accountId = encodeId('account', account);
  deps.logger.warn('billing_unpaid_invoices_recorded', {
    account_id: accountId,
    invoices: invoices.length,
  });
  sendLater(
    deps,
    unpaidInvoicesMessage(deps.billing.invoiceTo, { accountId, accountName, customer, invoices }),
    'billing_unpaid_notice_mail_failed',
  );
  if (ownerEmail !== null) {
    sendLater(
      deps,
      subscriptionClosedUnpaidMessage({
        to: ownerEmail,
        accountName: accountName ?? '',
        invoices: invoices.map((invoice) => ({
          number: invoice.number,
          amount: invoice.amountRemaining,
          currency: invoice.currency,
          url: invoice.hostedInvoiceUrl,
        })),
      }),
      'billing_unpaid_owner_mail_failed',
    );
  }
}

/** `checkout.session.completed` of a subscription: the account, the customer, the SdI code. */
export async function checkoutCompleted(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const session = event.object;
  if (session.mode !== 'subscription') return 'ignored';
  const subscription = idOf(session.subscription);
  if (subscription === null) return 'ignored';
  const reference = decodeAccount(asString(session.client_reference_id));
  if (asString(session.client_reference_id) !== null && reference === null) {
    deps.logger.error('billing_checkout_reference_invalid', { event_id: event.id });
    return 'ignored';
  }
  const fields = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  const sdiField = fields.map(asObject).find((field) => field?.key === SDI_FIELD_KEY);
  const sdi = asString(asObject(sdiField?.text)?.value)?.trim().slice(0, 200) ?? null;
  return applySubscription(deps, subscription, reference, sdi === '' ? null : sdi, event.created);
}

// --- Failed payments ------------------------------------------------------------------------------

function subscriptionOfInvoice(invoice: Record<string, unknown>): string | null {
  const details = asObject(asObject(invoice.parent)?.subscription_details);
  return idOf(details?.subscription) ?? idOf(invoice.subscription);
}

/**
 * `invoice.payment_failed`.
 *
 * Of a subscription: the start of the fourteen days and one message to the owner, only when
 * Stripe holds the subscription `past_due` (read back now). A failed payment that leaves the
 * subscription `active` is the invoice of a move up that waits for its payment
 * (`pending_if_incomplete`): the plan has not moved, and the dashboard said so with the link.
 *
 * Of the invoice of its own that carries the last overage of an ended subscription: recorded as
 * unpaid (the dashboard shows it, a new checkout waits for it) and told, like the invoices a
 * subscription closed for non payment leaves open. Stripe does not retry an invoice without a
 * subscription the way it retries a renewal.
 */
export async function paymentFailed(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const invoice = event.object;
  const customer = idOf(invoice.customer);
  if (customer === null) return 'ignored';
  const subscription = subscriptionOfInvoice(invoice);
  if (subscription === null) {
    const kind = asString(asObject(invoice.metadata)?.bookrail_kind);
    return kind === 'final_overage' || kind === 'final_pending'
      ? finalInvoiceUnpaid(deps, customer, invoice)
      : 'ignored';
  }
  const status = (await deps.billing.client.retrieveSubscription(subscription)).status;
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      account_id: string;
      owner_email: string | null;
      account_name: string;
      first_failure: boolean;
      grace_ends_at: string;
    }>(sql`
      SELECT account_id, owner_email, account_name, first_failure,
             grace_ends_at::text AS grace_ends_at
        FROM billing_payment_failed(${customer}, ${subscription}, ${status},
                                    ${iso(event.created)}::timestamptz)
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    deps.logger.info('billing_payment_failed_not_past_due', { subscription, status });
    return status === 'past_due' ? 'unmatched' : 'ignored';
  }
  deps.logger.info('billing_payment_failed', {
    account_id: encodeId('account', row.account_id),
    subscription,
    first_failure: row.first_failure,
  });
  if (row.first_failure && row.owner_email !== null) {
    sendLater(
      deps,
      paymentFailedMessage({
        to: row.owner_email,
        accountName: row.account_name,
        graceEndsAt: new Date(row.grace_ends_at).toISOString(),
      }),
      'billing_payment_failed_mail_failed',
    );
  }
  return 'applied';
}

async function finalInvoiceUnpaid(
  deps: Deps,
  customer: string,
  invoice: Record<string, unknown>,
): Promise<Outcome> {
  const id = asString(invoice.id);
  if (id === null) return 'ignored';
  const amountDue = asNumber(invoice.amount_due) ?? 0;
  const summary: BillingInvoiceSummary = {
    id,
    status: asString(invoice.status) ?? 'open',
    number: asString(invoice.number),
    amountDue,
    amountRemaining: asNumber(invoice.amount_remaining) ?? amountDue,
    currency: (asString(invoice.currency) ?? 'eur').toLowerCase(),
    hostedInvoiceUrl: asString(invoice.hosted_invoice_url),
    metadata: {},
  };
  if (summary.amountRemaining <= 0) return 'ignored';
  const recorded = await recordUnpaid(deps, customer, [summary]);
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ account_id: string; account_name: string }>(sql`
      SELECT account_id, account_name FROM billing_customer_account(${customer})
    `),
  );
  const account = rows[0];
  if (account === undefined) return 'unmatched';
  // The owner is written to at the address Stripe has for the customer, which is the owner's
  // (the dashboard creates the customer with it).
  if (recorded.length > 0) {
    notifyUnpaid(
      deps,
      customer,
      account.account_id,
      account.account_name,
      asString(invoice.customer_email),
      recorded,
    );
  }
  return 'applied';
}

// --- The overage of a month -------------------------------------------------------------------------

interface ContextRow {
  [column: string]: unknown;
  account_id: string;
  account_plan: string;
  /** The paid plan whose prices bill the month, or `null` when none served it. */
  plan: string | null;
  days_in_month: number;
  free_days: number;
  pro_days: number;
  scale_days: number;
  enterprise_days: number;
  bookings_confirmed: string;
  payment_volume: string;
  currency: string | null;
}

/** A claim of `billing_overages`, as `billing_overage_claim` and `billing_overage_take` answer it. */
export interface ClaimRow {
  [column: string]: unknown;
  id: string;
  claimed: boolean;
  account_id: string;
  stripe_customer_id: string | null;
  month: string;
  plan: 'pro' | 'scale';
  origin: 'renewal' | 'final';
  status: 'claimed' | 'applied' | 'nothing_due';
  placement: 'invoice' | 'next_invoice' | 'final_invoice' | null;
  stripe_invoice_id: string | null;
  attempts: number;
  leased_until: string | null;
  bookings_included: string;
  bookings_over: string;
  booking_unit_amount: number;
  bookings_amount: string;
  payment_volume: string;
  payment_volume_included: string;
  payments_per_mille: number;
  payments_amount: string;
  stripe_booking_item_id: string | null;
  stripe_payment_item_id: string | null;
}

/** The columns of a claim, in the order both functions answer them. */
const CLAIM_COLUMNS = sql.raw(`id, claimed, account_id, stripe_customer_id, month, plan, origin,
  status, placement, stripe_invoice_id, attempts, leased_until::text AS leased_until,
  bookings_included::text AS bookings_included,
  bookings_over::text AS bookings_over, booking_unit_amount, bookings_amount::text AS bookings_amount,
  payment_volume::text AS payment_volume, payment_volume_included::text AS payment_volume_included,
  payments_per_mille, payments_amount::text AS payments_amount,
  stripe_booking_item_id, stripe_payment_item_id`);

async function overageContext(
  deps: Deps,
  customer: string,
  month: string,
): Promise<ContextRow | undefined> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<ContextRow>(sql`
      SELECT account_id, account_plan, plan, days_in_month, free_days, pro_days, scale_days,
             enterprise_days, bookings_confirmed::text AS bookings_confirmed,
             payment_volume::text AS payment_volume, currency
        FROM billing_overage_context(${customer}, ${month})
    `),
  );
  return rows[0];
}

function overageOf(deps: Deps, context: ContextRow): Overage | null {
  return computeOverage(
    {
      plan: context.plan,
      daysInMonth: context.days_in_month,
      days: {
        free: context.free_days,
        pro: context.pro_days,
        scale: context.scale_days,
        enterprise: context.enterprise_days,
      },
    },
    {
      bookingsConfirmed: Number(context.bookings_confirmed),
      paymentVolume: Number(context.payment_volume),
      currency: context.currency,
    },
    plansOf(deps),
  );
}

/**
 * An `enterprise` account is billed by its contract: no overage, even when a subscription was
 * left behind, and a person is told the subscription is there.
 */
function refuseEnterprise(
  deps: Deps,
  context: ContextRow,
  customer: string,
  month: string,
): boolean {
  if (context.account_plan !== 'enterprise') return false;
  const accountId = encodeId('account', context.account_id);
  deps.logger.warn('billing_overage_enterprise_skipped', { account_id: accountId, month });
  sendLater(
    deps,
    enterpriseSubscriptionMessage(deps.billing.invoiceTo, {
      accountId,
      accountName: null,
      customer,
      month,
    }),
    'billing_enterprise_mail_failed',
  );
  return true;
}

/**
 * `invoice.created` of a renewal: the overage of the month that has just closed, claimed once
 * and added to the draft before Stripe finalizes it.
 */
export async function renewalCreated(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const invoice = event.object;
  if (invoice.billing_reason !== 'subscription_cycle') return 'ignored';
  const customer = idOf(invoice.customer);
  const invoiceId = asString(invoice.id);
  if (customer === null || invoiceId === null) return 'ignored';

  // The renewal of the first is made at midnight UTC: the month that has just closed is the one
  // of the instant before the end of the period this invoice is for.
  const periodEnd = asNumber(invoice.period_end) ?? asNumber(invoice.created) ?? event.created;
  const month = planMonthOf(periodEnd * 1000 - 1);

  const context = await overageContext(deps, customer, month);
  if (context === undefined) return 'unmatched';
  if (refuseEnterprise(deps, context, customer, month)) return 'ignored';
  const overage = overageOf(deps, context);
  if (overage === null) return 'ignored';

  const claim = await claimOverage(deps, context.account_id, month, 'renewal', invoiceId, overage);
  if (!claim.claimed) {
    await resumeIfAbandoned(deps, claim);
    return 'applied';
  }
  await processClaim(deps, claim);
  return 'applied';
}

/**
 * A claim written by an earlier caller: left alone while that caller's lease runs (another
 * delivery is working on it), taken again at once when the lease has run out (the caller failed
 * halfway, and Stripe is delivering the event again), so that the lines still reach the draft
 * before Stripe finalizes it rather than a month later.
 */
async function resumeIfAbandoned(deps: Deps, claim: ClaimRow): Promise<void> {
  const fields = {
    account_id: encodeId('account', claim.account_id),
    month: claim.month,
    status: claim.status,
  };
  const leaseOver =
    claim.leased_until === null || new Date(claim.leased_until).getTime() < Date.now();
  if (claim.status !== 'claimed' || !leaseOver) {
    deps.logger.info('billing_overage_already_claimed', fields);
    return;
  }
  const [taken] = await takeOpenClaims(deps, 1, claim.id);
  if (taken === undefined) {
    deps.logger.info('billing_overage_already_claimed', fields);
    return;
  }
  deps.logger.warn('billing_overage_resumed', { ...fields, attempts: taken.attempts });
  try {
    await processClaim(deps, taken);
  } catch (error) {
    await reportIfStuck(deps, taken, error);
    throw error;
  }
}

/** After this many attempts at a claim of overage, a person is told. */
export const STUCK_AFTER_ATTEMPTS = 5;

/**
 * A claim taken again that failed once more: on its fifth attempt, whoever takes it (the daily
 * reconciliation or a redelivery of the renewal), a person is told once, because a claim that
 * cannot close would otherwise fail every day with only a line in the log.
 */
export async function reportIfStuck(deps: Deps, claim: ClaimRow, error: unknown): Promise<void> {
  if (claim.attempts !== STUCK_AFTER_ATTEMPTS || deps.mailer === undefined) return;
  deps.logger.error('billing_overage_stuck', {
    account_id: encodeId('account', claim.account_id),
    month: claim.month,
    attempts: claim.attempts,
  });
  await deps.mailer
    .send(
      overageStuckMessage(deps.billing.invoiceTo, {
        accountId: encodeId('account', claim.account_id),
        customer: claim.stripe_customer_id,
        month: claim.month,
        origin: claim.origin,
        attempts: claim.attempts,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .catch((failure: unknown) => {
      deps.logger.warn('billing_overage_stuck_mail_failed', {
        error: failure instanceof Error ? failure.name : 'unknown',
      });
    });
}

/**
 * The last overage of a subscription that has ended: the month of its last instant, claimed
 * like a renewal and billed on an invoice of its own, since no renewal will come to carry it.
 */
async function finalOverage(
  deps: Deps,
  subscription: BillingSubscription,
  at: number,
): Promise<void> {
  const customer = subscription.customer;
  if (customer === null) return;
  const endedAt = subscription.endedAt ?? at;
  const month = planMonthOf(endedAt * 1000 - 1);
  const context = await overageContext(deps, customer, month);
  if (context === undefined) return;
  if (!refuseEnterprise(deps, context, customer, month)) {
    const overage = overageOf(deps, context);
    if (overage !== null) {
      const claim = await claimOverage(deps, context.account_id, month, 'final', null, overage);
      if (!claim.claimed) await resumeIfAbandoned(deps, claim);
      else {
        await processClaim(deps, claim, {
          defaultPaymentMethod: subscription.defaultPaymentMethod,
        });
      }
    }
  }
  await invoiceOrphanLines(deps, subscription, customer, context.account_id);
}

/**
 * Lines of an earlier month left pending on the customer (a renewal draft that was no longer a
 * draft, or a claim the reconciliation made for a lost `invoice.created`) wait for the next
 * invoice of the subscription, and an ended subscription has none: Stripe keeps them pending for
 * ever. So when a subscription ends and Bookrail lines are still pending after the last month
 * was handled (a last month with nothing due makes no invoice of its own), they get an invoice of
 * their own, once per subscription.
 */
async function invoiceOrphanLines(
  deps: Deps,
  subscription: BillingSubscription,
  customer: string,
  account: string,
): Promise<void> {
  const orphans = (await deps.billing.client.listPendingInvoiceItems(customer)).filter(
    (item) => item.metadata.bookrail_month !== undefined,
  );
  if (orphans.length === 0) return;
  const months = [...new Set(orphans.map((item) => item.metadata.bookrail_month ?? ''))].sort();
  const invoice = await deps.billing.client.createInvoice(
    {
      customer,
      collection_method: 'charge_automatically',
      auto_advance: true,
      automatic_tax: { enabled: true },
      pending_invoice_items_behavior: 'include',
      ...(subscription.defaultPaymentMethod === null
        ? {}
        : { default_payment_method: subscription.defaultPaymentMethod }),
      description: `Bookrail: the usage beyond the plan of ${months.map(monthName).join(', ')}, billed when the subscription ended.`,
      metadata: {
        bookrail_account_id: encodeId('account', account),
        bookrail_subscription: subscription.id,
        bookrail_kind: 'final_pending',
      },
    },
    `bookrail-final-pending-${subscription.id}`,
  );
  deps.logger.warn('billing_orphan_lines_invoiced', {
    account_id: encodeId('account', account),
    subscription: subscription.id,
    invoice: invoice.id,
    lines: orphans.length,
  });
}

/**
 * The overage of a closed month whose renewal never brought its `invoice.created` (the receiver
 * was down for longer than Stripe retries): claimed by the daily reconciliation from the second
 * of the month, as pending items that Stripe puts on the next invoice. The same UNIQUE as every
 * claim: a month that the renewal claimed is left alone, and one claimed here is never billed
 * again by a renewal that arrives late.
 */
export async function claimMissedRenewal(
  deps: Deps,
  customer: string,
  month: string,
): Promise<'claimed' | 'already' | 'nothing'> {
  const context = await overageContext(deps, customer, month);
  if (context === undefined || context.account_plan === 'enterprise') return 'nothing';
  const overage = overageOf(deps, context);
  if (overage === null) return 'nothing';
  const claim = await claimOverage(deps, context.account_id, month, 'renewal', null, overage);
  if (!claim.claimed) return 'already';
  deps.logger.warn('billing_overage_missed_renewal', {
    account_id: encodeId('account', context.account_id),
    month,
  });
  await processClaim(deps, claim);
  return 'claimed';
}

async function claimOverage(
  deps: Deps,
  accountId: string,
  month: string,
  origin: 'renewal' | 'final',
  invoiceId: string | null,
  overage: Overage,
): Promise<ClaimRow> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<ClaimRow>(sql`
      SELECT ${CLAIM_COLUMNS}
        FROM billing_overage_claim(
          ${accountId}::uuid, ${month}, ${overage.plan}, ${origin}, ${invoiceId},
          ${overage.bookingsConfirmed}, ${overage.bookingsIncluded}, ${overage.bookingUnitAmount},
          ${overage.paymentVolume}, ${overage.paymentVolumeIncluded}, ${overage.paymentsPerMille},
          ${overage.volumeCurrency}
        )
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('billing_overage_claim answered no row.');
  return row;
}

/** The claims left open whose lease has run out, each leased again: the reconciliation's. */
export async function takeOpenClaims(
  deps: Deps,
  limit = 50,
  id: string | null = null,
): Promise<ClaimRow[]> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<ClaimRow>(
      sql`SELECT ${CLAIM_COLUMNS} FROM billing_overage_take(${limit}, ${id}::uuid)`,
    ),
  );
  return rows;
}

function claimedOverage(claim: ClaimRow): ClaimedOverage {
  return {
    plan: claim.plan,
    bookingsIncluded: Number(claim.bookings_included),
    bookingsOver: Number(claim.bookings_over),
    bookingUnitAmount: claim.booking_unit_amount,
    bookingsAmount: Number(claim.bookings_amount),
    paymentVolume: Number(claim.payment_volume),
    paymentVolumeIncluded: Number(claim.payment_volume_included),
    paymentsPerMille: claim.payments_per_mille,
    paymentsAmount: Number(claim.payments_amount),
  };
}

function isIdempotencyError(error: unknown): boolean {
  return error instanceof StripeApiError && error.type === 'idempotency_error';
}

/**
 * Is the invoice still a draft that can take a line? Asked of Stripe after a refusal, so that
 * the placement of a line is decided by what the invoice is, never by the words of an error.
 */
async function invoiceIsDraft(deps: Deps, invoiceId: string): Promise<boolean> {
  try {
    return (await deps.billing.client.retrieveInvoice(invoiceId)).status === 'draft';
  } catch (error) {
    // A draft that was deleted no longer exists: its lines go on the next invoice.
    if (error instanceof StripeApiError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Writes the lines of a claim at Stripe and closes it: on the draft of the renewal, as pending
 * items when that draft is gone, or as pending items and an invoice of their own for the last
 * overage of a subscription that has ended. Every line has an `Idempotency-Key` of the account,
 * the month and the line, and is recorded as soon as it exists, so finishing a claim left open
 * adds only what is missing.
 */
export async function processClaim(
  deps: Deps,
  claim: ClaimRow,
  options: { defaultPaymentMethod?: string | null } = {},
): Promise<void> {
  if (claim.status !== 'claimed') return;
  const customer = claim.stripe_customer_id;
  const accountId = encodeId('account', claim.account_id);
  const fields = { account_id: accountId, month: claim.month, origin: claim.origin };
  if (customer === null) {
    deps.logger.error('billing_overage_without_customer', fields);
    return;
  }

  // A last month whose invoice already exists (created, and the process died before recording
  // it): recorded, and nothing is created again.
  if (claim.origin === 'final') {
    const existing = (await deps.billing.client.listInvoices(customer)).find(
      (invoice) =>
        invoice.metadata.bookrail_kind === 'final_overage' &&
        invoice.metadata.bookrail_month === claim.month,
    );
    if (existing !== undefined) {
      await settleOverage(deps, claim.id, 'final_invoice', existing.id, {
        bookings: null,
        payments: null,
        done: true,
      });
      deps.logger.warn('billing_overage_found_at_stripe', { ...fields, invoice: existing.id });
      return;
    }
  }

  let placement: 'invoice' | 'next_invoice' | 'final_invoice' =
    claim.origin === 'final'
      ? 'final_invoice'
      : claim.placement === 'next_invoice' || claim.stripe_invoice_id === null
        ? 'next_invoice'
        : 'invoice';
  const items: { bookings: string | null; payments: string | null } = {
    bookings: claim.stripe_booking_item_id,
    payments: claim.stripe_payment_item_id,
  };
  const lines = overageLines({
    overage: claimedOverage(claim),
    month: claim.month,
    accountId: claim.account_id,
    customer,
    invoice: null,
  });

  for (const line of lines) {
    if (items[line.kind] !== null) continue;
    let created: { id: string } | null = null;
    // A claim taken again (a caller failed halfway): Stripe keeps the answer of a request under
    // its key, a `500` included, so the retry uses keys of its own, and looks first for the line
    // the failed attempt may have made anyway.
    if (claim.attempts > 0) {
      const found = await existingLine(deps, claim, line.kind, customer);
      if (found !== null) {
        deps.logger.warn('billing_overage_found_at_stripe', {
          ...fields,
          kind: line.kind,
          item: found,
        });
        created = { id: found };
      }
    }
    if (created === null && placement === 'invoice' && claim.stripe_invoice_id !== null) {
      try {
        created = await deps.billing.client.createInvoiceItem(
          { ...line.form, invoice: claim.stripe_invoice_id },
          overageIdempotencyKey(
            claim.account_id,
            claim.month,
            line.kind,
            'invoice',
            claim.attempts,
          ),
        );
      } catch (error) {
        if (isIdempotencyError(error)) {
          deps.logger.error('billing_overage_idempotency_error', { ...fields, kind: line.kind });
          throw error;
        }
        if (!(error instanceof StripeApiError)) throw error;
        if (await invoiceIsDraft(deps, claim.stripe_invoice_id)) throw error;
        placement = 'next_invoice';
        deps.logger.warn('billing_overage_on_next_invoice', {
          ...fields,
          kind: line.kind,
          invoice: claim.stripe_invoice_id,
        });
      }
    }
    if (created === null) {
      // Before a pending item: is the line at Stripe already? On the draft (created by an
      // earlier attempt whose answer was lost, and the draft finalized since), or among the
      // pending items of the customer. Found by its metadata, it is recorded, not created twice.
      const found = await existingLine(deps, claim, line.kind, customer);
      if (found !== null) {
        deps.logger.warn('billing_overage_found_at_stripe', {
          ...fields,
          kind: line.kind,
          item: found,
        });
        created = { id: found };
      } else {
        created = await deps.billing.client.createInvoiceItem(
          line.form,
          overageIdempotencyKey(
            claim.account_id,
            claim.month,
            line.kind,
            'pending',
            claim.attempts,
          ),
        );
      }
    }
    items[line.kind] = created.id;
    await settleOverage(deps, claim.id, placement, null, {
      bookings: line.kind === 'bookings' ? created.id : null,
      payments: line.kind === 'payments' ? created.id : null,
      done: false,
    });
  }

  let invoiceId: string | null = null;
  if (claim.origin === 'final' && lines.length > 0) {
    const invoice = await deps.billing.client.createInvoice(
      {
        customer,
        collection_method: 'charge_automatically',
        auto_advance: true,
        automatic_tax: { enabled: true },
        pending_invoice_items_behavior: 'include',
        ...(options.defaultPaymentMethod === null || options.defaultPaymentMethod === undefined
          ? {}
          : { default_payment_method: options.defaultPaymentMethod }),
        description: `Bookrail: the usage of ${monthName(claim.month)} beyond the plan, billed when the subscription ended.`,
        metadata: {
          bookrail_account_id: accountId,
          bookrail_month: claim.month,
          bookrail_kind: 'final_overage',
        },
      },
      finalInvoiceIdempotencyKey(claim.account_id, claim.month, claim.attempts),
    );
    invoiceId = invoice.id;
  }
  await settleOverage(deps, claim.id, placement, invoiceId, {
    bookings: null,
    payments: null,
    done: true,
  });
  deps.logger.info('billing_overage_applied', {
    ...fields,
    placement,
    bookings_amount: Number(claim.bookings_amount),
    payments_amount: Number(claim.payments_amount),
    ...(invoiceId === null ? {} : { invoice: invoiceId }),
  });
}

/**
 * The id of a line of this claim that is already at Stripe, or `null`: on the invoice the claim
 * meant it for, or among the pending items of the customer, by `bookrail_month` and
 * `bookrail_kind`. It closes the gap the idempotency key cannot: a key forgotten after 24 hours,
 * or an error Stripe stored under the key while the object was made anyway.
 */
async function existingLine(
  deps: Deps,
  claim: ClaimRow,
  kind: 'bookings' | 'payments',
  customer: string,
): Promise<string | null> {
  const ours = (metadata: Readonly<Record<string, string>>): boolean =>
    metadata.bookrail_month === claim.month && metadata.bookrail_kind === kind;
  if (claim.stripe_invoice_id !== null) {
    try {
      const line = (await deps.billing.client.listInvoiceLines(claim.stripe_invoice_id)).find(
        (candidate) => ours(candidate.metadata),
      );
      if (line !== undefined) return line.invoiceItem ?? line.id;
    } catch (error) {
      if (!(error instanceof StripeApiError && error.status === 404)) throw error;
    }
  }
  const pending = (await deps.billing.client.listPendingInvoiceItems(customer)).find((item) =>
    ours(item.metadata),
  );
  return pending?.id ?? null;
}

async function settleOverage(
  deps: Deps,
  id: string,
  placement: 'invoice' | 'next_invoice' | 'final_invoice',
  invoiceId: string | null,
  step: { bookings: string | null; payments: string | null; done: boolean },
): Promise<void> {
  await withAuthContext(deps.db, (tx) =>
    tx.execute(sql`
      SELECT billing_overage_settle(${id}::uuid, ${placement}, ${invoiceId}, ${step.bookings},
                                    ${step.payments}, ${step.done})
    `),
  );
}

// --- The fiscal data of a customer ---------------------------------------------------------------

/** How long after a subscription begins its checkout is still writing the customer's data. */
const CHECKOUT_SETTLING_MS = 10 * 60 * 1000;

function countryOf(value: unknown): string | null {
  return asString(asObject(value)?.country)?.toUpperCase() ?? null;
}

/**
 * `customer.updated` and `customer.tax_id.*`: a customer with a live subscription whose fiscal
 * data changed is reported to whoever issues the invoices. For information: Stripe Tax computes
 * the tax of the next invoice from the new address and VAT number by itself; what the person
 * checks is the electronic invoice they issue.
 *
 * Not reported, because they are not changes: what the checkout itself writes (the address and
 * the name with `customer_update`, the VAT number with `tax_id_collection`), in the ten minutes
 * after the subscription began; and an update of the address that keeps its country (a new
 * postcode changes no tax). The portal does not let a customer change either (they write to
 * Bookrail), so this is the net for a change made another way.
 */
export async function customerChanged(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const isTaxId = event.type.startsWith('customer.tax_id.');
  const customer = isTaxId ? idOf(event.object.customer) : asString(event.object.id);
  if (customer === null) return 'ignored';
  let what: string[];
  if (isTaxId) {
    // An update of a tax id is, in practice, its verification by Stripe (the value of a tax id
    // does not change: a new number is a new tax id). The number is the same, so no notice; the
    // email of each invoice already says when VIES did not verify it.
    const previous = event.previousAttributes ?? {};
    if (
      event.type === 'customer.tax_id.updated' &&
      !['value', 'type', 'country'].some((key) => Object.hasOwn(previous, key))
    ) {
      return 'ignored';
    }
    what = [`partita IVA ${event.type.slice('customer.tax_id.'.length)}`];
  } else {
    const previous = event.previousAttributes ?? null;
    if (previous === null) return 'ignored';
    what = [];
    if (Object.hasOwn(previous, 'address')) {
      const before = countryOf(previous.address);
      const now = countryOf(event.object.address);
      // An address filled for the first time, or moved within the same country, is no change
      // of tax.
      if (before !== null && before !== now) what.push(`paese ${before} -> ${now ?? '(nessuno)'}`);
    }
    if (Object.hasOwn(previous, 'tax_exempt')) what.push('esenzione');
    if (what.length === 0) return 'ignored';
  }
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      account_id: string;
      account_name: string;
      stripe_subscription_id: string | null;
      subscription_live: boolean | null;
      subscription_created_at: string | null;
    }>(sql`
      SELECT account_id, account_name, stripe_subscription_id, subscription_live,
             subscription_created_at::text AS subscription_created_at
        FROM billing_customer_account(${customer})
    `),
  );
  const row = rows[0];
  if (row === undefined) return 'unmatched';
  if (row.subscription_live !== true) return 'ignored';
  const began =
    row.subscription_created_at === null ? null : new Date(row.subscription_created_at).getTime();
  if (began !== null && event.created * 1000 - began < CHECKOUT_SETTLING_MS) {
    deps.logger.info('billing_fiscal_change_from_checkout', { event_type: event.type });
    return 'ignored';
  }
  const accountId = encodeId('account', row.account_id);
  deps.logger.warn('billing_fiscal_data_changed', {
    account_id: accountId,
    subscription: row.stripe_subscription_id,
    event_type: event.type,
  });
  sendLater(
    deps,
    fiscalDataChangedMessage(deps.billing.invoiceTo, {
      accountId,
      accountName: row.account_name,
      customer,
      subscription: row.stripe_subscription_id,
      what,
    }),
    'billing_fiscal_notice_mail_failed',
  );
  return 'applied';
}

// --- Schedules and unpaid invoices ---------------------------------------------------------------

/**
 * `subscription_schedule.*`: a move down scheduled, released, completed or cancelled. The
 * subscription of the schedule is read back and applied, which is where `scheduled_plan` comes
 * from.
 */
export async function scheduleChanged(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const scheduleId = asString(event.object.id);
  // A released schedule no longer has a `subscription`: the one it managed is in
  // `released_subscription`.
  let subscription = idOf(event.object.subscription) ?? idOf(event.object.released_subscription);
  if (subscription === null && scheduleId !== null) {
    subscription = await deps.billing.client.retrieveScheduleSubscription(scheduleId);
  }
  if (subscription === null) return 'ignored';
  return applySubscription(deps, subscription, null, null, event.created);
}

/** `invoice.voided` and `invoice.marked_uncollectible`: an unpaid invoice is no longer due. */
export async function invoiceNoLongerDue(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const invoiceId = asString(event.object.id);
  if (invoiceId === null) return 'ignored';
  return (await settleUnpaid(deps, invoiceId)) ? 'applied' : 'ignored';
}

async function settleUnpaid(deps: Deps, invoiceId: string): Promise<boolean> {
  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{ billing_unpaid_invoice_settle: number }>(
      sql`SELECT billing_unpaid_invoice_settle(${invoiceId})`,
    ),
  );
  return (rows[0]?.billing_unpaid_invoice_settle ?? 0) > 0;
}

// --- Paid invoices ------------------------------------------------------------------------------

function addressOf(value: unknown): Record<string, string | null> {
  const object = asObject(value) ?? {};
  const out: Record<string, string | null> = {};
  for (const key of ['line1', 'line2', 'postal_code', 'city', 'state', 'country']) {
    out[key] = asString(object[key]);
  }
  return out;
}

const TREATMENT_NAME: Readonly<Record<VatTreatment, string>> = {
  it_vat: 'IVA italiana',
  eu_reverse_charge: 'reverse charge UE',
  outside_eu: 'nessuna imposta (extra UE)',
};

/** The reasons Stripe Tax gives for a tax it did not charge, which ask for a second look. */
const REASONS_TO_CHECK = new Set(['not_collecting', 'not_supported', 'customer_exempt']);

/**
 * The treatment of the VAT of an invoice, from the taxes Stripe Tax **computed** on it: reverse
 * charge when a tax entry says `reverse_charge`, Italian VAT when there is tax, nothing
 * otherwise. And a warning when that disagrees with the country of the address (an EU business
 * charged no reverse charge is usually a VAT number Stripe did not have), or when Stripe gave a
 * reason that asks for a second look (`not_collecting`: no registration where the customer is).
 */
export function appliedVatTreatment(
  lines: readonly BillingInvoiceLine[],
  totalTaxes: readonly { amount: number; reason: string | null }[],
  country: string | null,
): { treatment: VatTreatment; warning: string | null; reasons: string[] } {
  const reasons = [
    ...new Set([
      ...lines.flatMap((line) => line.taxabilityReasons),
      ...totalTaxes.map((tax) => tax.reason).filter((r): r is string => r !== null),
    ]),
  ].sort();
  const taxed =
    totalTaxes.some((tax) => tax.amount > 0) || lines.some((line) => line.taxAmount > 0);
  const treatment: VatTreatment = reasons.includes('reverse_charge')
    ? 'eu_reverse_charge'
    : taxed
      ? 'it_vat'
      : 'outside_eu';
  const byCountry = vatTreatmentOf(country);
  const warnings: string[] = [];
  if (treatment !== byCountry) {
    warnings.push(
      `il paese dell'indirizzo (${country ?? 'non fornito'}) vorrebbe ${TREATMENT_NAME[byCountry]}, ma Stripe Tax ha applicato ${TREATMENT_NAME[treatment]}. Verificare prima di emettere la fattura.`,
    );
  }
  // Outside the Union `not_collecting` is the expected answer: Bookrail is registered in Italy.
  const toCheck =
    byCountry === 'outside_eu' ? [] : reasons.filter((reason) => REASONS_TO_CHECK.has(reason));
  if (toCheck.length > 0) {
    warnings.push(`Stripe Tax ha indicato il motivo ${toCheck.join(', ')}: verificare.`);
  }
  // One invoice, two regimes: some lines in reverse charge and some taxed. The electronic invoice
  // has one regime, so a person looks before issuing it.
  const reverseLines = lines.filter((line) => line.taxabilityReasons.includes('reverse_charge'));
  const taxedLines = lines.filter((line) => line.taxAmount !== 0);
  if (reverseLines.length > 0 && taxedLines.length > 0) {
    warnings.push(
      'la fattura ha righe con regimi diversi (alcune in reverse charge, altre con IVA addebitata): verificare riga per riga.',
    );
  }
  return {
    treatment,
    warning: warnings.length === 0 ? null : warnings.join(' Inoltre '),
    reasons,
  };
}

/**
 * `invoice.paid` with an amount: the row of the electronic invoice to issue, and its message.
 *
 * The tax ids are read from the customer rather than from the invoice, because only the customer
 * carries Stripe's verification of each one (VIES, for a number of the Union).
 */
export async function invoicePaid(deps: Deps, event: BillingEvent): Promise<Outcome> {
  const invoice = event.object;
  const invoiceId = asString(invoice.id);
  const customer = idOf(invoice.customer);
  const total = asNumber(invoice.total) ?? 0;
  const paid = asNumber(invoice.amount_paid) ?? total;
  if (invoiceId === null || customer === null) return 'ignored';
  // An invoice left unpaid by a closed subscription, paid at last: no longer shown as due.
  if (await settleUnpaid(deps, invoiceId)) {
    deps.logger.info('billing_unpaid_invoice_paid', { invoice: invoiceId });
  }
  if (total <= 0 || paid <= 0) return 'ignored';

  const inline = invoiceLinesOf(invoice.lines);
  const lines = await withTaxRatePercentages(
    deps,
    inline.hasMore ? await deps.billing.client.listInvoiceLines(invoiceId) : inline.lines,
  );
  const taxIds = await deps.billing.client.listCustomerTaxIds(customer);

  const address = addressOf(invoice.customer_address);
  const country = address.country?.toUpperCase() ?? null;
  const totalTaxesRaw = Array.isArray(invoice.total_taxes)
    ? invoice.total_taxes.map(asObject).filter((t): t is Record<string, unknown> => t !== null)
    : [];
  const { treatment, warning, reasons } = appliedVatTreatment(
    lines,
    totalTaxesRaw.map((t) => ({
      amount: asNumber(t.amount) ?? 0,
      reason: asString(t.taxability_reason),
    })),
    country,
  );
  const invoiceTaxIds = Array.isArray(invoice.customer_tax_ids)
    ? invoice.customer_tax_ids.map(asObject)
    : [];
  const fromInvoice = invoiceTaxIds.find((taxId) => taxId !== null) ?? null;
  const fromCustomer =
    taxIds.find((taxId) => taxId.value !== null && taxId.value === asString(fromInvoice?.value)) ??
    taxIds[0] ??
    null;
  const paidAt = asNumber(asObject(invoice.status_transitions)?.paid_at) ?? event.created;
  const tax = totalTaxesRaw.reduce((sum, item) => sum + (asNumber(item.amount) ?? 0), 0);
  const subtotal =
    asNumber(invoice.total_excluding_tax) ?? asNumber(invoice.subtotal) ?? total - tax;
  const currency = asString(invoice.currency)?.toLowerCase() ?? 'eur';

  const data: InvoiceData = {
    stripeInvoiceId: invoiceId,
    number: asString(invoice.number),
    hostedInvoiceUrl: asString(invoice.hosted_invoice_url),
    paidAt: iso(paidAt),
    currency,
    accountId: null,
    customerName: asString(invoice.customer_name),
    customerEmail: asString(invoice.customer_email),
    taxIdType: fromCustomer?.type ?? asString(fromInvoice?.type),
    taxIdValue: fromCustomer?.value ?? asString(fromInvoice?.value),
    taxIdVerification: fromCustomer?.verification ?? null,
    country,
    address,
    sdiOrPec: null,
    vatTreatment: treatment,
    vatWarning: warning,
    taxabilityReasons: reasons,
    lines: lines.map((line) => ({
      description: line.description,
      amount: line.amount,
      taxAmount: line.taxAmount,
      taxRatePercent: line.taxPercent,
      taxabilityReason: line.taxabilityReasons[0] ?? null,
      periodStart: line.periodStart === null ? null : iso(line.periodStart),
      periodEnd: line.periodEnd === null ? null : iso(line.periodEnd),
    })),
    subtotal,
    tax,
    total,
  };

  const { rows } = await withAuthContext(deps.db, (tx) =>
    tx.execute<{
      id: string;
      recorded: boolean;
      account_id: string | null;
      sdi_or_pec: string | null;
      mailed: boolean;
    }>(sql`
      SELECT id, recorded, account_id, sdi_or_pec, mailed FROM billing_invoice_record(
        ${data.stripeInvoiceId}, ${customer}, ${data.number}, ${data.hostedInvoiceUrl},
        ${data.paidAt}::timestamptz, ${data.currency}, ${data.customerName}, ${data.customerEmail},
        ${data.taxIdType}, ${data.taxIdValue}, ${data.taxIdVerification}, ${data.country},
        ${JSON.stringify(data.address)}::jsonb, ${data.vatTreatment},
        ${JSON.stringify(data.lines)}::jsonb, ${data.subtotal}, ${data.tax}, ${data.total}
      )
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('billing_invoice_record answered no row.');
  if (row.mailed) return 'applied';

  // The first invoice of a subscription can be paid, and its event delivered, before the
  // `checkout.session.completed` that brings the SdI code or PEC: Stripe does not keep the order.
  // The code is then read from the Checkout Session of the subscription itself.
  let sdiOrPec = row.sdi_or_pec;
  const subscriptionId = subscriptionOfInvoice(invoice);
  if (sdiOrPec === null && subscriptionId !== null) {
    const typed = await deps.billing.client.checkoutCustomField(subscriptionId, SDI_FIELD_KEY);
    if (typed !== null) {
      const { rows: recorded } = await withAuthContext(deps.db, (tx) =>
        tx.execute<{ billing_invoice_sdi: string | null }>(
          sql`SELECT billing_invoice_sdi(${invoiceId}, ${typed})`,
        ),
      );
      sdiOrPec = recorded[0]?.billing_invoice_sdi ?? typed;
      deps.logger.info('billing_invoice_sdi_from_checkout', { invoice: invoiceId });
    }
  }

  const message = invoiceDataMessage(deps.billing.invoiceTo, {
    ...data,
    accountId: row.account_id === null ? null : encodeId('account', row.account_id),
    sdiOrPec,
  });
  deps.logger.info('billing_invoice_recorded', {
    invoice: invoiceId,
    account_id: row.account_id === null ? null : encodeId('account', row.account_id),
    total,
    vat_treatment: treatment,
    vat_warning: warning !== null,
  });
  // After the commit, and not awaited by Stripe: a mail server that is down must not make Stripe
  // deliver the event again. The row stays unmailed and the monthly list carries it anyway.
  const mailer = deps.mailer;
  if (mailer === undefined) {
    deps.logger.warn('billing_invoice_not_mailed', { invoice: invoiceId, reason: 'no_mailer' });
    return 'applied';
  }
  void mailer
    .send(message)
    .then(() =>
      withAuthContext(deps.db, (tx) =>
        tx.execute(sql`SELECT billing_invoice_mailed(${row.id}::uuid)`),
      ),
    )
    .catch((error: unknown) => {
      deps.logger.warn('billing_invoice_mail_failed', {
        invoice: invoiceId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  return 'applied';
}

/**
 * The percentage of each line, read from its Tax Rates (`taxes[].tax_rate_details.tax_rate`,
 * which Stripe gives as an id) and never divided out of the amounts: a tax of 1.20 on 5.45 is
 * 22 %, not 22.02 %. A line with several rates has their sum. A line whose rates could not be
 * named keeps the division, as a fallback.
 */
async function withTaxRatePercentages(
  deps: Deps,
  lines: readonly BillingInvoiceLine[],
): Promise<BillingInvoiceLine[]> {
  const percentages = new Map<string, number | null>();
  for (const id of new Set(lines.flatMap((line) => line.taxRateIds))) {
    percentages.set(id, await deps.billing.client.taxRatePercentage(id));
  }
  return lines.map((line) => {
    if (line.taxRateIds.length === 0) return line;
    const known = line.taxRateIds.map((id) => percentages.get(id) ?? null);
    if (known.some((value) => value === null)) return line;
    const sum = known.reduce<number>((total, value) => total + (value ?? 0), 0);
    return { ...line, taxPercent: Math.round(sum * 10_000) / 10_000 };
  });
}

/** A message sent after the commit, not awaited, and a `warn` line when it fails. */
function sendLater(
  deps: { mailer: AppDeps['mailer']; logger: Logger },
  message: Parameters<NonNullable<AppDeps['mailer']>['send']>[0],
  failure: string,
): void {
  const mailer = deps.mailer;
  if (mailer === undefined) return;
  mailer.send(message).catch((error: unknown) => {
    deps.logger.warn(failure, { error: error instanceof Error ? error.name : 'unknown' });
  });
}
