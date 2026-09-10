/**
 * Creating or finding a customer from the fields a caller sends inline.
 *
 * Used twice: by `POST /v1/customers`, and by the `customer` object that `POST /v1/bookings`
 * and `POST /v1/holds` accept instead of a `customer_id`. The two must behave identically (a
 * booking that "creates the customer" and a `POST /v1/customers` followed by a booking have
 * to leave the same row), so the rule lives here rather than being written twice.
 *
 * The rule: `external_id` identifies the caller's own record and upserts on it; failing that,
 * and only for the inline form, `email` **finds** a person, case-insensitively; failing both,
 * a new row.
 *
 * Two different verbs, on purpose:
 *
 *  - on `external_id` the caller is naming *their own* record, so the write is a **merge**:
 *    posting `{external_id, name}` updates the name and does not wipe the phone number an
 *    earlier call recorded. An explicit `null` still clears a field, exactly as `PATCH` does.
 *  - on `email` the caller is **not** asking to edit an address book. `POST /v1/bookings`
 *    with `customer: {email, name}` used to overwrite the name of whoever already had that
 *    address, and the key model foresees publishable `pk_` keys held by
 *    the end customer's browser, which would make that "anyone may rewrite the record of
 *    anyone whose email they know". So an existing row is **reused as it is**: only the
 *    fields that are still empty get filled, and changing a customer is `PATCH
 *    /v1/customers/{id}`.
 *
 * The email lookup is also scoped to the key's `tenant_id` when it has one: the insert stamps
 * `auth.tenantId` on a new row, so a search that ignored it would let a tenant-scoped key find
 * (and now fill in) the customer of another tenant of the same project.
 */
import { and, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm';
import { customers, type Transaction } from '@bookrail/db';
import { encodeId, BookrailError, uuidv7 } from '@bookrail/shared';
import type { AuthContext } from './context.js';
import { firstRow } from './http.js';

export interface CustomerInput {
  external_id?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  name?: string | null | undefined;
  timezone?: string | null | undefined;
  locale?: string | null | undefined;
  tenant_id?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type CustomerRow = typeof customers.$inferSelect;

export interface UpsertedCustomer {
  row: CustomerRow;
  /** False when an existing row was matched and merged into. */
  created: boolean;
}

/** Only the keys the caller actually sent: used for the INSERT and for the merge alike. */
function providedFields(body: CustomerInput): Partial<typeof customers.$inferInsert> {
  const provided: Partial<typeof customers.$inferInsert> = {};
  if (body.external_id !== undefined) provided.externalId = body.external_id ?? null;
  if (body.email !== undefined) provided.email = body.email ?? null;
  if (body.phone !== undefined) provided.phone = body.phone ?? null;
  if (body.name !== undefined) provided.name = body.name ?? null;
  if (body.timezone !== undefined) provided.timezone = body.timezone ?? null;
  if (body.locale !== undefined) provided.locale = body.locale ?? null;
  if (body.tenant_id !== undefined) provided.tenantId = body.tenant_id ?? null;
  if (body.metadata !== undefined) provided.metadata = body.metadata;
  return provided;
}

export async function upsertCustomer(
  tx: Transaction,
  auth: AuthContext,
  body: CustomerInput,
  options: { matchByEmail?: boolean } = {},
): Promise<UpsertedCustomer> {
  const provided = providedFields(body);
  const insertValues = {
    id: uuidv7(),
    projectId: auth.projectId,
    environment: auth.environment,
    tenantId: auth.tenantId,
    ...provided,
  };

  if (insertValues.externalId) {
    // `xmax = 0` identifies the INSERT path of an upsert: on the DO UPDATE path the row
    // carries the locking transaction id. It replaces a pre-emptive SELECT, which would have
    // reported 201 twice for two concurrent posts of the same external_id.
    const rows = await tx
      .insert(customers)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [customers.projectId, customers.environment, customers.externalId],
        targetWhere: isNotNull(customers.externalId),
        set: { ...provided, updatedAt: new Date() },
      })
      .returning({ ...getTableColumns(customers), xmax: sql<string>`xmax::text` });
    const { xmax, ...row } = firstRow(rows);
    return { row, created: xmax === '0' };
  }

  // There is no unique index on `email` (two people may legitimately share a family address),
  // so matching on it is a plain lookup and cannot be an upsert. It is therefore offered
  // only to the inline `customer` of a booking, where "the same person booking again" is the
  // overwhelmingly common case and creating a duplicate customer per booking would be worse
  // than the (small, single-tenant) race of two first-ever bookings arriving together.
  if (options.matchByEmail === true && insertValues.email) {
    const existing = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(sql`lower(${customers.email})`, insertValues.email.toLowerCase()),
          auth.tenantId === null ? undefined : eq(customers.tenantId, auth.tenantId),
        ),
      )
      .orderBy(customers.id)
      .limit(1);
    const found = existing[0];
    if (found) return fillGaps(tx, found, provided);
  }

  const row = firstRow(await tx.insert(customers).values(insertValues).returning());
  return { row, created: true };
}

/**
 * Writes only into the holes: a field the existing row already has keeps its value.
 *
 * `metadata` is `NOT NULL DEFAULT '{}'`, so "empty" for it means the empty object rather than
 * `NULL`. When there is nothing to fill the row is returned untouched, which also keeps
 * `updated_at` honest: reading a customer is not a change to it.
 */
async function fillGaps(
  tx: Transaction,
  found: CustomerRow,
  provided: Partial<typeof customers.$inferInsert>,
): Promise<UpsertedCustomer> {
  const gaps: Partial<typeof customers.$inferInsert> = {};
  if (provided.externalId != null && found.externalId === null)
    gaps.externalId = provided.externalId;
  if (provided.phone != null && found.phone === null) gaps.phone = provided.phone;
  if (provided.name != null && found.name === null) gaps.name = provided.name;
  if (provided.timezone != null && found.timezone === null) gaps.timezone = provided.timezone;
  if (provided.locale != null && found.locale === null) gaps.locale = provided.locale;
  if (provided.tenantId != null && found.tenantId === null) gaps.tenantId = provided.tenantId;
  if (provided.metadata !== undefined && isEmptyObject(found.metadata))
    gaps.metadata = provided.metadata;

  if (Object.keys(gaps).length === 0) return { row: found, created: false };
  const updated = await tx
    .update(customers)
    .set({ ...gaps, updatedAt: new Date() })
    .where(eq(customers.id, found.id))
    .returning();
  return { row: firstRow(updated), created: false };
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Confirms that a `customer_id` names a customer of this project and environment.
 *
 * Without it the id travels all the way to the engine and dies on the composite foreign key, which
 * `pg-errors.ts` turns into `400 parameter_invalid` with no `param`, while `service_id`, `hold_id`
 * and `resource_ids` in the very same body answer `404 resource_missing`. One `SELECT 1` buys the
 * consistency the error taxonomy promises, and Row Level Security is what makes "another project's
 * customer" and "no such customer" the same answer, which is the answer we want to give.
 */
export async function assertCustomerExists(tx: Transaction, customerId: string): Promise<void> {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (rows.length === 0) {
    throw new BookrailError(
      'not_found',
      'resource_missing',
      `No such customer: ${encodeId('customer', customerId)}`,
      'customer_id',
    );
  }
}
