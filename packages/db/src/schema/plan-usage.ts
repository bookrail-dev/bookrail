import { bigint, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { timestampColumns } from './columns.js';

/**
 * What one project used of its account's plan in one UTC month (migration 0025).
 *
 * Live only: `environment` is constrained to `'live'` by a CHECK, because the test environment
 * never counts. One row per (project, environment, month), incremented with
 * `INSERT ... ON CONFLICT DO UPDATE` inside the transaction of the booking or the payment it
 * counts, never outside it. The engine writes it with SQL (`recordPlanUsage`); the declaration
 * is here so that the schema of this package describes the whole database.
 *
 * `paymentVolume` can be negative: a refund is counted in the month it is made, and a refund of
 * a payment taken in an earlier month takes this month's net below zero.
 */
export const planUsage = pgTable(
  'plan_usage',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    environment: text('environment').notNull().$type<'live'>(),
    /** `YYYY-MM`, UTC. */
    month: text('month').notNull(),
    bookingsConfirmed: integer('bookings_confirmed').notNull().default(0),
    paymentVolume: bigint('payment_volume', { mode: 'number' }).notNull().default(0),
    /** The currency of the first payment of the month, `mixed` after a second one. */
    currency: text('currency'),
    ...timestampColumns(),
  },
  (t) => [unique().on(t.projectId, t.environment, t.month)],
);

/**
 * The warnings of a month that have already been sent, one per account and threshold.
 *
 * Closed like `signups`: row security enabled and forced, no policy, no grant. Nothing in the
 * application reads or writes it through Drizzle; `plan_usage_warning_claim` is the only way in,
 * and the UNIQUE on (account, month, threshold) is what makes a warning go out once.
 */
export const planUsageWarnings = pgTable(
  'plan_usage_warnings',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    month: text('month').notNull(),
    threshold: integer('threshold').notNull().$type<80 | 100>(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.accountId, t.month, t.threshold)],
);
