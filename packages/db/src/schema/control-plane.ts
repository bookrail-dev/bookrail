import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestampColumns } from './columns.js';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  apiVersion: text('api_version').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  ...timestampColumns(),
});

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
