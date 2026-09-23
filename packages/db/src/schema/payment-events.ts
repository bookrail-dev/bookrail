import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';

/**
 * Every event a payment provider sent us, claimed before it is acted on (migration 0024).
 *
 * The table exists for one promise: **the same provider event never has its effect twice.**
 * Stripe retries until it gets a 2xx and may redeliver after one, and applying
 * `payment_intent.succeeded` twice would add the amount to `bookings.amount_paid` twice.
 *
 * `projectId` and `environment` are nullable, unlike every other project table, because an
 * event about an intent this deployment never created belongs to no project. Those rows are
 * written by `stripe_event_record_unmatched` and read by nothing: the isolation policy is false
 * for a NULL project, so the application role cannot see or write them even by mistake.
 */
export const paymentProviderEvents = pgTable(
  'payment_provider_events',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id'),
    environment: text('environment').$type<'test' | 'live'>(),
    provider: text('provider').notNull(),
    /** Stripe's own `evt_...`. Unique across the whole table, not per project. */
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    /** `event.account` of a Connect event: the connected account it came from. */
    providerAccountId: text('provider_account_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL while an attempt is in flight or after one that failed: that is what makes a
     * redelivery a retry rather than a duplicate. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    outcome: text('outcome').$type<PaymentProviderEventOutcome>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('payment_provider_events_scope_idx').on(t.projectId, t.environment, t.receivedAt),
    index('payment_provider_events_unprocessed_idx').on(t.receivedAt),
  ],
);

/** How a claimed event ended: applied to a payment, deliberately ignored, or unattributable. */
export type PaymentProviderEventOutcome = 'applied' | 'ignored' | 'unmatched';
