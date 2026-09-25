export * from './columns.js';
export * from './control-plane.js';
export * from './catalog.js';
export * from './bookings.js';
export * from './idempotency.js';
export * from './outbox.js';
export * from './payment-connections.js';
export * from './payment-events.js';
export * from './signups.js';
export * from './plan-usage.js';
export * from './dashboard.js';
export * from './billing.js';

import * as controlPlane from './control-plane.js';
import * as catalog from './catalog.js';
import * as bookings from './bookings.js';
import * as idempotency from './idempotency.js';
import * as outbox from './outbox.js';
import * as paymentConnections from './payment-connections.js';
import * as paymentEvents from './payment-events.js';
import * as signups from './signups.js';
import * as planUsage from './plan-usage.js';
import * as dashboard from './dashboard.js';
import * as billing from './billing.js';

/** Every table, in the shape Drizzle wants for `drizzle(pool, { schema })`. */
export const schema = {
  ...controlPlane,
  ...catalog,
  ...bookings,
  ...idempotency,
  ...outbox,
  ...paymentConnections,
  ...paymentEvents,
  ...signups,
  ...planUsage,
  ...dashboard,
  ...billing,
};

/**
 * Tables scoped to a (project_id, environment) pair.
 *
 * This is a declaration of intent, not the source of truth: the RLS test derives the real
 * list from the catalogue (every table that has a project_id column) and fails when the two
 * disagree. Adding a project table and forgetting it here, or forgetting it in migration
 * 0007, breaks that test, which is the point.
 */
export const PROJECT_TABLES = [
  'locations',
  'schedules',
  'schedule_rules',
  'schedule_exceptions',
  'resources',
  'resource_groups',
  'resource_group_members',
  'resource_blocks',
  'policies',
  'services',
  'service_requirements',
  'customers',
  'recurrences',
  'holds',
  'bookings',
  'booking_allocations',
  'occupancies',
  'waitlist_entries',
  'entitlements',
  'payments',
  'events',
  'webhooks',
  'webhook_deliveries',
  'idempotency_keys',
  'outbox_cursor',
  'payment_provider_connections',
  'stripe_oauth_states',
  // Its two scope columns are nullable: an event nobody can attribute to a project is still
  // recorded, and the isolation policy is false for those rows, so nothing reaches them
  // outside `stripe_event_record_unmatched`. See migration 0024.
  'payment_provider_events',
  // Live only: a CHECK constrains its `environment` to 'live', so the test environment has no
  // rows in it at all. See `LIVE_ONLY_TABLES` and migration 0025.
  'plan_usage',
] as const;

/**
 * Project tables whose rows exist in the live environment only.
 *
 * `plan_usage` counts what the plan of an account measures, and the test environment is never
 * measured: a CHECK on its `environment` makes a test row impossible rather than merely unused.
 * The isolation tests seed and expect nothing for these tables in the test environment.
 */
export const LIVE_ONLY_TABLES = ['plan_usage'] as const;

export const CONTROL_PLANE_TABLES = ['accounts', 'projects', 'api_keys'] as const;

/**
 * Tables that belong to no project and that no role may touch directly.
 *
 * `signups` records the request for a test key that comes *before* an account exists, so there
 * is no project to key a policy on. Rather than invent one, row security is enabled and forced
 * and no policy is written: the application role sees nothing and can write nothing, and the
 * four `SECURITY DEFINER` functions of migration 0021 are the only way in.
 */
export const DEFINER_ONLY_TABLES = ['signups'] as const;

/**
 * Tables that belong to an account rather than to a project, and that no role may touch directly.
 *
 * `plan_usage_warnings` remembers which usage warnings of a month have been sent to an account.
 * It has no `project_id` (an account with two projects is warned once), so there is nothing to
 * key a project policy on; like `signups` it is closed, with row security forced and no policy,
 * and `plan_usage_warning_claim` of migration 0025 is the only way in.
 */
export const ACCOUNT_DEFINER_TABLES = [
  'plan_usage_warnings',
  // The dashboard of migration 0026: the requests for a link and the sessions. They belong to an
  // account (or, for a request from an address with no account, to nobody), never to a project,
  // and the eight `dashboard_*` functions are the only way in.
  'dashboard_logins',
  'dashboard_sessions',
  // Stripe Billing and the terms, migration 0027: the subscription of an account, the events of
  // the Billing receiver, the overage of a month, the paid invoices and the acceptances. All of
  // them belong to an account, none to a project, and the functions of 0027 are the only way in.
  'billing_subscriptions',
  'billing_events',
  'billing_overages',
  'billing_invoices',
  'billing_unpaid_invoices',
  'terms_acceptances',
  // The history of the plan of an account, migration 0028: what the overage of a month reads to
  // know which plan served which day. Written by the writer of `plan.changed` only.
  'billing_plan_history',
] as const;

export const ALL_TABLES = [
  ...CONTROL_PLANE_TABLES,
  ...PROJECT_TABLES,
  ...DEFINER_ONLY_TABLES,
  ...ACCOUNT_DEFINER_TABLES,
] as const;

/** Append-only: the application role holds SELECT and INSERT and nothing else. */
export const APPEND_ONLY_TABLES = ['events'] as const;
