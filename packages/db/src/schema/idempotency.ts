import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projectScopeColumns, timestampColumns } from './columns.js';

/**
 * One row per `Idempotency-Key` the API has seen, per project and environment.
 *
 * The unique index on `(project_id, environment, key)` is the mechanism, not a nicety: the
 * request that manages to insert the row owns the key, and every other request carrying it
 * loses the insert instead of racing through a read-then-write. Migration 0010 explains the
 * three states of a row (claimed, stale, completed) and why a 5xx is never stored.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    key: text('key').notNull(),
    /** SHA-256 of method, path and raw body. A different hash for the same key is a 400. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    /** When the current claim was taken. Past the lease, another request may take it over. */
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestampColumns(),
  },
  (t) => [index('idempotency_keys_expiry_idx').on(t.expiresAt)],
);
