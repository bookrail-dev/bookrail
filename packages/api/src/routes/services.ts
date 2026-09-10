import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { serviceRequirements, services, type Transaction } from '@bookrail/db';
import { errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv, AuthContext } from '../context.js';
import {
  deletedEnvelope,
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseExpand,
  parseJsonBody,
  parseListParams,
  pathId,
} from '../http.js';
import { serviceCreateSchema, serviceUpdateSchema } from '../schemas/index.js';
import { serializeService } from '../serialize.js';
import type { Service } from '../schemas/responses.js';

const EXPANDABLE = ['requirements'] as const;

type ServiceRow = typeof services.$inferSelect;
type RequirementRow = typeof serviceRequirements.$inferSelect;
type RequirementInput = {
  resource_id?: string | undefined;
  resource_group_id?: string | undefined;
  quantity?: number | undefined;
  consumes?: 'per_unit' | 'whole' | undefined;
  role?: string | null | undefined;
};

async function requirementsByService(
  tx: Transaction,
  serviceIds: string[],
): Promise<Map<string, RequirementRow[]>> {
  const map = new Map<string, RequirementRow[]>();
  if (serviceIds.length === 0) return map;
  const rows = await tx
    .select()
    .from(serviceRequirements)
    .where(inArray(serviceRequirements.serviceId, serviceIds))
    .orderBy(asc(serviceRequirements.position), asc(serviceRequirements.id));
  for (const row of rows) {
    const bucket = map.get(row.serviceId) ?? [];
    bucket.push(row);
    map.set(row.serviceId, bucket);
  }
  return map;
}

async function serializeServices(
  tx: Transaction,
  rows: ServiceRow[],
  expand: Set<string>,
): Promise<Service[]> {
  const requirements = await requirementsByService(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const list = requirements.get(row.id) ?? [];
    return serializeService(
      row,
      list.map((r) => r.id),
      expand.has('requirements') ? list : undefined,
    );
  });
}

async function replaceRequirements(
  tx: Transaction,
  auth: AuthContext,
  serviceId: string,
  requirements: RequirementInput[],
): Promise<void> {
  await tx.delete(serviceRequirements).where(eq(serviceRequirements.serviceId, serviceId));
  if (requirements.length === 0) return;
  await tx.insert(serviceRequirements).values(
    requirements.map((requirement, index) => ({
      id: uuidv7(),
      projectId: auth.projectId,
      environment: auth.environment,
      serviceId,
      resourceId: requirement.resource_id ?? null,
      resourceGroupId: requirement.resource_group_id ?? null,
      quantity: requirement.quantity ?? 1,
      consumes: requirement.consumes ?? 'per_unit',
      role: requirement.role ?? null,
      position: index,
    })),
  );
}

type DurationColumns = {
  durationMinutes: number | null;
  durationOptions: number[] | null;
  durationMinMinutes: number | null;
  durationMaxMinutes: number | null;
};

/**
 * A service without a price cannot carry pricing rules.
 *
 * There is nothing for a rule to modify: `price_add` and `price_multiplier` have no base, and a
 * `price` rule would make the service cost something on Saturday and nothing on Monday, which is
 * not a price list but a trap. A rule applies
 * **to the flat price of the service**, so the combination is refused at the door rather than
 * stored and silently ignored, which is precisely the failure this check exists to end.
 *
 * It is checked on the **resulting** row, not on the body: a `PATCH` that adds rules to a
 * service that already has a price is fine, and one that removes the price from a service that
 * has rules is not.
 */
function assertPriceForRules(priceAmount: number | null, rules: readonly unknown[]): void {
  if (rules.length === 0 || priceAmount !== null) return;
  throw errors.invalidRequest(
    'A service without a price cannot have pricing rules: there is nothing for them to modify. Give the service a price, or drop the rules.',
    'pricing_rules',
    'parameter_invalid',
  );
}

function durationColumns(body: {
  duration?: number | undefined;
  duration_options?: number[] | undefined;
  duration_range?: { min: number; max: number } | undefined;
}): DurationColumns {
  return {
    durationMinutes: body.duration ?? null,
    durationOptions: body.duration_options ?? null,
    durationMinMinutes: body.duration_range?.min ?? null,
    durationMaxMinutes: body.duration_range?.max ?? null,
  };
}

