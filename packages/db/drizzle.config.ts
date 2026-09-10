import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit is available for inspecting and diffing the schema, but the migrations in
 * `migrations/` are the source of truth and are written by hand: RLS policies, exclusion
 * constraints, composite foreign keys, triggers and GRANTs are not expressible in the
 * Drizzle schema DSL.
 */
export default {
  schema: './src/schema/index.ts',
  out: './migrations/generated',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
