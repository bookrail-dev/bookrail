import { Hono } from 'hono';
import { asc, eq, gt } from 'drizzle-orm';
import { locations, resources } from '@bookrail/db';
import { detectOrphanedBookings } from '@bookrail/engine';
import { errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseJsonBody,
  parseListParams,
  pathId,
  deletedEnvelope,
} from '../http.js';
import { invalidateResources } from '../cache.js';
import { locationCreateSchema, locationUpdateSchema } from '../schemas/index.js';
import { serializeLocation } from '../serialize.js';

export function locationsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, locationCreateSchema);
    const row = await inProject(c, deps, async (tx, auth) =>
      firstRow(
        await tx
          .insert(locations)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            timezone: body.timezone,
            address: body.address ?? null,
            tenantId: body.tenant_id ?? auth.tenantId,
            metadata: body.metadata ?? {},
          })
          .returning(),
      ),
    );
    return c.json(serializeLocation(row), 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'location');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .select()
        .from(locations)
        .where(startingAfter ? gt(locations.id, startingAfter) : undefined)
        .orderBy(asc(locations.id))
        .limit(limit + 1),
    );
    const { page, hasMore } = paginate(rows, limit);
    return c.json(listEnvelope(page.map(serializeLocation), hasMore));
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'location', 'location');
    const rows = await inProject(c, deps, async (tx) =>
      tx.select().from(locations).where(eq(locations.id, id)).limit(1),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('location', c.req.param('id') ?? '');
    return c.json(serializeLocation(row));
  });

  /**
   * A Location carries the time zone of every resource that has no schedule of its own, so a
   * `PATCH` here can move the open timeline of resources this route never mentions. They are
   * all dropped from the availability cache: reasoning field by
   * field would mean deciding whether `timezone` was the field that really changed, and the
   * cheap, always-correct answer is to drop them.
   */
  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'location', 'location');
    const body = await parseJsonBody(c, locationUpdateSchema);
    const affected: string[] = [];
    const rows = await inProject(c, deps, async (tx, auth) => {
      const updated = await tx
        .update(locations)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          ...(body.address !== undefined ? { address: body.address ?? null } : {}),
          ...(body.tenant_id !== undefined ? { tenantId: body.tenant_id ?? null } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        })
        .where(eq(locations.id, id))
        .returning();
      if (updated.length === 0) return updated;
      affected.push(
        ...(
          await tx.select({ id: resources.id }).from(resources).where(eq(resources.locationId, id))
        ).map((resource) => resource.id),
      );
      // Moving a Location's time zone moves the opening hours of every resource whose schedule
      // carries none of its own (`COALESCE(s.timezone, l.timezone)`), so it can leave a
      // future booking outside them just as a schedule change can. `PATCH /v1/schedules/{id}`
      // ran the orphan detection for exactly that reason and this route did not, which was an
      // asymmetry rather than a decision. Nothing else a Location
      // carries touches the calendar, so the check runs only for `timezone`.
      if (body.timezone !== undefined) {
        await detectOrphanedBookings(tx, {
          projectId: auth.projectId,
          environment: auth.environment,
          resourceIds: affected,
          now: Date.now(),
        });
      }
      return updated;
    });
    const row = rows[0];
    if (!row) throw errors.notFound('location', c.req.param('id') ?? '');
    await invalidateResources(deps, affected);
    return c.json(serializeLocation(row));
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'location', 'location');
    const rows = await inProject(c, deps, async (tx) =>
      tx.delete(locations).where(eq(locations.id, id)).returning({ id: locations.id }),
    );
    if (!rows[0]) throw errors.notFound('location', c.req.param('id') ?? '');
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'location'));
  });

  return routes;
}