export function servicesRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, serviceCreateSchema);
    assertPriceForRules(body.price?.amount ?? null, body.pricing_rules ?? []);
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx, auth) => {
      const row = firstRow(
        await tx
          .insert(services)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            description: body.description ?? null,
            ...durationColumns(body),
            capacityPerBooking: body.capacity_per_booking ?? 1,
            bufferBeforeMinutes: body.buffer_before ?? 0,
            bufferAfterMinutes: body.buffer_after ?? 0,
            slotIntervalMinutes: body.slot_interval ?? null,
            alignTo: body.align_to ?? null,
            priceAmount: body.price?.amount ?? null,
            priceCurrency: body.price?.currency ?? null,
            pricingRules: body.pricing_rules ?? [],
            policyId: body.policy_id ?? null,
            bookingWindow: body.booking_window ?? null,
            allowRecurring: body.allow_recurring ?? false,
            allowMultiDay: body.allow_multi_day ?? false,
            bufferSharing: body.buffer_sharing ?? false,
            allowSplit: body.allow_split ?? false,
            tenantId: body.tenant_id ?? auth.tenantId,
            metadata: body.metadata ?? {},
          })
          .returning(),
      );
      await replaceRequirements(tx, auth, row.id, body.requirements ?? []);
      return firstRow(await serializeServices(tx, [row], expand));
    });
    return c.json(payload, 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'service');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(services)
        .where(
          and(
            isNull(services.deletedAt),
            startingAfter ? gt(services.id, startingAfter) : undefined,
          ),
        )
        .orderBy(asc(services.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(await serializeServices(tx, page, expand), hasMore);
    });
    return c.json(payload);
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'service', 'service');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(services)
        .where(and(eq(services.id, id), isNull(services.deletedAt)))
        .limit(1);
      if (rows.length === 0) return null;
      return firstRow(await serializeServices(tx, rows, expand));
    });
    if (!payload) throw errors.notFound('service', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'service', 'service');
    const body = await parseJsonBody(c, serviceUpdateSchema);
    const expand = parseExpand(c, EXPANDABLE);
    const durationTouched =
      body.duration !== undefined ||
      body.duration_options !== undefined ||
      body.duration_range !== undefined;

    const payload = await inProject(c, deps, async (tx, auth) => {
      const rows = await tx
        .update(services)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description ?? null } : {}),
          ...(durationTouched ? durationColumns(body) : {}),
          ...(body.capacity_per_booking !== undefined
            ? { capacityPerBooking: body.capacity_per_booking }
            : {}),
          ...(body.buffer_before !== undefined ? { bufferBeforeMinutes: body.buffer_before } : {}),
          ...(body.buffer_after !== undefined ? { bufferAfterMinutes: body.buffer_after } : {}),
          ...(body.slot_interval !== undefined
            ? { slotIntervalMinutes: body.slot_interval ?? null }
            : {}),
          ...(body.align_to !== undefined ? { alignTo: body.align_to ?? null } : {}),
          ...(body.price !== undefined
            ? {
                priceAmount: body.price?.amount ?? null,
                priceCurrency: body.price?.currency ?? null,
              }
            : {}),
          ...(body.pricing_rules !== undefined ? { pricingRules: body.pricing_rules } : {}),
          ...(body.policy_id !== undefined ? { policyId: body.policy_id ?? null } : {}),
          ...(body.booking_window !== undefined
            ? { bookingWindow: body.booking_window ?? null }
            : {}),
          ...(body.allow_recurring !== undefined ? { allowRecurring: body.allow_recurring } : {}),
          ...(body.allow_multi_day !== undefined ? { allowMultiDay: body.allow_multi_day } : {}),
          ...(body.buffer_sharing !== undefined ? { bufferSharing: body.buffer_sharing } : {}),
          ...(body.allow_split !== undefined ? { allowSplit: body.allow_split } : {}),
          ...(body.tenant_id !== undefined ? { tenantId: body.tenant_id ?? null } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(services.id, id), isNull(services.deletedAt)))
        .returning();
      const row = rows[0];
      if (!row) return null;
      // On the row the `UPDATE` produced, inside the transaction: throwing here rolls the write
      // back, so a `PATCH` that would leave rules without a price leaves nothing behind.
      assertPriceForRules(row.priceAmount, row.pricingRules as readonly unknown[]);
      if (body.requirements !== undefined) {
        await replaceRequirements(tx, auth, id, body.requirements);
      }
      return firstRow(await serializeServices(tx, [row], expand));
    });
    if (!payload) throw errors.notFound('service', c.req.param('id') ?? '');
    return c.json(payload);
  });

  /** Soft delete: past bookings must keep pointing at the service they were made for. */
  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'service', 'service');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .update(services)
        .set({ deletedAt: new Date() })
        .where(and(eq(services.id, id), isNull(services.deletedAt)))
        .returning({ id: services.id }),
    );
    if (!rows[0]) throw errors.notFound('service', c.req.param('id') ?? '');
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'service'));
  });

  return routes;
}
