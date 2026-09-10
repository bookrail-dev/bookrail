import type { ApiResponse, ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { durationShape } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { clientFor, readBody, type BodyOptions } from './helpers.js';

export interface EntityDescriptor {
  /** The command name, as an agent types it. Always one of {@link OBJECT_KINDS}. */
  command: ObjectKind;
  /** The API collection. */
  path: string;
  /** Singular, for messages. */
  singular: string;
  /** Values `expand[]` accepts here, each inlining a linked object into the answer. */
  expandable: string[];
  /**
   * Columns of the human table, as [header, field] pairs. A field name that is not a column of
   * the object is looked up in {@link DERIVED} instead, which is how `services` shows one
   * `duration` cell for three mutually exclusive columns.
   */
  columns: [string, string][];
  /** Named in `bookrail schema <entity>`; null when the config has no such collection. */
  schemaKey: string | null;
}

/**
 * The collections `bookrail <entity> list|get|create|update|delete` covers, and the **single
 * source** for that list.
 *
 * Exactly the seven collections the API exposes plain create, read, update and delete for,
 * which is what exists today. `bookings`, `holds`, `availability`, `webhooks`, `events` and the
 * sub-resources (`resources blocks`, `schedules exceptions`) are operational commands and are
 * built elsewhere.
 *
 * The MCP server's `bookrail_object_*` tools take the collection as a closed enum, and they
 * used to carry their own copy of these seven strings (`OBJECT_KINDS` in
 * `packages/mcp/src/tools/objects.ts`). Two lists that must agree and a test that checks they
 * do is one list too many, so the enum is exported from here, through `bookrail`'s public
 * entry point, and {@link ENTITIES} is *built* from it: adding a collection to this array
 * without describing it is a compile error, and describing one that is not in it is too.
 */
export const OBJECT_KINDS = [
  'locations',
  'resources',
  'resource_groups',
  'schedules',
  'services',
  'policies',
  'customers',
] as const;

/** One of the collections `bookrail_object_*` and `bookrail <entity>` act on. */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

const DESCRIPTORS: Record<ObjectKind, Omit<EntityDescriptor, 'command'>> = {
  locations: {
    path: '/v1/locations',
    singular: 'location',
    expandable: [],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['timezone', 'timezone'],
    ],
    schemaKey: 'locations',
  },
  resources: {
    path: '/v1/resources',
    singular: 'resource',
    expandable: ['schedule'],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['type', 'type'],
      ['capacity', 'capacity'],
      ['status', 'status'],
    ],
    schemaKey: 'resources',
  },
  resource_groups: {
    path: '/v1/resource_groups',
    singular: 'resource group',
    expandable: ['resources'],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['strategy', 'allocation_strategy'],
    ],
    schemaKey: 'resourceGroups',
  },
  schedules: {
    path: '/v1/schedules',
    singular: 'schedule',
    expandable: [],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['timezone', 'timezone'],
    ],
    schemaKey: 'schedules',
  },
  services: {
    path: '/v1/services',
    singular: 'service',
    expandable: ['requirements'],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      // Not `duration`: a service declares exactly one of `duration`, `duration_options` and
      // `duration_range`, so the plain column is empty for two services out of three.
      ['duration', '@duration'],
      ['grid', '@grid'],
      ['policy', 'policy_id'],
    ],
    schemaKey: 'services',
  },
  policies: {
    path: '/v1/policies',
    singular: 'policy',
    expandable: [],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['hold', 'hold_duration_seconds'],
    ],
    schemaKey: 'policies',
  },
  customers: {
    path: '/v1/customers',
    singular: 'customer',
    expandable: [],
    columns: [
      ['id', 'id'],
      ['name', 'name'],
      ['email', 'email'],
      ['external_id', 'external_id'],
    ],
    schemaKey: null,
  },
};

export const ENTITIES: EntityDescriptor[] = OBJECT_KINDS.map((command) => ({
  command,
  ...DESCRIPTORS[command],
}));

export function entityByCommand(command: string): EntityDescriptor {
  const entity = ENTITIES.find((candidate) => candidate.command === command);
  if (!entity) {
    throw new CliError('unknown_entity', `No entity named "${command}".`, {
      fix: `Use one of: ${ENTITIES.map((candidate) => candidate.command).join(', ')}.`,
    });
  }
  return entity;
}

export interface ListOptions {
  limit?: string;
  startingAfter?: string;
  expand?: string[];
  all?: boolean;
}

