import { describeUsage, type PlanUsage } from '../plans.js';
import { ApiClient } from '../api/client.js';
import type { Context } from '../context.js';
import { assertKeyMatchesEnvironment } from '../context.js';
import {
  clearCredentials,
  environmentOfKey,
  loadCredentials,
  maskKey,
  saveCredentials,
} from '../credentials.js';
import { CliError, EXIT } from '../errors.js';
import { clientFor } from './helpers.js';
import type { CommandResult } from '../output.js';
import { API_VERSION, CLI_VERSION } from '../version.js';

export interface LoginOptions {
  token?: string;
  apiUrl?: string;
  skipVerification?: boolean;
}

/**
 * Stores one secret key.
 *
 * The environment is read from the key itself (`sk_test_` / `sk_live_`) rather than from
 * `--live`: a key knows which environment it belongs to, and asking the caller to say it
 * again is one more thing to get wrong. `--live` stays what it is everywhere else: the
 * permission to *operate* on live.
 */
export async function login(ctx: Context, options: LoginOptions): Promise<CommandResult> {
  let token = options.token?.trim();

  // `--token -` reads the key from standard input. A key on a command line is a key in
  // `ps`, in `/proc/<pid>/cmdline` and in a shell history file, and the script that hands a
  // freshly minted key to this command is a deployment's smoke test, which runs on a machine
  // where other processes exist.
  if (token === '-') {
    token = (await ctx.io.readStdin()).trim();
    if (token === '') {
      throw new CliError('missing_input', '`--token -` was given and standard input was empty.', {
        param: 'token',
        fix: 'Pipe the key in: `printf %s "$KEY" | bookrail login --token -`.',
        exitCode: EXIT.user,
      });
    }
  }

  if (!token || token === '') {
    if (ctx.options.nonInteractive || ctx.io.prompt === undefined) {
      throw new CliError('missing_input', 'No API key given and no terminal to ask on.', {
        param: 'token',
        fix: 'Run `bookrail login --token sk_test_...`, or set BOOKRAIL_SECRET_KEY.',
        exitCode: EXIT.user,
      });
    }
    token = (await ctx.io.prompt('Paste your Bookrail secret key: ')).trim();
  }

  const environment = environmentOfKey(token);
  if (environment === null) {
    throw new CliError('invalid_api_key', 'That is not a Bookrail server secret key.', {
      param: 'token',
      fix: 'A server key starts with `sk_test_` or `sk_live_`. Publishable `pk_` keys are refused by the server API.',
      exitCode: EXIT.auth,
    });
  }

  // Storing a live key means *sending* it, because the key is verified before it is written.
  // The test/live barrier has no exception for the command that installs the key, so
  // `--live` is required here too, and the guarantee stays absolute: nothing this process
  // builds can carry a live key unless `--live` was typed.
  if (environment === 'live' && !ctx.options.live) {
    throw new CliError('live_key_without_live', 'That is a live key and `--live` was not given.', {
      param: 'token',
      fix: 'Run `bookrail login --live --token sk_live_...`.',
      exitCode: EXIT.auth,
    });
  }

  const credentials = await loadCredentials(ctx.io);
  const apiUrl = options.apiUrl?.trim();
  const baseUrl = apiUrl && apiUrl !== '' ? apiUrl : await ctx.apiUrl();
  let verified: ProjectBody | null = null;

  if (options.skipVerification !== true) {
    const client = new ApiClient({ baseUrl, secretKey: token, environment });
    // One authenticated read, and the one that says the most: `GET /v1/project` names the
    // project the key opens, so a key pasted into the wrong account is visible immediately.
    verified = (await client.get<ProjectBody>('/v1/project')).data;
  }

  const file = { ...credentials.file, keys: { ...credentials.file.keys, [environment]: token } };
  if (apiUrl && apiUrl !== '') file.api_url = apiUrl;
  const path = await saveCredentials(ctx.io, file);

  return {
    data: {
      environment,
      key: maskKey(token),
      api_url: baseUrl,
      credentials_path: path,
      verified: options.skipVerification !== true,
      project: verified === null ? null : { id: verified.id, name: verified.name },
    },
    human:
      verified === null
        ? `Stored the ${environment} key in ${path} (mode 600).`
        : `Stored the ${environment} key for project ${verified.name} (${verified.id}) in ${path} (mode 600).`,
    nextSteps: [
      'Run `bookrail whoami --json` to confirm.',
      'Run `bookrail init --template <vertical>` to create a bookrail.config.ts.',
      'Run `bookrail push --dry-run` to see what would be created.',
    ],
  };
}

export async function logout(ctx: Context, options: { all?: boolean }): Promise<CommandResult> {
  const path = await clearCredentials(ctx.io, options.all === true ? undefined : ctx.environment);
  return {
    data: { removed: options.all === true ? 'all' : ctx.environment, credentials_path: path },
    human:
      options.all === true
        ? `Removed ${path}.`
        : `Removed the ${ctx.environment} key from ${path}.`,
    nextSteps: ['Run `bookrail login` to store a key again.'],
  };
}

