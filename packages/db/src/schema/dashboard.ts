import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The two tables of the dashboard (migration 0026).
 *
 * Declared here because the schema of this package describes the whole database, but **nothing
 * in the application reads or writes them through Drizzle**, and nothing can: row security is
 * enabled and forced on both and there is no policy and no grant, so the application role sees
 * nothing and every statement it tries is refused. The only way in is the eight
 * `SECURITY DEFINER` functions of migration 0026, which the API calls by name.
 *
 * Nothing here is a secret in clear text: the link token and the session token are stored as
 * SHA-256 hashes, and the caller's address as a hash of itself.
 */

/**
 * One request for a dashboard link, for an address with an account or without one: the two
 * ceilings count every request, so that the answer never depends on whether the address is a
 * customer. `accountId` is `null` when it is not, and such a row can never be confirmed.
 */
export const dashboardLogins = pgTable(
  'dashboard_logins',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    accountId: uuid('account_id'),
    tokenHash: text('token_hash').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    index('dashboard_logins_email_created_at_idx').on(t.email, t.createdAt.desc()),
    index('dashboard_logins_ip_hash_created_at_idx').on(t.ipHash, t.createdAt.desc()),
    index('dashboard_logins_housekeeping_idx').on(t.createdAt),
  ],
);

/** One dashboard session: an account, twelve hours, no renewal. */
export const dashboardSessions = pgTable(
  'dashboard_sessions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('dashboard_sessions_account_id_idx').on(t.accountId),
    index('dashboard_sessions_housekeeping_idx').on(t.expiresAt),
  ],
);
