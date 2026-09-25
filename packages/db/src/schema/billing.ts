import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The tables of Stripe Billing and of the acceptance of the terms (migrations 0027 and 0028).
 *
 * Declared here because the schema of this package describes the whole database, but **nothing
 * in the application reads or writes them through Drizzle**, and nothing can: row security is
 * enabled and forced on all five and there is no policy and no grant. The only way in is the
 * `SECURITY DEFINER` functions of migration 0027, which the API calls by name.
 *
 * They belong to an account and not to a project. Billing is Bookrail acting as a **seller** on
 * its own Stripe account; none of these tables has anything to do with the connected accounts
 * of customers, which are in `payment_provider_connections`.
 */

/** The subscription that decides the plan of an account. One per account. */
export const billingSubscriptions = pgTable('billing_subscriptions', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull().unique(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  plan: text('plan').notNull().$type<'pro' | 'scale'>(),
  status: text('status').notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  scheduledPlan: text('scheduled_plan').$type<'pro' | 'scale'>(),
  /** The first failed payment of the current period. The worker cancels after fourteen days. */
  pastDueSince: timestamp('past_due_since', { withTimezone: true }),
  /** The plan before `plan`, and since when `plan` applies: which plan served a closed month. */
  previousPlan: text('previous_plan').notNull().default('free'),
  planSince: timestamp('plan_since', { withTimezone: true }).notNull().defaultNow(),
  sdiOrPec: text('sdi_or_pec'),
  /** A second live subscription of the account, reported and never applied. */
  duplicateSubscriptionId: text('duplicate_subscription_id'),
  /** The instant of the reading of Stripe last applied; an older reading is refused (0028). */
  lastReadAt: timestamp('last_read_at', { withTimezone: true }),
  /** When the owner was told of the failed payment of the current period (0028). */
  pastDueNotifiedAt: timestamp('past_due_notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The history of the plan of an account (migration 0028): one row per change, at the instant it
 * took effect, written by the one writer of `plan.changed`. The overage of a month reads it to
 * know which plan served which day.
 */
export const billingPlanHistory = pgTable(
  'billing_plan_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid('account_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    planFrom: text('plan_from').notNull(),
    planTo: text('plan_to').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('billing_plan_history_account_at_idx').on(t.accountId, t.at, t.id)],
);

/** The idempotency of the Billing receiver: one row per Stripe event. */
export const billingEvents = pgTable('billing_events', {
  id: uuid('id').primaryKey(),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  type: text('type').notNull(),
  livemode: boolean('livemode').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  outcome: text('outcome').$type<'applied' | 'ignored' | 'unmatched'>(),
});

/** The overage of one account and one closed month, claimed once before Stripe is called. */
export const billingOverages = pgTable(
  'billing_overages',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    month: text('month').notNull(),
    plan: text('plan').notNull().$type<'pro' | 'scale'>(),
    origin: text('origin').notNull().default('renewal').$type<'renewal' | 'final'>(),
    stripeInvoiceId: text('stripe_invoice_id'),
    bookingsConfirmed: bigint('bookings_confirmed', { mode: 'number' }).notNull(),
    bookingsIncluded: bigint('bookings_included', { mode: 'number' }).notNull(),
    bookingsOver: bigint('bookings_over', { mode: 'number' }).notNull(),
    bookingUnitAmount: integer('booking_unit_amount').notNull(),
    bookingsAmount: bigint('bookings_amount', { mode: 'number' }).notNull(),
    paymentVolume: bigint('payment_volume', { mode: 'number' }).notNull(),
    /** The volume the month includes, pro rata by the days on the free plan (0028). */
    paymentVolumeIncluded: bigint('payment_volume_included', { mode: 'number' })
      .notNull()
      .default(0),
    paymentsPerMille: integer('payments_per_mille').notNull(),
    paymentsAmount: bigint('payments_amount', { mode: 'number' }).notNull(),
    volumeCurrency: text('volume_currency'),
    status: text('status').notNull().$type<'claimed' | 'applied' | 'nothing_due'>(),
    placement: text('placement').$type<'invoice' | 'next_invoice' | 'final_invoice'>(),
    stripeBookingItemId: text('stripe_booking_item_id'),
    stripePaymentItemId: text('stripe_payment_item_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Until when the caller working on the claim has it; past it, the reconciliation takes it. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    /** Times the claim was taken again; after five a person is told. */
    attempts: integer('attempts').notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    unique('billing_overages_account_id_month_key').on(t.accountId, t.month),
    index('billing_overages_open_idx').on(t.leasedUntil),
  ],
);

/** One paid invoice, with what the Italian electronic invoice needs. Outlives the account. */
export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    stripeInvoiceId: text('stripe_invoice_id').notNull().unique(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    number: text('number'),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    currency: text('currency').notNull(),
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    taxIdType: text('tax_id_type'),
    taxIdValue: text('tax_id_value'),
    taxIdVerification: text('tax_id_verification'),
    country: text('country'),
    address: jsonb('address').notNull().default({}),
    sdiOrPec: text('sdi_or_pec'),
    vatTreatment: text('vat_treatment')
      .notNull()
      .$type<'it_vat' | 'eu_reverse_charge' | 'outside_eu'>(),
    lines: jsonb('lines').notNull(),
    subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
    tax: bigint('tax', { mode: 'number' }).notNull(),
    total: bigint('total', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    mailedAt: timestamp('mailed_at', { withTimezone: true }),
  },
  (t) => [index('billing_invoices_paid_at_idx').on(t.paidAt)],
);

/** An invoice left open by a subscription closed for non payment, until it is paid. */
export const billingUnpaidInvoices = pgTable(
  'billing_unpaid_invoices',
  {
    stripeInvoiceId: text('stripe_invoice_id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    number: text('number'),
    amountDue: bigint('amount_due', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [index('billing_unpaid_invoices_open_idx').on(t.accountId)],
);

/**
 * One acceptance of the terms and of the DPA: both ticks, the versions, where and when. It
 * outlives the account, with a copy of its identifier and of the owner's address.
 */
export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    accountRef: uuid('account_ref').notNull(),
    ownerEmail: text('owner_email'),
    termsVersion: text('terms_version').notNull(),
    dpaVersion: text('dpa_version').notNull(),
    termsAccepted: boolean('terms_accepted').notNull(),
    clausesApproved: boolean('clauses_approved').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    ipHash: text('ip_hash'),
    channel: text('channel').notNull().$type<'web' | 'cli' | 'dashboard'>(),
  },
  (t) => [index('terms_acceptances_account_idx').on(t.accountId, t.acceptedAt.desc())],
);