/**
 * What this invocation would act as.
 *
 * The API answers the question directly: `GET /v1/project` returns the project
 * the key belongs to, and the key's own scopes and tenant. Before it existed, `whoami` could
 * only prove a key worked by making an unrelated list succeed and had to answer
 * `project: null`. The call is also the authentication proof, so there is exactly one
 * authenticated request here. The MCP server needs the same object, which is why it is built
 * from the client rather than printed.
 */
export async function whoami(ctx: Context): Promise<CommandResult> {
  const auth = await ctx.auth();
  const client = await clientFor(ctx);
  const project = (await client.get<ProjectBody>('/v1/project')).data;
  let health: { status: string; api_version?: string } | null = null;
  try {
    health = await client.health();
  } catch {
    health = null;
  }

  const data = {
    environment: auth.environment,
    key: maskKey(auth.secretKey),
    key_source: auth.source,
    api_url: client.baseUrl,
    api_version_requested: API_VERSION,
    api_version_served: health?.api_version ?? project.api_version,
    cli_version: CLI_VERSION,
    authenticated: true,
    project: {
      id: project.id,
      name: project.name,
      default_timezone: project.default_timezone,
      default_currency: project.default_currency,
    },
    api_key: project.api_key,
    // The plan of the account and this month's usage of it. `null` from a deployment that
    // predates the plans, which is a deployment this CLI still talks to.
    plan: project.plan ?? null,
    usage: project.usage ?? null,
  };

  return {
    data,
    human: [
      `${ctx.presenter.badge()} authenticated against ${client.baseUrl}`,
      `project  ${project.name} (${project.id})`,
      `key      ${data.key} (from ${auth.source === 'env' ? 'BOOKRAIL_SECRET_KEY' : 'credentials file'}), scopes ${project.api_key.scopes.length === 0 ? 'all' : project.api_key.scopes.join(',')}${project.api_key.tenant_id === null ? '' : `, tenant ${project.api_key.tenant_id}`}`,
      `api      ${data.api_version_served} (cli asks for ${API_VERSION})`,
      `defaults ${project.default_timezone}, ${project.default_currency}`,
      ...(project.plan === undefined
        ? []
        : project.usage === undefined || project.usage === null
          ? // A key scoped to a tenant sees the plan and not the numbers of the whole account.
            [`plan     ${project.plan}`]
          : [
              `plan     ${project.plan}${project.usage.blocks_at_limit ? ', stops new live bookings at the limit' : ''}`,
              `usage    ${describeUsage(project.usage)}`,
            ]),
    ].join('\n'),
    nextSteps: ['Run `bookrail doctor --json` for the full check list.'],
  };
}

/** The body of `GET /v1/project`: the project, its defaults, and the key that opened it. */
export interface ProjectBody {
  id: string;
  object: string;
  name: string;
  environment: string;
  api_version: string;
  default_timezone: string;
  default_currency: string;
  api_key: {
    id: string;
    object: string;
    kind: string;
    environment: string;
    scopes: string[];
    tenant_id: string | null;
  };
  /** The plan of the account. Absent from a deployment older than the plans. */
  plan?: string;
  /**
   * This month's usage of the plan, the account's live numbers whichever key asks; `null` for a
   * key scoped to a tenant, which does not see the numbers of the whole account.
   */
  usage?: PlanUsage | null;
  created_at: string;
}

export function version(ctx: Context): CommandResult {
  void ctx;
  return {
    data: { cli: CLI_VERSION, api_version: API_VERSION, node: process.versions.node },
    human: `bookrail ${CLI_VERSION} (API ${API_VERSION}, node ${process.versions.node})`,
  };
}

/** The variables to export, for the environment the command is running against. */
export async function envCommand(ctx: Context): Promise<CommandResult> {
  const credentials = await loadCredentials(ctx.io);
  const key = ctx.io.env.BOOKRAIL_SECRET_KEY ?? credentials.file.keys[ctx.environment];
  const apiUrl = await ctx.apiUrl();
  if (key !== undefined)
    assertKeyMatchesEnvironment(key, ctx.environment, 'the stored credentials');

  const variables = {
    BOOKRAIL_SECRET_KEY: key === undefined ? null : maskKey(key),
    BOOKRAIL_API_URL: apiUrl,
  };
  return {
    data: { environment: ctx.environment, variables },
    human: [
      `# ${ctx.environment} environment`,
      `BOOKRAIL_SECRET_KEY=${variables.BOOKRAIL_SECRET_KEY ?? '<run bookrail login>'}`,
      `BOOKRAIL_API_URL=${apiUrl}`,
      '',
      '# The key is masked on purpose: read the real one from ~/.config/bookrail/credentials.json.',
    ].join('\n'),
  };
}
