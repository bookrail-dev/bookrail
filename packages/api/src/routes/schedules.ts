import { Hono } from 'hono';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import {
  resources,
  scheduleExceptions,
  scheduleRules,
  schedules,
  type Transaction,
} from '@bookrail/db';
import { detectOrphanedBookings, type OrphanedBooking } from '@bookrail/engine';
import { errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv, AuthContext } from '../context.js';
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
import {
  scheduleCreateSchema,
  scheduleExceptionCreateSchema,
  scheduleUpdateSchema,
} from '../schemas/index.js';
import { invalidateResources } from '../cache.js';
import { serializeSchedule, serializeScheduleException } from '../serialize.js';

/**
 * The resources whose open timeline this schedule decides.
 *
 * Every write to a schedule, to its rules or to its exceptions changes the `avail:open:…`
 * entries of all of them, and the cache is keyed by resource, not by schedule: the fan-out has
 * to happen here.
 */
async function resourceIdsOfSchedule(tx: Transaction, scheduleId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.scheduleId, scheduleId));
  return rows.map((row) => row.id);
}

type ScheduleRow = typeof schedules.$inferSelect;
type RuleRow = typeof scheduleRules.$inferSelect;
type ExceptionRow = typeof scheduleExceptions.$inferSelect;

type RuleInput = {
  days_of_week: number[];
  start_time: string;
  end_time: string;
  valid_from?: string | null | undefined;
  valid_until?: string | null | undefined;
};

async function loadChildren(
  tx: Transaction,
  scheduleIds: string[],
): Promise<{ rules: Map<string, RuleRow[]>; exceptions: Map<string, ExceptionRow[]> }> {
  const rules = new Map<string, RuleRow[]>();
  const exceptions = new Map<string, ExceptionRow[]>();
  if (scheduleIds.length === 0) return { rules, exceptions };

  const ruleRows = await tx
    .select()
    .from(scheduleRules)
    .where(inArray(scheduleRules.scheduleId, scheduleIds))
    .orderBy(asc(scheduleRules.startTime), asc(scheduleRules.id));
  for (const row of ruleRows) {
    const bucket = rules.get(row.scheduleId) ?? [];
    bucket.push(row);
    rules.set(row.scheduleId, bucket);
  }

  const exceptionRows = await tx
    .select()
    .from(scheduleExceptions)
    .where(inArray(scheduleExceptions.scheduleId, scheduleIds))
    .orderBy(asc(scheduleExceptions.date), asc(scheduleExceptions.id));
  for (const row of exceptionRows) {
    const bucket = exceptions.get(row.scheduleId) ?? [];
    bucket.push(row);
    exceptions.set(row.scheduleId, bucket);
  }

  return { rules, exceptions };
}

async function insertRules(
  tx: Transaction,
  auth: AuthContext,
  scheduleId: string,
  rules: RuleInput[],
): Promise<void> {
  if (rules.length === 0) return;
  await tx.insert(scheduleRules).values(
    rules.map((rule) => ({
      id: uuidv7(),
      projectId: auth.projectId,
      environment: auth.environment,
      scheduleId,
      daysOfWeek: rule.days_of_week,
      startTime: rule.start_time,
      endTime: rule.end_time,
      validFrom: rule.valid_from ?? null,
      validUntil: rule.valid_until ?? null,
    })),
  );
}

async function serializeOne(tx: Transaction, row: ScheduleRow): Promise<Record<string, unknown>> {
  const { rules, exceptions } = await loadChildren(tx, [row.id]);
  return serializeSchedule(row, rules.get(row.id) ?? [], exceptions.get(row.id) ?? []);
}

