import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { resourceGroupMembers, resourceGroups, resources, type Transaction } from '@bookrail/db';
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
import { resourceGroupCreateSchema, resourceGroupUpdateSchema } from '../schemas/index.js';
import { serializeResourceGroup } from '../serialize.js';
import type { ResourceGroup } from '../schemas/responses.js';

const EXPANDABLE = ['resources'] as const;

type GroupRow = typeof resourceGroups.$inferSelect;

async function membersByGroup(tx: Transaction, groupIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (groupIds.length === 0) return map;
  const rows = await tx
    .select({
      groupId: resourceGroupMembers.resourceGroupId,
      resourceId: resourceGroupMembers.resourceId,
    })
    .from(resourceGroupMembers)
    .where(inArray(resourceGroupMembers.resourceGroupId, groupIds))
    .orderBy(asc(resourceGroupMembers.priority), asc(resourceGroupMembers.id));
  for (const row of rows) {
    const bucket = map.get(row.groupId) ?? [];
    bucket.push(row.resourceId);
    map.set(row.groupId, bucket);
  }
  return map;
}

async function serializeGroups(
  tx: Transaction,
  rows: GroupRow[],
  expand: Set<string>,
): Promise<ResourceGroup[]> {
  const members = await membersByGroup(
    tx,
    rows.map((r) => r.id),
  );
  if (!expand.has('resources')) {
    return rows.map((row) => serializeResourceGroup(row, members.get(row.id) ?? []));
  }
  const allIds = [...new Set([...members.values()].flat())];
  const resourceRows = allIds.length
    ? await tx.select().from(resources).where(inArray(resources.id, allIds))
    : [];
  const byId = new Map(resourceRows.map((r) => [r.id, r]));
  return rows.map((row) => {
    const ids = members.get(row.id) ?? [];
    const expanded = ids.map((id) => byId.get(id)).filter((r) => r !== undefined);
    return serializeResourceGroup(row, ids, expanded);
  });
}

/** Members are replaced wholesale: a group is defined by the set of resources it contains. */
async function replaceMembers(
  tx: Transaction,
  auth: AuthContext,
  groupId: string,
  resourceIds: string[],
): Promise<void> {
  await tx.delete(resourceGroupMembers).where(eq(resourceGroupMembers.resourceGroupId, groupId));
  if (resourceIds.length === 0) return;

  const unique = [...new Set(resourceIds)];
  const found = await tx
    .select({ id: resources.id })
    .from(resources)
    .where(and(inArray(resources.id, unique), isNull(resources.deletedAt)));
  if (found.length !== unique.length) {
    throw errors.invalidRequest(
      'One or more resource_ids do not exist in this project and environment.',
      'resource_ids',
      'parameter_invalid',
    );
  }

  await tx.insert(resourceGroupMembers).values(
    unique.map((resourceId, index) => ({
      id: uuidv7(),
      projectId: auth.projectId,
      environment: auth.environment,
      resourceGroupId: groupId,
      resourceId,
      priority: index,
    })),
  );
}

export function resourceGroupsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, resourceGroupCreateSchema);
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx, auth) => {
      const row = firstRow(
        await tx
          .insert(resourceGroups)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            name: body.name,
            selector: body.selector ?? null,
            allocationStrategy: body.allocation_strategy ?? 'first_available',
            metadata: body.metadata ?? {},
          })
          .returning(),
      );
      await replaceMembers(tx, auth, row.id, body.resource_ids ?? []);
      return firstRow(await serializeGroups(tx, [row], expand));
    });
    return c.json(payload, 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'resource_group');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(resourceGroups)
        .where(startingAfter ? gt(resourceGroups.id, startingAfter) : undefined)
        .orderBy(asc(resourceGroups.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(await serializeGroups(tx, page, expand), hasMore);
    });
    return c.json(payload);
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'resource_group', 'resource group');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(resourceGroups).where(eq(resourceGroups.id, id)).limit(1);
      if (rows.length === 0) return null;
      return firstRow(await serializeGroups(tx, rows, expand));
    });
    if (!payload) throw errors.notFound('resource group', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'resource_group', 'resource group');
    const body = await parseJsonBody(c, resourceGroupUpdateSchema);
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx, auth) => {
      const rows = await tx
        .update(resourceGroups)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.selector !== undefined ? { selector: body.selector ?? null } : {}),
          ...(body.allocation_strategy !== undefined
            ? { allocationStrategy: body.allocation_strategy }
            : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          updatedAt: new Date(),
        })
        .where(eq(resourceGroups.id, id))
        .returning();
      const row = rows[0];
      if (!row) return null;
      if (body.resource_ids !== undefined) {
        await replaceMembers(tx, auth, id, body.resource_ids);
      }
      return firstRow(await serializeGroups(tx, [row], expand));
    });
    if (!payload) throw errors.notFound('resource group', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'resource_group', 'resource group');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .delete(resourceGroups)
        .where(eq(resourceGroups.id, id))
        .returning({ id: resourceGroups.id }),
    );
    if (!rows[0]) throw errors.notFound('resource group', c.req.param('id') ?? '');
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'resource_group'));
  });

  return routes;
}
