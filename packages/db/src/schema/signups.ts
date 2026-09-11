import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One request for a test key, from the moment somebody typed an address to the moment the key
 * reached them.
 *
 * The table is declared here because the schema of this package is meant to describe the whole
 * database, but **nothing in the application reads or writes it through Drizzle**, and nothing
 * can: row security is enabled and forced on it and there is no policy at all, so the
 * application role sees zero rows and every statement it tries is refused. The only way in is
 * the four `SECURITY DEFINER` functions of migration 0021, which the API calls by name.
 *
 * Nothing here is a secret in clear text. The confirmation token and the poll token are stored
 * as SHA-256 hashes, the caller's address as a hash of itself, and the key that the confirm
 * mints for a waiting terminal is stored as an AES-256-GCM envelope for at most fifteen
 * minutes, encrypted under a key that lives in the environment and not in this database.
 */
export const signups = pgTable(
  'signups',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Only a terminal has one: a browser is handed the key in the confirm response. */
    pollTokenHash: text('poll_token_hash'),
    client: text('client').notNull().$type<'cli' | 'web'>(),
    ipHash: text('ip_hash').notNull(),
    accountName: text('account_name').notNull(),
    projectName: text('project_name').notNull(),
    defaultTimezone: text('default_timezone').notNull(),
    defaultCurrency: text('default_currency').notNull(),
    status: text('status')
      .notNull()
      .$type<'pending' | 'confirmed' | 'claimed' | 'email_taken' | 'expired'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    accountId: uuid('account_id'),
    projectId: uuid('project_id'),
    /**
     * The key this sign up minted, written by the confirm and read back by the claim.
     *
     * Not a convenience: it is the additional authenticated data the envelope below was sealed
     * with, so deriving it again later (the newest test key of the project, say) would decrypt
     * with the wrong value the day a project has two of them.
     */
    apiKeyId: uuid('api_key_id'),
    pendingSecret: text('pending_secret'),
    pendingSecretExpiresAt: timestamp('pending_secret_expires_at', { withTimezone: true }),
  },
  (t) => [
    index('signups_email_created_at_idx').on(t.email, t.createdAt.desc()),
    index('signups_ip_hash_created_at_idx').on(t.ipHash, t.createdAt.desc()),
    index('signups_housekeeping_idx').on(t.createdAt),
  ],
);
