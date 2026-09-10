import { Hono } from 'hono';
import { and, asc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import {
  locations,
  resourceBlocks,
  resources,
  scheduleExceptions,
  scheduleRules,
  schedules,
  tstzrangeLiteral,
  type Transaction,
} from '@bookrail/db';
import { encodeId, errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  deletedEnvelope,
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseExpand,
  parseJsonBody,
  parseListParams,
  parseQuery,
  pathId,
} from '../http.js';
import {
  resourceBlockListQuerySchema,
  resourceBlockSchema,
  resourceCreateSchema,
  resourceUnblockSchema,
  resourceUpdateSchema,
} from '../schemas/index.js';
import { detectOrphanedBookings, releaseOccupancies, takeOccupancy } from '@bookrail/engine';
import { invalidateResourcePeriod, invalidateResources } from '../cache.js';
import { serializeResource, serializeResourceBlock } from '../serialize.js';
import type { Resource } from '../schemas/responses.js';

const EXPANDABLE = ['schedule'] as const;

/**
 * A `timestamptz` computed by an expression, as a `Date`.
 *
 * The driver hands raw text back for anything that is not a declared column: Drizzle installs
 * its own type parsers and decodes per column, so `lower(period)`, which has no column to
 * decode against, arrives as a string. `mapWith` is where that decision is made explicit,
 * once, instead of every call site remembering to wrap the value.
 */
function instantOf(expression: SQL): SQL.Aliased<Date> {
  return expression.mapWith((value) => new Date(value as string)).as('instant');
}

type ResourceRow = typeof resources.$inferSelect;

async function withExpansions(
  tx: Transaction,
  rows: ResourceRow[],
  expand: Set<string>,
): Promise<Resource[]> {
  if (!expand.has('schedule')) return rows.map((row) => serializeResource(row));

  const out: Resource[] = [];
  for (const row of rows) {
    if (!row.scheduleId) {
      out.push(serializeResource(row, { schedule: null }));
      continue;
    }
    const scheduleRow = (
      await tx.select().from(schedules).where(eq(schedules.id, row.scheduleId)).limit(1)
    )[0];
    if (!scheduleRow) {
      out.push(serializeResource(row, { schedule: null }));
      continue;
    }
    const rules = await tx
      .select()
      .from(scheduleRules)
      .where(eq(scheduleRules.scheduleId, scheduleRow.id))
      .orderBy(asc(scheduleRules.startTime), asc(scheduleRules.id));
    const exceptions = await tx
      .select()
      .from(scheduleExceptions)
      .where(eq(scheduleExceptions.scheduleId, scheduleRow.id))
      .orderBy(asc(scheduleExceptions.date));
    out.push(
      serializeResource(row, {
        schedule: scheduleRow,
        scheduleRules: rules,
        scheduleExceptions: exceptions,
      }),
    );
  }
  return out;
}

export function resourcesRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, resourceCreateSchema);
    const row = await inProject(c, deps, async (tx, auth) =>
      firstRow(
        await tx
          .insert(resources)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            type: body.type ?? 'staff',
            locationId: body.location_id ?? null,
            scheduleId: body.schedule_id ?? null,
            capacity: body.capacity ?? 1,
            attributes: body.attributes ?? {},
            status: body.status ?? 'active',
            tenantId: body.tenant_id ?? auth.tenantId,
            metadata: body.metadata ?? {},
          })
          .returning(),
      ),
    );
    return c.json(serializeResource(row), 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'resource');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(resources)
        .where(
          and(
            isNull(resources.deletedAt),
            startingAfter ? gt(resources.id, startingAfter) : undefined,
          ),
        )
        .orderBy(asc(resources.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(await withExpansions(tx, page, expand), hasMore);
    });
    return c.json(payload);
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'resource', 'resource');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(resources)
        .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
        .limit(1);
      if (rows.length === 0) return null;
      return (await withExpansions(tx, rows, expand))[0] ?? null;
    });
    if (!payload) throw errors.notFound('resource', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'resource', 'resource');
    const body = await parseJsonBody(c, resourceUpdateSchema);
    const rows = await inProject(c, deps, async (tx, auth) => {
      const updated = await tx
        .update(resources)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.location_id !== undefined ? { locationId: body.location_id ?? null } : {}),
          ...(body.schedule_id !== undefined ? { scheduleId: body.schedule_id ?? null } : {}),
          ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
          ...(body.attributes !== undefined ? { attributes: body.attributes } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.tenant_id !== undefined ? { tenantId: body.tenant_id ?? null } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        })
        .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
        .returning();
      // Only the fields that move the calendar can orphan anything: a rename or a metadata
      // change cannot, and running the detection for one cost 35 ms on a resource with 69
      // future bookings, inside the transaction, holding the row lock. `name`, `type`,
      // `attributes`, `tenant_id` and `metadata` are therefore not in this list, and skipping
      // them is not an optimisation of the check but a statement about what the check is for.
      const movesCalendar =
        body.capacity !== undefined ||
        body.status !== undefined ||
        body.schedule_id !== undefined ||
        body.location_id !== undefined;
      if (updated.length > 0 && movesCalendar) {
        await detectOrphanedBookings(tx, {
          projectId: auth.projectId,
          environment: auth.environment,
          resourceIds: [id],
          now: Date.now(),
        });
      }
      return updated;
    });
    const row = rows[0];
    if (!row) throw errors.notFound('resource', c.req.param('id') ?? '');
    // Capacity, schedule, location and status all move the resource's open timeline, and a
    // PATCH may carry any of them: the whole resource is dropped from the availability cache
    // rather than reasoned about field by field: the cache is keyed by (resource, local day)
    // and a cached day the write invalidated too widely is only recomputed once.
    await invalidateResources(deps, [id]);
    return c.json(serializeResource(row));
  });

  /** Soft delete: bookings and occupancies keep referring to the resource. */
  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'resource', 'resource');
    const rows = await inProject(c, deps, async (tx, auth) => {
      const deleted = await tx
        .update(resources)
        .set({ deletedAt: new Date(), status: 'inactive' })
        .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
        .returning({ id: resources.id });
      if (deleted.length > 0) {
        await detectOrphanedBookings(tx, {
          projectId: auth.projectId,
          environment: auth.environment,
          resourceIds: [id],
          now: Date.now(),
        });
      }
      return deleted;
    });
    if (!rows[0]) throw errors.notFound('resource', c.req.param('id') ?? '');
    await invalidateResources(deps, [id]);
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'resource'));
  });

  /**
   * Blocks a period without touching the schedule (holidays, maintenance).
   * The block also writes an occupancy, so the availability engine and the capacity-1
   * exclusion constraint see it exactly like a booking.
   */
  routes.post('/:id/block', async (c) => {
    const resourceId = pathId(c, 'resource', 'resource');
    const body = await parseJsonBody(c, resourceBlockSchema);
    const period = tstzrangeLiteral(body.from, body.to);

    const block = await inProject(c, deps, async (tx, auth) => {
      const resourceRows = await tx
        .select({
          id: resources.id,
          capacity: resources.capacity,
          scheduleTimezone: schedules.timezone,
          locationTimezone: locations.timezone,
        })
        .from(resources)
        .leftJoin(schedules, eq(schedules.id, resources.scheduleId))
        .leftJoin(locations, eq(locations.id, resources.locationId))
        .where(and(eq(resources.id, resourceId), isNull(resources.deletedAt)))
        .limit(1);
      const resource = resourceRows[0];
      if (!resource) return null;

      const inserted = firstRow(
        await tx
          .insert(resourceBlocks)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            resourceId,
            period,
            reason: body.reason ?? null,
            metadata: body.metadata ?? {},
          })
          .returning({
            id: resourceBlocks.id,
            createdAt: resourceBlocks.createdAt,
            updatedAt: resourceBlocks.updatedAt,
          }),
      );

      // The block goes through the same door as a booking (`takeOccupancy`): advisory lock on
      // the resource, expired holds swept, capacity verified, and only then the row. Writing
      // the occupancy here by hand is what let a block push a resource of capacity three to
      // four units taken: `occ_no_overlap_cap1` only covers capacity 1, and this route never
      // crossed the booking transaction.
      //
      // The semantics, decided deliberately: a block does **not** override existing
      // bookings. It takes the whole capacity of the resource, so anything already occupying
      // it (a booking, a live hold, another block) makes this a 409 `slot_unavailable`.
      // Closing a flooded room means cancelling its bookings first.
      await takeOccupancy(tx, {
        projectId: auth.projectId,
        environment: auth.environment,
        resourceIds: [resourceId],
        allocations: [{ resourceId, capacityUsed: resource.capacity }],
        start: body.from.getTime(),
        end: body.to.getTime(),
        kind: 'block',
        refId: inserted.id,
        capacities: new Map([[resourceId, resource.capacity]]),
      });

      // A block cannot orphan anything **today**: `takeOccupancy` takes the whole capacity of
      // the resource, so a block over a booked period is refused with 409 before reaching
      // here. The check is wired in anyway, because that is a property of the current block
      // semantics and not of the orphan rule, and a future overriding block would otherwise
      // silently break bookings.
      await detectOrphanedBookings(tx, {
        projectId: auth.projectId,
        environment: auth.environment,
        resourceIds: [resourceId],
        now: Date.now(),
      });

      return {
        id: inserted.id,
        resourceId,
        timezone: resource.scheduleTimezone ?? resource.locationTimezone ?? null,
        from: body.from,
        to: body.to,
        reason: body.reason ?? null,
        metadata: body.metadata ?? {},
        environment: auth.environment,
        createdAt: inserted.createdAt,
        updatedAt: inserted.updatedAt,
      };
    });

    if (!block) throw errors.notFound('resource', c.req.param('id') ?? '');
    // A block is bounded in time: only the days it covers lose their cached timeline.
    await invalidateResourcePeriod(deps, resourceId, block.timezone, body.from, body.to);
    return c.json(serializeResourceBlock(block), 201);
  });

  /**
   * `GET /v1/resources/{id}/blocks`.
   *
   * The read that `POST /.../block` and `POST /.../unblock` were missing: unblocking needs the
   * `blk_…` the creation returned once, and until now losing it meant the block could not be
   * removed at all.
   *
   * **Ordered by start, not by id.** Every other list here paginates on `id` because a v7 uuid
   * is chronological and "creation order" is the useful order. A block is a period, and the
   * question asked of this list is "what is closed, and when", so the order is `lower(period)`
   * with the id as the tie-break, and the cursor resolves `starting_after` to *that* pair.
   * `(start, id)` is a total order fixed at write time, which is what a cursor needs.
   *
   * **The default window.** With neither `from` nor `to`, the answer is the blocks that have
   * not finished yet (`upper(period) >= now()`): the caller who is looking for a block to
   * remove is looking at the future, and a club that has closed for maintenance every August
   * since 2019 should not have to page through six of them. Naming either bound turns the
   * default off, because a caller who names a window means that window.
   */
  routes.get('/:id/blocks', async (c) => {
    const resourceId = pathId(c, 'resource', 'resource');
    const { limit, startingAfter } = parseListParams(c, 'resource_block');
    const window = parseQuery(c, resourceBlockListQuerySchema);
    const from = window.from ?? (window.to === undefined ? new Date() : undefined);

    const payload = await inProject(c, deps, async (tx) => {
      const resourceRows = await tx
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.id, resourceId), isNull(resources.deletedAt)))
        .limit(1);
      if (resourceRows.length === 0) return null;

      let after: { from: Date; id: string } | null = null;
      if (startingAfter !== null) {
        const cursorRows = await tx
          .select({ from: instantOf(sql`lower(${resourceBlocks.period})`), id: resourceBlocks.id })
          .from(resourceBlocks)
          .where(
            and(eq(resourceBlocks.id, startingAfter), eq(resourceBlocks.resourceId, resourceId)),
          )
          .limit(1);
        // A cursor from another project, or from another resource, is invisible: an empty page,
        // the same answer `GET /v1/events` gives, and never a confirmation that an id exists.
        const row = cursorRows[0];
        if (row === undefined) return listEnvelope([], false);
        after = row;
      }

      const rows = await tx
        .select({
          id: resourceBlocks.id,
          from: instantOf(sql`lower(${resourceBlocks.period})`),
          to: instantOf(sql`upper(${resourceBlocks.period})`),
          reason: resourceBlocks.reason,
          metadata: resourceBlocks.metadata,
          environment: resourceBlocks.environment,
          createdAt: resourceBlocks.createdAt,
          updatedAt: resourceBlocks.updatedAt,
        })
        .from(resourceBlocks)
        .where(
          and(
            eq(resourceBlocks.resourceId, resourceId),
            from === undefined
              ? undefined
              : sql`upper(${resourceBlocks.period}) >= ${from.toISOString()}::timestamptz`,
            window.to === undefined
              ? undefined
              : sql`lower(${resourceBlocks.period}) < ${window.to.toISOString()}::timestamptz`,
            after === null
              ? undefined
              : sql`(lower(${resourceBlocks.period}), ${resourceBlocks.id}) > (${after.from.toISOString()}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(sql`lower(${resourceBlocks.period}) ASC`, asc(resourceBlocks.id))
        .limit(limit + 1);

      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(
        page.map((row) => serializeResourceBlock({ ...row, resourceId })),
        hasMore,
      );
    });

    if (!payload) throw errors.notFound('resource', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.post('/:id/unblock', async (c) => {
    const resourceId = pathId(c, 'resource', 'resource');
    const body = await parseJsonBody(c, resourceUnblockSchema);
    const removed = await inProject(c, deps, async (tx) => {
      const deleted = await tx
        .delete(resourceBlocks)
        .where(and(eq(resourceBlocks.id, body.block_id), eq(resourceBlocks.resourceId, resourceId)))
        .returning({ id: resourceBlocks.id });
      if (!deleted[0]) return null;
      // The last writer of `occupancies` outside the two doors of `occupancy.ts` used to be
      // right here: a bare `DELETE`, without the advisory lock.
      // It now releases like everything else (lock first, then `active = false`), and the row
      // survives as the record that the resource was once closed. `resource_blocks`, which is
      // the catalogue entry whose id the customer holds, is still deleted: that is the object
      // the caller asked to remove.
      await releaseOccupancies(tx, { refId: deleted[0].id, kind: 'block' });
      return deleted[0].id;
    });
    if (!removed)
      throw errors.notFound('resource block', encodeId('resource_block', body.block_id));
    // The deleted row no longer says which days it covered, so the resource is dropped whole.
    await invalidateResources(deps, [resourceId]);
    return c.json(deletedEnvelope(encodeId('resource_block', removed), 'resource_block'));
  });

  return routes;
}