export async function listEntities(
  ctx: Context,
  entity: EntityDescriptor,
  options: ListOptions,
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const expand = options.expand ?? [];

  if (options.all === true) {
    const rows = await client.listAll<{ id: string }>(entity.path, { expand });
    return listResult(ctx, entity, rows as Record<string, unknown>[], false, null);
  }

  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new CliError('parameter_invalid', '--limit must be an integer between 1 and 100.', {
      param: 'limit',
      fix: 'Pass a value between 1 and 100, or `--all` to follow the cursor to the end.',
    });
  }

  const response = await client.get<ListEnvelope<Record<string, unknown>>>(entity.path, {
    expand,
    query: { limit, starting_after: options.startingAfter },
  });
  const data = response.data;
  const last = data.data.at(-1);
  return listResult(
    ctx,
    entity,
    data.data,
    data.has_more,
    typeof last?.id === 'string' ? last.id : null,
  );
}

function listResult(
  ctx: Context,
  entity: EntityDescriptor,
  rows: Record<string, unknown>[],
  hasMore: boolean,
  cursor: string | null,
): CommandResult {
  const table = renderTable(
    entity.columns.map(([header]) => header),
    rows.map((row) => entity.columns.map(([, field]) => truncate(cell(row, field), 40))),
  );
  const nextSteps: string[] = [];
  if (hasMore && cursor !== null) {
    nextSteps.push(`Next page: \`bookrail ${entity.command} list --starting-after ${cursor}\`.`);
  }
  return {
    data: { object: 'list', data: rows, has_more: hasMore, next_cursor: hasMore ? cursor : null },
    human:
      rows.length === 0
        ? `${ctx.presenter.badge()} no ${entity.command}.`
        : `${ctx.presenter.badge()} ${rows.length} ${entity.command}\n\n${table}`,
    nextSteps,
  };
}

/**
 * Cells that are computed from several columns rather than read from one.
 *
 * Keyed by the `@name` used in {@link EntityDescriptor.columns}; the `@` cannot collide with an
 * API field name, so a derived cell and a real one are never confused.
 */
const DERIVED: Record<string, (row: Record<string, unknown>) => string> = {
  '@duration': durationShape,
  '@grid': (row) => {
    const interval = row.slot_interval;
    const align = row.align_to;
    const parts: string[] = [];
    if (typeof interval === 'number') parts.push(`every ${String(interval)}m`);
    if (typeof align === 'string') parts.push(`from ${align}`);
    return parts.length === 0 ? 'free' : parts.join(', ');
  },
};

function cell(row: Record<string, unknown>, field: string): string {
  const derived = DERIVED[field];
  return derived === undefined ? display(row[field]) : derived(row);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export async function getEntity(
  ctx: Context,
  entity: EntityDescriptor,
  id: string,
  options: { expand?: string[] },
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const response = (await client.get(`${entity.path}/${encodeURIComponent(id)}`, {
    expand: options.expand ?? [],
  })) as ApiResponse<Record<string, unknown>>;
  return { data: response.data };
}

export async function createEntity(
  ctx: Context,
  entity: EntityDescriptor,
  options: BodyOptions,
): Promise<CommandResult> {
  const body = await readBody(ctx, options, `creating a ${entity.singular}`);
  const client = await clientFor(ctx);
  const response = (await client.post(entity.path, body)) as ApiResponse<Record<string, unknown>>;
  return {
    data: response.data,
    human: `${ctx.presenter.badge()} created ${entity.singular} ${String(response.data.id)}`,
    nextSteps: [
      `Read it back with \`bookrail ${entity.command} get ${String(response.data.id)} --json\`.`,
    ],
  };
}

export async function updateEntity(
  ctx: Context,
  entity: EntityDescriptor,
  id: string,
  options: BodyOptions,
): Promise<CommandResult> {
  const body = await readBody(ctx, options, `updating a ${entity.singular}`);
  const client = await clientFor(ctx);
  const response = (await client.patch(
    `${entity.path}/${encodeURIComponent(id)}`,
    body,
  )) as ApiResponse<Record<string, unknown>>;
  return {
    data: response.data,
    human: `${ctx.presenter.badge()} updated ${entity.singular} ${id}`,
  };
}

/**
 * `DELETE`, behind `--yes`.
 *
 * The confirmation is part of the contract, not a nicety: an agent that retries a command must
 * not be able to delete a service because the flag was optional.
 */
export async function deleteEntity(
  ctx: Context,
  entity: EntityDescriptor,
  id: string,
  options: { yes?: boolean },
): Promise<CommandResult> {
  if (options.yes !== true) {
    throw new CliError('confirmation_required', `Deleting ${entity.singular} ${id} needs --yes.`, {
      fix: `Run \`bookrail ${entity.command} delete ${id} --yes\`.`,
    });
  }
  const client = await clientFor(ctx);
  const response = (await client.delete(`${entity.path}/${encodeURIComponent(id)}`)) as ApiResponse<
    Record<string, unknown>
  >;
  return {
    data: response.data,
    human: `${ctx.presenter.badge()} deleted ${entity.singular} ${id}`,
  };
}
