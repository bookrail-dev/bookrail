import { ApiClient } from '../api/client.js';
import { findConfigFile, loadConfig } from '../config/load.js';
import type { Context } from '../context.js';
import { environmentOfKey, loadCredentials, maskKey } from '../credentials.js';
import { CliError, EXIT } from '../errors.js';
import { renderTable, type CommandResult } from '../output.js';
import { API_VERSION, CLI_VERSION } from '../version.js';
import type { ProjectBody } from './auth.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

const MIN_NODE = [20, 10] as const;

/**
 * Every check that can be run against what exists today, each with the sentence that repairs it:
 * the Node version, the stored credentials and their file permissions, the environment variables
 * in play, the API reachability and version, the key, the project the key opens and the
 * environment it is on, and the configuration file.
 *
 * Everything is a check, including the failures: `doctor` never throws, because the whole
 * point of it is to be the command an agent runs when something else threw. It exits 1 when
 * at least one check failed, so a script can branch on the exit code without parsing.
 *
 * Two further checks are still absent, and the output says so: webhook reachability and
 * payment provider keys have no endpoint to ask (payments do not exist yet, and the closest
 * thing to a reachability probe is `bookrail webhooks test <id>`, which actually delivers).
 */
export async function doctor(ctx: Context, options: { config?: string }): Promise<CommandResult> {
  const checks: Check[] = [];

  checks.push(nodeCheck());

  const credentials = await loadCredentials(ctx.io);
  const fromEnv = ctx.io.env.BOOKRAIL_SECRET_KEY?.trim();
  const stored = credentials.file.keys[ctx.environment];
  const key = fromEnv && fromEnv !== '' ? fromEnv : stored;

  if (key === undefined || key === '') {
    checks.push({
      name: 'credentials',
      status: 'fail',
      message: `No ${ctx.environment} API key is configured.`,
      fix: 'Run `bookrail login`, or set BOOKRAIL_SECRET_KEY.',
    });
  } else {
    checks.push({
      name: 'credentials',
      status: 'ok',
      message: `${maskKey(key)} from ${fromEnv ? 'BOOKRAIL_SECRET_KEY' : credentials.path}.`,
    });
  }

  if (credentials.exists) {
    const secure = credentials.mode === '600';
    checks.push({
      name: 'credentials_permissions',
      status: secure ? 'ok' : 'warn',
      message: `${credentials.path} is mode ${credentials.mode ?? 'unknown'}.`,
      ...(secure ? {} : { fix: `Run \`chmod 600 ${credentials.path}\`.` }),
    });
  }

  checks.push(environmentCheck(ctx, key));

  const baseUrl = await ctx.apiUrl();
  let reachable = false;
  let served: string | null = null;
  const probe = new ApiClient({
    baseUrl,
    secretKey: key ?? 'sk_test_unset',
    environment: ctx.environment,
    ...(ctx.options.timeout === undefined ? {} : { timeoutMs: ctx.options.timeout }),
  });

  try {
    const health = await probe.health();
    reachable = true;
    served = health.api_version ?? null;
    checks.push({ name: 'api_reachable', status: 'ok', message: `${baseUrl} answered /health.` });
  } catch (error) {
    checks.push({
      name: 'api_reachable',
      status: 'fail',
      message: error instanceof CliError ? error.message : String(error),
      fix: `Check BOOKRAIL_API_URL (currently ${baseUrl}) and that the service is up.`,
    });
  }

  if (reachable) {
    const matches = served === null || served === API_VERSION;
    checks.push({
      name: 'api_version',
      status: matches ? 'ok' : 'warn',
      message: `cli asks for ${API_VERSION}, deployment serves ${served ?? 'an unknown version'}.`,
      ...(matches ? {} : { fix: 'Upgrade the CLI with `npm i -g bookrail@latest`.' }),
    });
  }

  let project: ProjectBody | null = null;
  if (reachable && key !== undefined && environmentOfKey(key) === ctx.environment) {
    try {
      // One call answers two checks: the key is accepted, and this is the project it opens.
      project = (await probe.get<ProjectBody>('/v1/project')).data;
      checks.push({
        name: 'authentication',
        status: 'ok',
        message: `The ${ctx.environment} key is accepted.`,
      });
    } catch (error) {
      const cliError = error instanceof CliError ? error : null;
      checks.push({
        name: 'authentication',
        status: 'fail',
        message: cliError ? `${cliError.code}: ${cliError.message}` : String(error),
        fix: cliError?.fix ?? 'Run `bookrail login` with a valid key.',
      });
    }
  }

  // "Which project is this key on?" used to be unanswerable, because no endpoint could say.
  // `GET /v1/project` answers it now, so the check exists.
  if (project !== null) {
    checks.push({
      name: 'project',
      status: 'ok',
      message: `${project.name} (${project.id}), ${project.environment}, defaults ${project.default_timezone} / ${project.default_currency}.`,
    });
    const sameEnvironment = project.environment === ctx.environment;
    checks.push({
      name: 'project_environment',
      status: sameEnvironment ? 'ok' : 'fail',
      message: sameEnvironment
        ? `The key opens the ${project.environment} environment, which is the one in use.`
        : `The key opens ${project.environment} but the command is running against ${ctx.environment}.`,
      ...(sameEnvironment
        ? {}
        : { fix: 'This should be impossible: report it with `--json` output.' }),
    });
  }

  checks.push(await configCheck(ctx, options.config));

  checks.push({
    name: 'not_checked',
    status: 'warn',
    message:
      'Webhook reachability and payment provider keys are not checked: there is no endpoint for them in this build.',
    fix: 'Nothing to do. Both checks appear when the features they test exist. `bookrail webhooks test <id>` checks one endpoint by actually delivering to it.',
  });

  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');

  return {
    data: {
      cli_version: CLI_VERSION,
      api_version: API_VERSION,
      api_url: baseUrl,
      environment: ctx.environment,
      project: project === null ? null : { id: project.id, name: project.name },
      checks,
      summary: {
        ok: checks.length - failed.length - warned.length,
        warn: warned.length,
        fail: failed.length,
      },
    },
    human: [
      `${ctx.presenter.badge()} ${checks.length} checks against ${baseUrl}`,
      '',
      renderTable(
        ['status', 'check', 'detail'],
        checks.map((check) => [check.status, check.name, check.message]),
      ),
      ...(failed.length + warned.length === 0
        ? []
        : [
            '',
            ...[...failed, ...warned]
              .filter((check) => check.fix !== undefined)
              .map((check) => `fix ${check.name}: ${check.fix}`),
          ]),
    ].join('\n'),
    // A failed check is a problem with the environment, which is what exit 1 means. The
    // command itself ran: it did not fail to reach a decision.
    exitCode: failed.length > 0 ? EXIT.user : EXIT.ok,
    nextSteps:
      failed.length > 0
        ? failed.map((check) => check.fix ?? `Fix "${check.name}".`)
        : ['Run `bookrail push --dry-run` to see what a push would do.'],
  };
}

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: 'node_version',
    status: ok ? 'ok' : 'fail',
    message: `node ${process.versions.node}`,
    ...(ok ? {} : { fix: `Bookrail needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer.` }),
  };
}

