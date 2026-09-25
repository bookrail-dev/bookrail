import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestampColumns } from './columns.js';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    plan: text('plan').notNull().default('free'),
    apiVersion: text('api_version').notNull(),
    /**
     * How the account came into being. `bootstrap` is a human running the command over SSH,
     * `self_serve` is the sign up endpoint. The distinction is not decoration: the unique index
     * on `owner_email` covers the second kind only, so a second account for the same address
     * can still be created by hand for somebody who asks for one.
     */
    origin: text('origin').notNull().default('bootstrap').$type<'bootstrap' | 'self_serve'>(),
    /** The address that confirmed the sign up, lower case. NULL for an account made by hand. */
    ownerEmail: text('owner_email'),
    /** The Stripe customer of the account in Billing, once it has one (migration 0027). */
    stripeCustomerId: text('stripe_customer_id').unique(),
    /** The last Checkout Session opened for the account, expired before another (0027). */
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('accounts_self_serve_owner_email_idx')
      .on(t.ownerEmail)
      .where(sql`origin = 'self_serve'`),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    name: text('name').notNull(),
    defaultTimezone: text('default_timezone').notNull().default('UTC'),
    defaultCurrency: text('default_currency').notNull().default('EUR'),
    settings: jsonb('settings').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('projects_account_id_idx').on(t.accountId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    environment: text('environment').notNull().$type<'test' | 'live'>(),
    kind: text('kind').notNull().default('secret').$type<'secret' | 'publishable'>(),
    name: text('name'),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    tenantId: text('tenant_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [
    index('api_keys_prefix_idx').on(t.prefix),
    index('api_keys_project_env_idx').on(t.projectId, t.environment),
  ],
);
