import { CliError, EXIT, environmentOfKey, loadCredentials, type Io } from 'bookrail';
import type { Logger } from './log.js';

export const ENVIRONMENTS = ['test', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The process the server is running inside, as values rather than globals.
 *
 * Everything the server is allowed to read from the outside world is here: it is what lets a
 * test drive the whole server with a temporary home, a temporary project directory and an
 * environment of its own, against a real API on a random port.
 */
export interface Workspace {
  /** The project directory: where `bookrail.config.ts` is looked for. */
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface ResolvedKey {
  secretKey: string;
  environment: Environment;
  /** Which variable or file the key came from. Never the key itself. */
  source: string;
}

const ALLOW_LIVE = 'BOOKRAIL_MCP_ALLOW_LIVE';

/** The CLI's `Io`, wired to a workspace and writing nowhere. Reads only. */
export function ioOf(workspace: Workspace): Io {
  return {
    env: workspace.env,
    cwd: workspace.cwd,
    home: workspace.home,
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => '',
  };
}

function keyOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * The single gate between an MCP tool call and a secret key. Nothing else in this package
 * constructs one.
 *
 * Two barriers, in this order, and both **before** any client exists, which is what makes
 * "no request can reach live by accident" a property of the code rather than a promise:
 *
 * 1. **`environment: "live"` needs `BOOKRAIL_MCP_ALLOW_LIVE=1` in the server's own
 *    environment.** That variable is set once, by the person who edited the MCP client's
 *    configuration; a model cannot set it, and an argument cannot stand in for it. It is the
 *    MCP shape of the CLI's `--live`: a flag a human types is not available to a tool call, so
 *    the deliberate act moves to the process configuration. Without it the error is
 *    `live_not_allowed`, with its `fix`.
 * 2. **A live key must actually be configured**, in `BOOKRAIL_LIVE_SECRET_KEY` or in the
 *    credentials file `bookrail login` writes. A user who configured only the test key gets
 *    `live_key_missing` rather than a call that quietly runs against test.
 *
 * `BOOKRAIL_SECRET_KEY`, the variable the CLI and CI use, is accepted for **the environment
 * its prefix declares** and ignored for the other one. A long-lived server answers both
 * environments in the same process, so a single ambiguous variable cannot be allowed to decide
 * which: a `sk_live_` in `BOOKRAIL_SECRET_KEY` must never become the key a `environment:
 * "test"` call uses.
 */
export async function resolveKey(
  workspace: Workspace,
  environment: Environment,
): Promise<ResolvedKey> {
  const shared = keyOf(workspace.env.BOOKRAIL_SECRET_KEY);
  const sharedEnvironment = shared === undefined ? null : environmentOfKey(shared);

  if (environment === 'live') {
    if (keyOf(workspace.env[ALLOW_LIVE]) !== '1') {
      throw new CliError(
        'live_not_allowed',
        'This MCP server refuses to operate on the live environment.',
        {
          fix: `Add "${ALLOW_LIVE}": "1" to the env of the bookrail entry in your MCP client configuration and restart the client, together with a live key in BOOKRAIL_LIVE_SECRET_KEY. Until then call this tool with environment: "test".`,
          exitCode: EXIT.auth,
        },
      );
    }
    const explicit = keyOf(workspace.env.BOOKRAIL_LIVE_SECRET_KEY);
    const fromShared = sharedEnvironment === 'live' ? shared : undefined;
    if (explicit !== undefined) return live(explicit, 'BOOKRAIL_LIVE_SECRET_KEY');
    if (fromShared !== undefined) return live(fromShared, 'BOOKRAIL_SECRET_KEY');

    const credentials = await loadCredentials(ioOf(workspace));
    const stored = keyOf(credentials.file.keys.live);
    if (stored !== undefined) return live(stored, credentials.path);
    throw new CliError('live_key_missing', 'No live API key is configured.', {
      fix: 'Set BOOKRAIL_LIVE_SECRET_KEY to a sk_live_ key in the MCP server configuration, or run `bookrail login --live --token sk_live_...` once so the credentials file has one.',
      exitCode: EXIT.auth,
    });
  }

  const explicit = keyOf(workspace.env.BOOKRAIL_TEST_SECRET_KEY);
  if (explicit !== undefined) return test(explicit, 'BOOKRAIL_TEST_SECRET_KEY');
  if (sharedEnvironment === 'test' && shared !== undefined) {
    return test(shared, 'BOOKRAIL_SECRET_KEY');
  }

  const credentials = await loadCredentials(ioOf(workspace));
  const stored = keyOf(credentials.file.keys.test);
  if (stored !== undefined) return test(stored, credentials.path);

  throw new CliError('missing_api_key', 'No test API key is configured.', {
    fix:
      sharedEnvironment === 'live'
        ? 'BOOKRAIL_SECRET_KEY holds a live key, which this call must not use. Set BOOKRAIL_TEST_SECRET_KEY to a sk_test_ key, or run `bookrail login`.'
        : 'Set BOOKRAIL_TEST_SECRET_KEY (or BOOKRAIL_SECRET_KEY) to a sk_test_ key in the MCP server configuration, or run `bookrail login` once.',
    exitCode: EXIT.auth,
  });
}

function live(secretKey: string, source: string): ResolvedKey {
  assertPrefix(secretKey, 'live', source);
  return { secretKey, environment: 'live', source };
}

function test(secretKey: string, source: string): ResolvedKey {
  assertPrefix(secretKey, 'test', source);
  return { secretKey, environment: 'test', source };
}

function assertPrefix(key: string, environment: Environment, source: string): void {
  const actual = environmentOfKey(key);
  if (actual === environment) return;
  if (actual === null) {
    throw new CliError('invalid_api_key', `The key in ${source} is not a server secret key.`, {
      fix: 'Use a key that starts with `sk_test_` or `sk_live_`. Publishable `pk_` keys are for browsers and the server API refuses them.',
      exitCode: EXIT.auth,
    });
  }
  throw new CliError(
    'key_environment_mismatch',
    `The key in ${source} is a ${actual} key, and this call asked for ${environment}.`,
    {
      fix: `Put the ${environment} key in BOOKRAIL_${environment.toUpperCase()}_SECRET_KEY, or call the tool with environment: "${actual}".`,
      exitCode: EXIT.auth,
    },
  );
}

/** Whether a live call could succeed at all, for `bookrail_project_info` and `bookrail_doctor`. */
export function liveAllowed(workspace: Workspace): boolean {
  return keyOf(workspace.env[ALLOW_LIVE]) === '1';
}
