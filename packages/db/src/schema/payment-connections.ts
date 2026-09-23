import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, projectScopeColumns, timestampColumns } from './columns.js';

/**
 * The payment provider account a project's charges are made on (migration 0023).
 *
 * Bookrail is a Connect platform of the SaaS kind: the customer stays the merchant and Bookrail
 * acts for them with its own platform key plus a `Stripe-Account` header. So there is no
 * credential of the customer's here, and there is deliberately none anywhere else either: the
 * OAuth exchange hands back an access token and a refresh token next to the account identifier,
 * and neither is written down, because for a Standard account they are a deprecated second way
 * of doing what the header already does.
 *
 * `livemode` repeats what the authorisation said, and a CHECK in the migration ties it to
 * `environment`: a test authorisation attached to the live environment is not a case to handle,
 * it is a row that cannot exist.
 */
export const paymentProviderConnections = pgTable(
  'payment_provider_connections',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    provider: text('provider').notNull().$type<'stripe'>(),
    /** `acct_...`. An identifier, not a secret: it travels as a request header. */
    providerAccountId: text('provider_account_id').notNull(),
    status: text('status').notNull().$type<'connected' | 'disconnected'>(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    disconnectReason: text('disconnect_reason').$type<'user' | 'deauthorized'>(),
    livemode: boolean('livemode').notNull(),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    ...timestampColumns(),
  },
  (t) => [
    unique().on(t.projectId, t.environment, t.provider),
    unique().on(t.id, t.projectId, t.environment),
    index('payment_provider_connections_account_idx').on(t.provider, t.providerAccountId),
  ],
);

/**
 * One in flight Stripe Connect authorisation, from the moment the CLI asked for a link to the
 * moment the browser comes back (migration 0023).
 *
 * The `state` parameter is the only thing that ties the callback, which carries no API key at
 * all, to the project that asked for it. So it is 32 random bytes, it is good for fifteen
 * minutes, it is consumed exactly once, and this table holds only its SHA-256: the clear text
 * lives in a URL and in a browser and never reaches the database.
 *
 * Nothing in the application reads this table through Drizzle from the callback: that read is
 * `stripe_oauth_state_claim`, a `SECURITY DEFINER` function, because the callback has no
 * project context to satisfy the policy with. The insert, which does have one, is ordinary.
 */
export const stripeOauthStates = pgTable(
  'stripe_oauth_states',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    /** SHA-256 of the clear text state, 32 bytes. */
    stateHash: bytea('state_hash').notNull(),
    /** The credential that asked for the link, and therefore the actor of `stripe.connected`. */
    apiKeyId: uuid('api_key_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stripe_oauth_states_housekeeping_idx').on(t.expiresAt)],
);
