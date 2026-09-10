import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { entityByCommand, OBJECT_KINDS, type ObjectKind } from 'bookrail';
import { z } from 'zod';
import type { Workspace } from '../environment.js';
import { confirmArgument, environmentArgument, needsConfirmation, registerTool } from '../tool.js';

/**
 * The seven collections the API exposes plain create, read, update and delete for, spelled the
 * way the CLI spells them, because they **are** the CLI's subcommand names, taken from
 * `bookrail`'s public entry point rather than copied here.
 *
 * The copy was seven strings and a test that compared the two sets. It was not wrong, but a
 * derived list plus a test that it is derived correctly is strictly worse than one list: the
 * enum below is now the same array `bookrail <entity>` is built from, so a collection cannot
 * exist in one place and not the other. Two collections people ask for, `entitlements` and
 * `waitlist`, are in neither list, because the API has no such endpoints yet.
 */
export { OBJECT_KINDS };

const kindArgument = z.enum(OBJECT_KINDS).describe('Which collection to act on.');

/**
 * What `expand[]` accepts per collection, also read from the CLI's descriptors, so a new
 * expansion is declared once.
 */
const EXPANDABLE: Record<ObjectKind, string[]> = Object.fromEntries(
  OBJECT_KINDS.map((kind) => [kind, entityByCommand(kind).expandable]),
) as Record<ObjectKind, string[]>;

/**
 * Five tools instead of thirty-five.
 *
 * Create, read, update and delete are wanted on all seven collections. Written as one tool per
 * (collection × verb) that is thirty-five entries in `tools/list`, which every model has to
 * read before every decision, to describe seven variations of the same four operations. So the
 * collection is an argument with a closed enum: the model still sees exactly which collections
 * exist, and the list stays short enough to read.
 *
 * These are the escape hatch, not the main road. The way to build a model is
 * `bookrail_config_push`, which is declarative, idempotent and reviewable; these are for
 * reading ids back and for the one-off change that does not belong in a file.
 */
