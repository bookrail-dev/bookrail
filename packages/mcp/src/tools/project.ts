import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { liveAllowed, type Workspace } from '../environment.js';
import { environmentArgument, registerTool } from '../tool.js';

const DIAGNOSTIC = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * `bookrail_project_info` and `bookrail_doctor`: the two tools an agent calls when it does not
 * know where it is, or when something else has just failed.
 *
 * Both are read-only and both are safe to call first: `doctor` in particular never throws (it
 * reports) because the whole point of it is to be the tool that still answers when the
 * environment is broken.
 */
export function registerProjectTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_project_info',
    title: 'Which project, key and API this server is talking to',
    description: [
      'Returns the project the configured key belongs to, the API URL and version, the key (masked) and where it came from, the plan of the account and how much of it the account has used this month, and whether the live environment is reachable from this server at all.',
      'Use it first, before any other call that touches data: it proves the key works and names the project you are about to change. On the free plan, `usage.bookings_confirmed` reaching `usage.bookings_included` means every new live booking answers `402 plan_limit_reached`; the numbers are the live ones even with a test key.',
      'Returns: `{ environment, project: { id, name, default_timezone, default_currency }, api_key: { id, scopes, tenant_id }, plan, usage: { month, bookings_confirmed, bookings_included, payment_volume, payment_volume_included, currency, blocks_at_limit }, api_url, api_version_served, live_allowed }`.',
      'Next: `bookrail_doctor` if anything looks wrong; `bookrail_config_pull` to see what the project already contains.',
    ].join('\n'),
    inputSchema: { environment: environmentArgument },
    annotations: DIAGNOSTIC,
    async run(_args, ctx) {
      const envelope = await ctx.cli(['whoami']);
      const data = envelope.data as Record<string, unknown>;
      return {
        ok: true,
        environment: ctx.environment,
        data: { ...data, live_allowed: liveAllowed(workspace) },
        next_steps: [
          'Call bookrail_config_pull to read the current model of this project.',
          'Call bookrail_doctor if a later call fails for a reason you cannot place.',
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_doctor',
    title: 'Check the environment and say how to fix it',
    description: [
      'Runs every check the `bookrail doctor` command runs (Node version, credentials and their file permissions, environment against key prefix, API reachability, API version drift, authentication, project and project environment, plan usage, Stripe connection, configuration file validity) and returns each as ok / warn / fail with a `fix` sentence.',
      'Use it when a call failed and you do not know why, or before starting work in a new project directory.',
      'Returns: `{ checks: [{ name, status, message, fix? }], summary: { ok, warn, fail } }`. `ok: false` is never returned for a failed check: read `summary.fail`.',
      'Next: act on the `fix` of every failing check, then call `bookrail_project_info`.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      config_path: z
        .string()
        .optional()
        .describe(
          'Path to the configuration file to validate. Default: bookrail.config.* in the project directory.',
        ),
    },
    annotations: DIAGNOSTIC,
    async run(args, ctx) {
      // `doctor` exits 1 when a check fails, and the CLI reports that through the exit code,
      // not through `ok`. So the envelope comes back `ok: true` with the failures inside it,
      // which is exactly what should reach the model: a broken environment is an answer.
      const envelope = await ctx.cli([
        'doctor',
        ...(args.config_path === undefined ? [] : ['--config', args.config_path]),
      ]);
      const data = envelope.data as { summary?: { fail?: number } };
      const failed = data.summary?.fail ?? 0;
      return {
        ok: true,
        environment: ctx.environment,
        data,
        next_steps:
          failed > 0
            ? (envelope.next_steps ?? ['Fix the failing checks and call bookrail_doctor again.'])
            : ['Call bookrail_config_push with dry_run: true to see what a push would do.'],
      };
    },
  });
}