function environmentCheck(ctx: Context, key: string | undefined): Check {
  if (key === undefined) {
    return {
      name: 'environment',
      status: 'warn',
      message: `${ctx.environment} (no key to check against)`,
      fix: 'Run `bookrail login`.',
    };
  }
  const keyEnvironment = environmentOfKey(key);
  if (keyEnvironment === ctx.environment) {
    return {
      name: 'environment',
      status: 'ok',
      message: `${ctx.environment}, with a ${keyEnvironment} key.`,
    };
  }
  if (keyEnvironment === 'live') {
    return {
      name: 'environment',
      status: 'fail',
      message: 'A live key is configured but the command is running against test.',
      fix: 'Add `--live` to operate on the live environment, or store a `sk_test_` key.',
    };
  }
  if (keyEnvironment === 'test') {
    return {
      name: 'environment',
      status: 'fail',
      message: '`--live` was requested but the configured key is a test key.',
      fix: 'Run `bookrail login --token sk_live_...`, or drop `--live`.',
    };
  }
  return {
    name: 'environment',
    status: 'fail',
    message: 'The configured key is not a server secret key.',
    fix: 'Use a key that starts with `sk_test_` or `sk_live_`.',
  };
}

async function configCheck(ctx: Context, explicit?: string): Promise<Check> {
  let path: string | null = null;
  try {
    path = await findConfigFile(ctx.io, explicit);
  } catch (error) {
    return {
      name: 'config',
      status: 'fail',
      message: error instanceof CliError ? error.message : String(error),
      fix: 'Check the path passed to `--config`.',
    };
  }
  if (path === null) {
    return {
      name: 'config',
      status: 'warn',
      message: `No bookrail.config.* in ${ctx.io.cwd}.`,
      fix: 'Run `bookrail init --template <vertical>` to create one.',
    };
  }
  try {
    const loaded = await loadConfig(ctx.io, explicit);
    const counts = [
      loaded.config.locations.length,
      loaded.config.schedules.length,
      loaded.config.resources.length,
      loaded.config.resourceGroups.length,
      loaded.config.policies.length,
      loaded.config.services.length,
    ];
    return {
      name: 'config',
      status: 'ok',
      message: `${path} is valid (${counts.join('/')} locations/schedules/resources/groups/policies/services, read as ${loaded.loader}).`,
    };
  } catch (error) {
    const cliError = error instanceof CliError ? error : null;
    return {
      name: 'config',
      status: 'fail',
      message: cliError ? cliError.message : String(error),
      fix: cliError?.fix ?? 'Fix the configuration file.',
    };
  }
}
