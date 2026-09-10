import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CliError, findConfigFile, loadConfig, validateConfig } from 'bookrail';
import { z } from 'zod';
import type { Envelope } from '../cli.js';
import { ioOf, type Workspace } from '../environment.js';
import { withTempDirectory } from '../tempdir.js';
import {
  confirmArgument,
  environmentArgument,
  needsConfirmation,
  registerTool,
  type ToolContext,
} from '../tool.js';

/** Codes from the loader that mean "the configuration is wrong", not "the tool broke". */
const REPORTABLE = new Set(['invalid_config', 'config_unreadable']);

const configArgument = z
  .record(z.unknown())
  .optional()
  .describe(
    'The configuration as an object, the same shape as bookrail.config.ts (call bookrail_schema with entity "config"). Omit to use the file in the project directory.',
  );

const pathArgument = z
  .string()
  .optional()
  .describe('Path to a configuration file to use instead of the one in the project directory.');

/**
 * Runs a sync command against a configuration that may not be on disk.
 *
 * An agent usually holds the model in memory before it holds it in a file, and asking it to
 * write the file first would make `bookrail_config_push` two calls with a failure mode between
 * them. So an inline `config` is written to a temporary `bookrail.config.json` and passed with
 * `--config`: the same loader, the same validation, the same plan, and nothing left behind,
 * including when the process is signalled mid-push, which is what `src/tempdir.ts` is for.
 * `.json` rather than `.ts` on purpose: it is the one form the CLI can read on every Node
 * version, with no transpiler in the way.
 */
async function withConfig<T>(
  ctx: ToolContext,
  input: { config?: Record<string, unknown>; config_path?: string },
  body: (flags: string[]) => Promise<T>,
): Promise<T> {
  if (input.config === undefined) {
    return body(input.config_path === undefined ? [] : ['--config', input.config_path]);
  }
  if (input.config_path !== undefined) {
    throw new CliError('parameter_invalid', 'Pass either `config` or `config_path`, not both.', {
      param: 'config',
      fix: 'Drop `config_path` to use the inline object, or drop `config` to use the file.',
    });
  }
  // `withTempDirectory` is what makes "nothing left behind" true of a process that is killed
  // as well as of a call that throws (`src/tempdir.ts`).
  return withTempDirectory('config', async (directory) => {
    const file = join(directory, 'bookrail.config.json');
    await writeFile(file, `${JSON.stringify(input.config, null, 2)}\n`, 'utf8');
    return body(['--config', file]);
  });
}

function planSummary(envelope: Envelope): {
  plan: unknown;
  counts: Record<string, number>;
  deletions: number;
} {
  const data = (envelope.data ?? {}) as {
    plan?: unknown;
    counts?: Record<string, number>;
  };
  const counts = data.counts ?? {};
  return { plan: data.plan ?? [], counts, deletions: counts.delete ?? 0 };
}