export function registerObjectTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_objects_list',
    title: 'List objects of one collection',
    description: [
      `Lists the objects of one collection: ${OBJECT_KINDS.join(', ')}.`,
      'Use it after `bookrail_config_push` to read back the ids the API assigned (`svc_...`, `res_...`): a configuration uses logical ids, and the prefixed ids only exist after a push. `metadata.config_id` on each object is the logical id it came from.',
      'Returns: `{ data: [...], has_more, next_cursor }`.',
      'Next: `bookrail_availability` with the `svc_` id of a service.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      kind: kindArgument,
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100.'),
      starting_after: z.string().optional().describe('Cursor: the id of the last row you saw.'),
      all: z
        .boolean()
        .default(false)
        .describe('Follow the cursor to the end and return everything.'),
      expand: z
        .array(z.string())
        .optional()
        .describe(
          'Linked objects to inline. resources: schedule. resource_groups: resources. services: requirements.',
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        args.kind,
        'list',
        ...(args.all ? ['--all'] : []),
        ...(args.limit === undefined ? [] : ['--limit', String(args.limit)]),
        ...(args.starting_after === undefined ? [] : ['--starting-after', args.starting_after]),
        ...(args.expand ?? EXPANDABLE[args.kind] ?? []).flatMap((value) => ['--expand', value]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [
          'Call bookrail_availability with the id of a service to check the model does what you meant.',
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_resource_blocks',
    title: 'List the closed periods of a resource',
    description: [
      'Lists the blocks on one resource: the periods it is closed for (holidays, maintenance) without the schedule saying so.',
      'Use it to find the `blk_...` of a block you want to lift, which is the only way to lift one, and to explain why a resource is unavailable on a day its schedule says it is open. Without `from`/`to` it returns the blocks that have not finished yet.',
      'Returns: `{ data: [{ id, resource_id, from, to, reason, metadata }], has_more, next_cursor }`. Instants are UTC.',
      'Next: `bookrail_explain_unavailable` if a block is not what you expected; the unblock itself is `POST /v1/resources/{id}/unblock` with the `blk_...`, which no tool wraps yet.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      resource_id: z.string().describe('The resource id (`res_...`).'),
      from: z
        .string()
        .optional()
        .describe('ISO 8601 instant with an offset. Blocks ending after it.'),
      to: z
        .string()
        .optional()
        .describe('ISO 8601 instant with an offset. Blocks starting before it.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100.'),
      starting_after: z
        .string()
        .optional()
        .describe('Cursor: the `blk_...` of the last row you saw.'),
      all: z
        .boolean()
        .default(false)
        .describe('Follow the cursor to the end and return everything.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'resources',
        'blocks',
        args.resource_id,
        ...(args.all ? ['--all'] : []),
        ...(args.from === undefined ? [] : ['--from', args.from]),
        ...(args.to === undefined ? [] : ['--to', args.to]),
        ...(args.limit === undefined ? [] : ['--limit', String(args.limit)]),
        ...(args.starting_after === undefined ? [] : ['--starting-after', args.starting_after]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_object_get',
    title: 'Read one object',
    description: [
      'Returns one object of one collection by its prefixed id.',
      'Use it to close the loop after a write, and to read `metadata.config_id` to find out whether an object is managed by a configuration.',
      'Returns: the object.',
      'Next: `bookrail_object_update`, or `bookrail_config_push` if the object is managed by a configuration. Editing a managed object outside the file makes the next push undo the change.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      kind: kindArgument,
      id: z.string().describe('The prefixed id, e.g. `svc_...`.'),
      expand: z.array(z.string()).optional().describe('Linked objects to inline.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        args.kind,
        'get',
        args.id,
        ...(args.expand ?? EXPANDABLE[args.kind] ?? []).flatMap((value) => ['--expand', value]),
      ]);
      return { ok: true, environment: ctx.environment, data: envelope.data };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_object_create',
    title: 'Create one object directly',
    description: [
      'Creates one object through the API, bypassing the configuration file.',
      'Prefer `bookrail_config_push`: an object created here carries no `metadata.config_id`, so a later push will never update or delete it, and it shows up as `unmanaged`. Use this for something genuinely outside the model: a customer, a one-off resource.',
      'The body uses the API field names (`location_id`, `schedule_id`), not the configuration ones (`location`, `schedule`). Call `bookrail_docs_get` with path "api" for the reference.',
      'Returns: the created object.',
      'Next: `bookrail_object_get` to read it back.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      kind: kindArgument,
      data: z.record(z.unknown()).describe('The object body, in API field names.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([args.kind, 'create', '--data', JSON.stringify(args.data)]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_object_update',
    title: 'Update one object directly',
    description: [
      'Patches one object. Only the fields you send are changed, except the sub-lists (`rules`, `resource_ids`, `requirements`), where the set you send REPLACES the whole set.',
      'If the object carries `metadata.config_id` it is managed by a configuration file, and the next `bookrail_config_push` will put it back the way the file describes. Change the file instead.',
      'Returns: the updated object.',
      'Next: `bookrail_object_get`, or `bookrail_availability` when the change could affect what is bookable.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      kind: kindArgument,
      id: z.string().describe('The prefixed id.'),
      data: z.record(z.unknown()).describe('The fields to change, in API field names.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        args.kind,
        'update',
        args.id,
        '--data',
        JSON.stringify(args.data),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_object_delete',
    title: 'Delete one object',
    description: [
      'Deletes one object. Resources and services are soft-deleted (they disappear from reads); everything else is removed. References from other objects become null.',
      'IRREVERSIBLE: without `confirm: true` this tool returns the object as it stands today plus `requires_confirmation: true`, and deletes nothing. Read the preview, in particular `metadata.config_id`, which tells you whether a configuration file still declares it.',
      'Returns: `{ id, deleted: true }`.',
      'Next: `bookrail_config_push` with dry_run: true, to check the configuration and the project still agree.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      kind: kindArgument,
      id: z.string().describe('The prefixed id.'),
      confirm: confirmArgument,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, ctx) {
      if (args.confirm !== true) {
        const current = await ctx.cli([args.kind, 'get', args.id]);
        return needsConfirmation(ctx.environment, current.data, [
          `Nothing was deleted. Read the preview, then call again with confirm: true to delete ${args.kind.replace(/s$/, '')} ${args.id}.`,
          'If `preview.metadata.config_id` is set, remove it from bookrail.config.ts and use bookrail_config_push instead.',
        ]);
      }
      const envelope = await ctx.cli([args.kind, 'delete', args.id, '--yes']);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: ['Call bookrail_config_push with dry_run: true to check nothing else drifted.'],
      };
    },
  });
}
