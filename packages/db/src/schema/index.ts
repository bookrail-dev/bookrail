export * from './columns.js';
export * from './control-plane.js';
export * from './catalog.js';
export * from './bookings.js';
export * from './idempotency.js';
export * from './outbox.js';

import * as controlPlane from './control-plane.js';
import * as catalog from './catalog.js';
import * as bookings from './bookings.js';
import * as idempotency from './idempotency.js';
import * as outbox from './outbox.js';

/** Every table, in the shape Drizzle wants for `drizzle(pool, { schema })`. */
export const schema = { ...controlPlane, ...catalog, ...bookings, ...idempotency, ...outbox };

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
] as const;

export const CONTROL_PLANE_TABLES = ['accounts', 'projects', 'api_keys'] as const;

export const ALL_TABLES = [...CONTROL_PLANE_TABLES, ...PROJECT_TABLES] as const;

/** Append-only: the application role holds SELECT and INSERT and nothing else. */
export const APPEND_ONLY_TABLES = ['events'] as const;