export function registerConfigTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_config_validate',
    title: 'Validate a Bookrail configuration',
    description: [
      'Validates a configuration (locations, schedules, resources, resource groups, policies, services) against the same schema a push validates with, and cross-checks every logical reference (a service pointing at a group that the file does not declare, a resource pointing at a missing schedule).',
      'Use it after writing or editing a configuration and before every push. It touches no network and needs no key.',
      'Returns: `{ valid, issues: [{ path, message }], counts }`. `path` is the position inside the configuration, e.g. `services[1].requirements[0].group`.',
      'Next: `bookrail_config_push` with dry_run: true.',
    ].join('\n'),
    inputSchema: { config: configArgument, config_path: pathArgument },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(args) {
      let raw: unknown;
      let source: string;
      let loader: string;
      try {
        ({ raw, source, loader } = await readConfig(workspace, args));
      } catch (error) {
        // A file that does not parse, or that `loadConfig` already refused, is an *answer* to
        // "is this valid", not a tool failure. The positioned list is in the message.
        if (error instanceof CliError && REPORTABLE.has(error.code)) {
          return {
            ok: true,
            environment: 'test',
            data: {
              valid: false,
              source: args.config_path ?? workspace.cwd,
              loader: null,
              issues: [{ path: '<file>', message: error.message }],
              counts: null,
            },
            next_steps: [
              error.fix ?? 'Fix the configuration file, then call bookrail_config_validate again.',
              'Call bookrail_schema with entity "config" for the full schema.',
            ],
          };
        }
        throw error;
      }
      const result = validateConfig(raw);
      return {
        ok: true,
        environment: 'test',
        data: {
          valid: result.config !== null,
          source,
          loader,
          issues: result.issues,
          counts:
            result.config === null
              ? null
              : countsOf(result.config as unknown as Record<string, unknown[]>),
        },
        next_steps:
          result.config === null
            ? [
                'Fix every `issues[].path`, then call bookrail_config_validate again.',
                'Call bookrail_schema with entity "config" for the full schema.',
              ]
            : ['Call bookrail_config_push with dry_run: true to see the plan.'],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_config_push',
    title: 'Apply a configuration to the project',
    description: [
      'Reconciles a configuration with the project: creates what is missing, updates what differs, deletes what the configuration no longer declares. Objects with no `metadata.config_id` were not created from a configuration and are never touched: they come back in `unmanaged`.',
      'Use it after `bookrail_config_validate`. Call it first with `dry_run: true` (the default) to read the plan; then with `dry_run: false` and `confirm: true` to apply.',
      'Safety: `dry_run: false` requires `confirm: true`, and so does any plan that contains a deletion. Without it the tool returns the plan and `requires_confirmation: true` and changes nothing.',
      'Returns: `{ plan: [{ action, kind, config_id, remote_id, name, changes }], counts, unmanaged, applied }`.',
      'Next: `bookrail_objects_list` with kind "services" to read back the `svc_` ids, then `bookrail_availability`.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      config: configArgument,
      config_path: pathArgument,
      dry_run: z
        .boolean()
        .default(true)
        .describe('True (the default) computes the plan and writes nothing.'),
      confirm: confirmArgument,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // Reconciliation by `metadata.config_id`: applying the same configuration twice leaves
      // the project in the same state as applying it once.
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      return withConfig(ctx, args, async (flags) => {
        const preview = await ctx.cli(['push', '--dry-run', ...flags]);
        const { deletions } = planSummary(preview);

        if (args.dry_run) {
          return {
            ok: true,
            environment: ctx.environment,
            data: preview.data,
            next_steps: [
              deletions > 0
                ? `This plan deletes ${String(deletions)} object(s). Call again with dry_run: false and confirm: true to apply it.`
                : 'Call again with dry_run: false and confirm: true to apply it.',
            ],
          };
        }

        if (args.confirm !== true) {
          return needsConfirmation(ctx.environment, preview.data, [
            deletions > 0
              ? `Nothing was applied. The plan deletes ${String(deletions)} object(s): read preview.plan before accepting it. Call again with dry_run: false and confirm: true.`
              : 'Nothing was applied. Call again with dry_run: false and confirm: true.',
          ]);
        }

        const applied = await ctx.cli(['push', '--yes', ...flags]);
        return {
          ok: true,
          environment: ctx.environment,
          data: applied.data,
          next_steps: applied.next_steps ?? [],
        };
      });
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_config_pull',
    title: 'Read the project back as a configuration',
    description: [
      'Returns the project as a configuration object, in the shape `bookrail.config.ts` declares. Read-only: nothing is written, on the project or on disk.',
      'Use it to discover what a project already contains before changing anything, or to start a configuration from a project that was built through the API.',
      'Returns: `{ config, written: null, stamped: [], adopted }`. `adopted` lists objects with no `metadata.config_id`: pushing this configuration would create copies of them, so take them over with the CLI (`bookrail pull --adopt`) before pushing.',
      'Next: `bookrail_config_validate` on the returned `config`, then `bookrail_config_push` with dry_run: true.',
    ].join('\n'),
    inputSchema: { environment: environmentArgument },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(_args, ctx) {
      const envelope = await ctx.cli(['pull', '--stdout']);
      const data = envelope.data as { adopted?: unknown[] };
      const unmanaged = data.adopted?.length ?? 0;
      return {
        ok: true,
        environment: ctx.environment,
        data,
        next_steps:
          unmanaged > 0
            ? [
                `${String(unmanaged)} object(s) carry no metadata.config_id. Pushing this configuration would create copies of them: run \`bookrail pull --adopt --force\` in a shell to take them over first.`,
              ]
            : ['Call bookrail_config_push with dry_run: true to compare it with what you want.'],
      };
    },
  });
}

/**
 * The configuration a tool was given: the inline object, or the file in the project directory.
 *
 * The file is re-read on every call. `loadConfig` appends a cache-busting query to the dynamic
 * import, which is what makes that true in a process that lives for hours: an agent edits
 * `bookrail.config.ts` between two calls, and the second call has to see the edit.
 */
async function readConfig(
  workspace: Workspace,
  args: { config?: Record<string, unknown>; config_path?: string },
): Promise<{ raw: unknown; source: string; loader: string }> {
  if (args.config !== undefined) {
    if (args.config_path !== undefined) {
      throw new CliError('parameter_invalid', 'Pass either `config` or `config_path`, not both.', {
        param: 'config',
        fix: 'Drop `config_path` to validate the inline object, or drop `config` to validate the file.',
      });
    }
    return { raw: args.config, source: 'the inline `config` argument', loader: 'inline' };
  }

  const io = ioOf(workspace);
  const path = await findConfigFile(io, args.config_path);
  if (path === null) {
    throw new CliError(
      'config_not_found',
      `No bookrail.config.* in ${workspace.cwd} and no inline config was given.`,
      {
        fix: 'Pass the configuration in the `config` argument, or write bookrail.config.ts first. Call bookrail_examples for a working one.',
      },
    );
  }
  const loaded = await loadConfig(io, args.config_path);
  // `loadConfig` has already validated; re-validating the normalized value would check a
  // different object. The file is read again as raw data so that the issues a caller sees are
  // the issues of *their* file.
  return { raw: loaded.config, source: loaded.path, loader: loaded.loader };
}

function countsOf(config: Record<string, unknown[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}
