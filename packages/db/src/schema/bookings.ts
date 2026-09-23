import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { boolean } from 'drizzle-orm/pg-core';
import { projectScopeColumns, timestampColumns, tstzrange } from './columns.js';

export const recurrences = pgTable(
  'recurrences',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    serviceId: uuid('service_id'),
    customerId: uuid('customer_id'),
    rrule: text('rrule').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    until: timestamp('until', { withTimezone: true }),
    count: integer('count'),
    exceptions: jsonb('exceptions').notNull().default([]),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('recurrences_scope_idx').on(t.projectId, t.environment)],
);

export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status')
      .notNull()
      .default('active')
      .$type<'active' | 'converted' | 'expired' | 'released'>(),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('holds_scope_idx').on(t.projectId, t.environment)],
);

export type BookingStatus =
  | 'held'
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'rescheduled';

/**
 * The automatic transitions the background scheduler can fire on its own, with no request behind
 * them.
 *
 * `start` is not `check_in`: a booking that starts because the policy says so has not been
 * checked in, and `checked_in_at` has to keep meaning "somebody turned up".
 *
 * `expire_payment` (migration 0024) is the fourth: a `pending` booking whose payment never
 * arrived is cancelled at `payment_expires_at`, because a pending booking holds its slot.
 */
export type AutomaticTransition = 'start' | 'complete' | 'no_show' | 'expire_payment';

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    tenantId: text('tenant_id'),
    status: text('status').notNull().default('pending').$type<BookingStatus>(),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id'),
    holdId: uuid('hold_id'),
    recurrenceId: uuid('recurrence_id'),
    groupId: uuid('group_id'),
    rescheduledToBookingId: uuid('rescheduled_to_booking_id'),
    rescheduledFromBookingId: uuid('rescheduled_from_booking_id'),
    rescheduleCount: integer('reschedule_count').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    quantity: integer('quantity').notNull().default(1),
    priceAmount: integer('price_amount'),
    currency: text('currency'),
    /**
     * Which `services.pricing_rules` entry produced `price_amount`, `{ index, label }`, or
     * `null` for the flat service price. A snapshot, like `policySnapshot` (migration 0020).
     */
    priceRule: jsonb('price_rule'),
    amountPaid: integer('amount_paid').notNull().default(0),
    amountDue: integer('amount_due').notNull().default(0),
    amountRefunded: integer('amount_refunded').notNull().default(0),
    /**
     * When a `pending` booking waiting for its payment is cancelled (migration 0024).
     *
     * `null` on every other booking, and cleared the instant the payment succeeds. A pending
     * booking occupies its slot exactly like a confirmed one, so without this a customer who
     * closed the browser would hold it for ever.
     */
    paymentExpiresAt: timestamp('payment_expires_at', { withTimezone: true }),
    policySnapshot: jsonb('policy_snapshot'),
    source: text('source').notNull().default('api').$type<'api' | 'widget' | 'portal' | 'import'>(),
    cancelledBy: text('cancelled_by').$type<'customer' | 'provider' | 'system'>(),
    cancellationReason: text('cancellation_reason'),
    notes: text('notes'),
    metadata: jsonb('metadata').notNull().default({}),
    nextTransitionAt: timestamp('next_transition_at', { withTimezone: true }),
    nextTransition: text('next_transition').$type<AutomaticTransition>(),
    /** Percentage, `numeric(5,2)`: pg returns it as a string, never as a float. */
    refundPercent: text('refund_percent'),
    refundAmountExpected: integer('refund_amount_expected'),
    noShowChargeExpected: integer('no_show_charge_expected'),
    rescheduleFeeExpected: integer('reschedule_fee_expected'),
    rescheduledAt: timestamp('rescheduled_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    noShowAt: timestamp('no_show_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [
    index('bookings_scope_status_idx').on(t.projectId, t.environment, t.status),
    index('bookings_customer_idx').on(t.customerId),
    index('bookings_rescheduled_from_idx').on(t.rescheduledFromBookingId),
  ],
);

export const bookingAllocations = pgTable(
  'booking_allocations',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    bookingId: uuid('booking_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    role: text('role'),
    capacityUsed: integer('capacity_used').notNull().default(1),
    ...timestampColumns(),
  },
  (t) => [
    index('booking_allocations_resource_idx').on(t.resourceId),
    index('booking_allocations_scope_idx').on(t.projectId, t.environment),
  ],
);

