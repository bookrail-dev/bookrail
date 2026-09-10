import { Hono } from 'hono';
import { and, asc, eq, gt } from 'drizzle-orm';
import { customers } from '@bookrail/db';
import { errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { upsertCustomer } from '../customers.js';
import {
  deletedEnvelope,
  inProject,
  listEnvelope,
  paginate,
  parseJsonBody,
  parseListParams,
  pathId,
} from '../http.js';
import { customerCreateSchema, customerUpdateSchema } from '../schemas/index.js';
import { serializeCustomer } from '../serialize.js';

export function customersRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Create, or upsert when `external_id` is present: the customer already exists in the
   * caller's own system, so re-posting the same external_id must not create a duplicate.
   *
   * The rule itself lives in `src/customers.ts`, because `POST /v1/bookings` and
   * `POST /v1/holds` accept the same fields inline and have to produce the same row.
   * Matching by email is **not** offered here: this endpoint is explicit about creating a
   * customer, and two people may share an address.
   */
  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, customerCreateSchema);
    const result = await inProject(c, deps, (tx, auth) => upsertCustomer(tx, auth, body));
    return c.json(serializeCustomer(result.row), result.created ? 201 : 200);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'customer');
    const externalId = c.req.query('external_id');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .select()
        .from(customers)
        .where(
          and(
            startingAfter ? gt(customers.id, startingAfter) : undefined,
            externalId ? eq(customers.externalId, externalId) : undefined,
          ),
        )
        .orderBy(asc(customers.id))
        .limit(limit + 1),
    );
    const { page, hasMore } = paginate(rows, limit);
    return c.json(listEnvelope(page.map(serializeCustomer), hasMore));
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'customer', 'customer');
    const rows = await inProject(c, deps, async (tx) =>
      tx.select().from(customers).where(eq(customers.id, id)).limit(1),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('customer', c.req.param('id') ?? '');
    return c.json(serializeCustomer(row));
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'customer', 'customer');
    const body = await parseJsonBody(c, customerUpdateSchema);
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .update(customers)
        .set({
          ...(body.external_id !== undefined ? { externalId: body.external_id ?? null } : {}),
          ...(body.email !== undefined ? { email: body.email ?? null } : {}),
          ...(body.phone !== undefined ? { phone: body.phone ?? null } : {}),
          ...(body.name !== undefined ? { name: body.name ?? null } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone ?? null } : {}),
          ...(body.locale !== undefined ? { locale: body.locale ?? null } : {}),
          ...(body.tenant_id !== undefined ? { tenantId: body.tenant_id ?? null } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        })
        .where(eq(customers.id, id))
        .returning(),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('customer', c.req.param('id') ?? '');
    return c.json(serializeCustomer(row));
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'customer', 'customer');
    const rows = await inProject(c, deps, async (tx) =>
      tx.delete(customers).where(eq(customers.id, id)).returning({ id: customers.id }),
    );
    if (!rows[0]) throw errors.notFound('customer', c.req.param('id') ?? '');
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'customer'));
  });

  return routes;
}