export function schedulesRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, scheduleCreateSchema);
    const payload = await inProject(c, deps, async (tx, auth) => {
      const row = firstRow(
        await tx
          .insert(schedules)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            timezone: body.timezone ?? null,
            metadata: body.metadata ?? {},
          })
          .returning(),
      );
      await insertRules(tx, auth, row.id, body.rules ?? []);
      return serializeOne(tx, row);
    });
    return c.json(payload, 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'schedule');
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(schedules)
        .where(startingAfter ? gt(schedules.id, startingAfter) : undefined)
        .orderBy(asc(schedules.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      const { rules, exceptions } = await loadChildren(
        tx,
        page.map((r) => r.id),
      );
      return listEnvelope(
        page.map((row) =>
          serializeSchedule(row, rules.get(row.id) ?? [], exceptions.get(row.id) ?? []),
        ),
        hasMore,
      );
    });
    return c.json(payload);
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'schedule', 'schedule');
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(schedules).where(eq(schedules.id, id)).limit(1);
      const row = rows[0];
      if (!row) return null;
      return serializeOne(tx, row);
    });
    if (!payload) throw errors.notFound('schedule', c.req.param('id') ?? '');
    return c.json(payload);
  });

  /** `rules` is a full replacement when present: a schedule is one coherent set of rules. */
  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'schedule', 'schedule');
    const body = await parseJsonBody(c, scheduleUpdateSchema);
    const affected: string[] = [];
    const orphaned: OrphanedBooking[] = [];
    const payload = await inProject(c, deps, async (tx, auth) => {
      const rows = await tx
        .update(schedules)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone ?? null } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schedules.id, id))
        .returning();
      const row = rows[0];
      if (!row) return null;
      if (body.rules !== undefined) {
        await tx.delete(scheduleRules).where(eq(scheduleRules.scheduleId, id));
        await insertRules(tx, auth, id, body.rules);
      }
      affected.push(...(await resourceIdsOfSchedule(tx, id)));
      // In the same transaction as the change, and after it: a booking the new calendar no
      // longer supports gets a `booking.orphaned` event, and is otherwise left exactly as it
      // is: a booking is a commitment to a customer, and no calendar edit may break one in
      // silence.
      //
      // Only `rules` and `timezone` move the calendar; a rename or a metadata change cannot
      // orphan anything, and running the detection for one is pure cost inside the
      // transaction.
      if (body.rules !== undefined || body.timezone !== undefined) {
        orphaned.push(
          ...(await detectOrphanedBookings(tx, {
            projectId: auth.projectId,
            environment: auth.environment,
            resourceIds: affected,
            now: Date.now(),
          })),
        );
      }
      return serializeOne(tx, row);
    });
    if (!payload) throw errors.notFound('schedule', c.req.param('id') ?? '');
    await invalidateResources(deps, affected);
    return c.json(payload);
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'schedule', 'schedule');
    const affected: string[] = [];
    const rows = await inProject(c, deps, async (tx, auth) => {
      affected.push(...(await resourceIdsOfSchedule(tx, id)));
      const deleted = await tx
        .delete(schedules)
        .where(eq(schedules.id, id))
        .returning({ id: schedules.id });
      if (deleted.length > 0) {
        // `resources.schedule_id` is `ON DELETE SET NULL`, so every resource that followed
        // this schedule now follows none: every future booking on it is orphaned.
        await detectOrphanedBookings(tx, {
          projectId: auth.projectId,
          environment: auth.environment,
          resourceIds: affected,
          now: Date.now(),
        });
      }
      return deleted;
    });
    if (!rows[0]) throw errors.notFound('schedule', c.req.param('id') ?? '');
    await invalidateResources(deps, affected);
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'schedule'));
  });

  routes.post('/:id/exceptions', async (c) => {
    const scheduleId = pathId(c, 'schedule', 'schedule');
    const body = await parseJsonBody(c, scheduleExceptionCreateSchema);
    const affected: string[] = [];
    const row = await inProject(c, deps, async (tx, auth) => {
      const parent = await tx
        .select({ id: schedules.id })
        .from(schedules)
        .where(eq(schedules.id, scheduleId))
        .limit(1);
      if (!parent[0]) return null;
      affected.push(...(await resourceIdsOfSchedule(tx, scheduleId)));
      const created = firstRow(
        await tx
          .insert(scheduleExceptions)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            scheduleId,
            date: body.date,
            type: body.type,
            startTime: body.start_time ?? null,
            endTime: body.end_time ?? null,
            reason: body.reason ?? null,
          })
          .returning(),
      );
      await detectOrphanedBookings(tx, {
        projectId: auth.projectId,
        environment: auth.environment,
        resourceIds: affected,
        now: Date.now(),
      });
      return created;
    });
    if (!row) throw errors.notFound('schedule', c.req.param('id') ?? '');
    await invalidateResources(deps, affected);
    return c.json(serializeScheduleException(row), 201);
  });

  routes.delete('/:id/exceptions/:eid', async (c) => {
    const scheduleId = pathId(c, 'schedule', 'schedule');
    const exceptionId = pathId(c, 'schedule_exception', 'schedule exception', 'eid');
    const affected: string[] = [];
    const rows = await inProject(c, deps, async (tx, auth) => {
      affected.push(...(await resourceIdsOfSchedule(tx, scheduleId)));
      const deleted = await tx
        .delete(scheduleExceptions)
        .where(
          and(
            eq(scheduleExceptions.id, exceptionId),
            eq(scheduleExceptions.scheduleId, scheduleId),
          ),
        )
        .returning({ id: scheduleExceptions.id });
      if (deleted.length > 0) {
        // Removing an `open` exception can close a day that only that exception opened.
        await detectOrphanedBookings(tx, {
          projectId: auth.projectId,
          environment: auth.environment,
          resourceIds: affected,
          now: Date.now(),
        });
      }
      return deleted;
    });
    if (!rows[0]) throw errors.notFound('schedule exception', c.req.param('eid') ?? '');
    await invalidateResources(deps, affected);
    return c.json(deletedEnvelope(c.req.param('eid') ?? '', 'schedule_exception'));
  });

  return routes;
}