export const occupancies = pgTable(
  'occupancies',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    resourceId: uuid('resource_id').notNull(),
    period: tstzrange('period').notNull(),
    capacityUsed: integer('capacity_used').notNull(),
    kind: text('kind').notNull().$type<'booking' | 'hold' | 'block'>(),
    refId: uuid('ref_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Buffers the occupancy carries around its own period, in milliseconds. */
    bufferBeforeMs: integer('buffer_before_ms').notNull().default(0),
    bufferAfterMs: integer('buffer_after_ms').notNull().default(0),
    active: boolean('active').notNull().default(true),
    /** Maintained by trigger from resources.capacity; never written by the application. */
    singleCapacityResource: boolean('single_capacity_resource').notNull().default(false),
    ...timestampColumns(),
  },
  (t) => [
    index('occupancies_ref_idx').on(t.refId),
    index('occupancies_scope_idx').on(t.projectId, t.environment),
  ],
);

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    windowFrom: timestamp('window_from', { withTimezone: true }).notNull(),
    windowTo: timestamp('window_to', { withTimezone: true }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    priority: integer('priority').notNull().default(0),
    status: text('status')
      .notNull()
      .default('active')
      .$type<'active' | 'offered' | 'converted' | 'expired' | 'cancelled'>(),
    holdId: uuid('hold_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('waitlist_entries_scope_idx').on(t.projectId, t.environment)],
);

export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    customerId: uuid('customer_id').notNull(),
    type: text('type').notNull().$type<'package' | 'subscription' | 'credit'>(),
    serviceIds: uuid('service_ids').array().notNull().default([]),
    total: integer('total'),
    remaining: integer('remaining'),
    currency: text('currency'),
    period: text('period'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    maxConcurrentBookings: integer('max_concurrent_bookings'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [
    index('entitlements_customer_idx').on(t.customerId),
    index('entitlements_scope_idx').on(t.projectId, t.environment),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    bookingId: uuid('booking_id'),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    type: text('type').notNull().$type<PaymentType>(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('pending').$type<PaymentStatus>(),
    /** The connected account the intent lives on: `acct_...` (migration 0024). */
    providerAccountId: text('provider_account_id').notNull(),
    /** A refund points at the payment it gives back; `null` on everything else. */
    parentPaymentId: uuid('parent_payment_id'),
    /** Cumulative, written only by the webhook receiver from what Stripe says about the charge. */
    amountRefunded: integer('amount_refunded').notNull().default(0),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    /** A call this row still owes the provider. Drained by the `payment-actions` queue. */
    pendingAction: text('pending_action').$type<PendingPaymentAction>(),
    pendingActionAttempts: integer('pending_action_attempts').notNull().default(0),
    pendingActionNextAt: timestamp('pending_action_next_at', { withTimezone: true }),
    pendingActionError: text('pending_action_error'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [
    index('payments_booking_idx').on(t.bookingId),
    index('payments_scope_idx').on(t.projectId, t.environment),
    index('payments_parent_idx').on(t.parentPaymentId),
  ],
);

/** The two calls a payment row can owe Stripe. See migration 0024. */
export type PendingPaymentAction = 'cancel_intent' | 'create_refund';

/** `payments.type`: what a row of money is. */
export type PaymentType = 'deposit' | 'full' | 'balance' | 'no_show_fee' | 'refund';

/** `payments.status`. `pending` covers every Stripe state that is not final. */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'cancelled';

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    type: text('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actor: jsonb('actor'),
    data: jsonb('data').notNull(),
    previous: jsonb('previous'),
    apiVersion: text('api_version').notNull(),
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    /**
     * Full transaction id of the `INSERT` (migration 0011), as text: Drizzle has no `xid8`,
     * and the column is never compared in TypeScript, only in SQL, where the type is right.
     * With `seq` it is the cursor order of `GET /v1/events`. See the migration for why `seq`
     * on its own is not a cursor.
     */
    txid: text('txid').notNull(),
    ...timestampColumns(),
  },
  (t) => [
    index('events_scope_seq_idx').on(t.projectId, t.environment, t.seq),
    index('events_scope_cursor_idx').on(t.projectId, t.environment, t.txid, t.seq),
  ],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull().default([]),
    secret: text('secret').notNull(),
    status: text('status').notNull().default('active').$type<'active' | 'disabled' | 'failing'>(),
    description: text('description'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('webhooks_scope_idx').on(t.projectId, t.environment)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    webhookId: uuid('webhook_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'succeeded' | 'failed'>(),
    attempt: integer('attempt').notNull().default(0),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    error: text('error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When this delivery becomes due. The retry ladder lives in this column and only here, so a
     * purge of the job queue cannot lose it; the rungs themselves are
     * `WEBHOOK_RETRY_DELAYS_SECONDS` in `packages/api/src/webhooks/dispatch.ts`.
     */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** Set while an attempt is in flight. Separate from `nextAttemptAt`, which is the ladder. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    /** Wall clock of the last attempt, DNS included: what the ten second timeout measures. */
    durationMs: integer('duration_ms'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_scope_idx').on(t.projectId, t.environment),
  ],
);
