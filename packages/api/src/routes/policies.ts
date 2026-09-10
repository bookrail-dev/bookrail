import { Hono } from 'hono';
import { asc, eq, gt } from 'drizzle-orm';
import { policies } from '@bookrail/db';
import { errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  deletedEnvelope,
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseJsonBody,
  parseListParams,
  pathId,
} from '../http.js';
import { policyCreateSchema, policyUpdateSchema } from '../schemas/index.js';
import { serializePolicy } from '../serialize.js';

type PolicyPatch = Partial<{
  name: string;
  cancellation: unknown;
  reschedule: unknown;
  deposit: unknown;
  paymentTiming: 'at_booking' | 'before_start' | 'after_service' | 'none';
  paymentDeadline: string | null;
  noShow: unknown;
  holdDurationSeconds: number;
  maxActiveBookingsPerCustomer: number | null;
  requireCustomerConfirmation: boolean;
  requireProviderConfirmation: boolean;
  autoStart: boolean;
  autoComplete: boolean;
  maxReschedules: number | null;
  metadata: Record<string, unknown>;
}>;

export function policiesRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, policyCreateSchema);
    const row = await inProject(c, deps, async (tx, auth) =>
      firstRow(
        await tx
          .insert(policies)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            cancellation: body.cancellation ?? [],
            reschedule: body.reschedule ?? [],
            deposit: body.deposit ?? null,
            paymentTiming: body.payment_timing ?? 'none',
            paymentDeadline: body.payment_deadline ?? null,
            noShow: body.no_show ?? null,
            holdDurationSeconds: body.hold_duration_seconds ?? 600,
            maxActiveBookingsPerCustomer: body.max_active_bookings_per_customer ?? null,
            requireCustomerConfirmation: body.require_customer_confirmation ?? false,
            requireProviderConfirmation: body.require_provider_confirmation ?? false,
            autoStart: body.auto_start ?? false,
            autoComplete: body.auto_complete ?? false,
            maxReschedules: body.max_reschedules ?? null,
            metadata: body.metadata ?? {},
          })
          .returning(),
      ),
    );
    return c.json(serializePolicy(row), 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'policy');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .select()
        .from(policies)
        .where(startingAfter ? gt(policies.id, startingAfter) : undefined)
        .orderBy(asc(policies.id))
        .limit(limit + 1),
    );
    const { page, hasMore } = paginate(rows, limit);
    return c.json(listEnvelope(page.map(serializePolicy), hasMore));
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'policy', 'policy');
    const rows = await inProject(c, deps, async (tx) =>
      tx.select().from(policies).where(eq(policies.id, id)).limit(1),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('policy', c.req.param('id') ?? '');
    return c.json(serializePolicy(row));
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'policy', 'policy');
    const body = await parseJsonBody(c, policyUpdateSchema);
    const patch: PolicyPatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.cancellation !== undefined) patch.cancellation = body.cancellation;
    if (body.reschedule !== undefined) patch.reschedule = body.reschedule;
    if (body.deposit !== undefined) patch.deposit = body.deposit ?? null;
    if (body.payment_timing !== undefined) patch.paymentTiming = body.payment_timing;
    if (body.payment_deadline !== undefined) patch.paymentDeadline = body.payment_deadline ?? null;
    if (body.no_show !== undefined) patch.noShow = body.no_show ?? null;
    if (body.hold_duration_seconds !== undefined) {
      patch.holdDurationSeconds = body.hold_duration_seconds;
    }
    if (body.max_active_bookings_per_customer !== undefined) {
      patch.maxActiveBookingsPerCustomer = body.max_active_bookings_per_customer ?? null;
    }
    if (body.require_customer_confirmation !== undefined) {
      patch.requireCustomerConfirmation = body.require_customer_confirmation;
    }
    if (body.require_provider_confirmation !== undefined) {
      patch.requireProviderConfirmation = body.require_provider_confirmation;
    }
    if (body.auto_start !== undefined) patch.autoStart = body.auto_start;
    if (body.auto_complete !== undefined) patch.autoComplete = body.auto_complete;
    if (body.max_reschedules !== undefined) patch.maxReschedules = body.max_reschedules ?? null;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    const rows = await inProject(c, deps, async (tx) =>
      tx.update(policies).set(patch).where(eq(policies.id, id)).returning(),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('policy', c.req.param('id') ?? '');
    return c.json(serializePolicy(row));
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'policy', 'policy');
    const rows = await inProject(c, deps, async (tx) =>
      tx.delete(policies).where(eq(policies.id, id)).returning({ id: policies.id }),
    );
    if (!rows[0]) throw errors.notFound('policy', c.req.param('id') ?? '');
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'policy'));
  });

  return routes;
}
