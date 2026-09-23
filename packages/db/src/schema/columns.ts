import { customType, timestamp, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Postgres `tstzrange`. Drizzle has no built-in range type; the driver hands ranges over as
 * their text form (`["2026-09-08 07:00:00+00","2026-09-08 08:00:00+00")`), which is exactly
 * what we want to send back, so the mapping is the identity on strings.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

/**
 * Postgres `bytea`. The `pg` driver hands one over as a `Buffer` and accepts a `Buffer` back,
 * so, like the range above, the mapping is the identity.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** `[from, to)`: half open, the only sane convention for adjacent bookings. */
export function tstzrangeLiteral(from: Date | string, to: Date | string): string {
  const lower = from instanceof Date ? from.toISOString() : from;
  const upper = to instanceof Date ? to.toISOString() : to;
  return `["${lower}","${upper}")`;
}

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** project_id + environment: present on every project table, and the basis of every RLS policy. */
export const projectScopeColumns = () => ({
  projectId: uuid('project_id').notNull(),
  environment: text('environment').notNull().$type<'test' | 'live'>(),
});

export const timestampColumns = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
