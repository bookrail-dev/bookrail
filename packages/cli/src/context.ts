import { loadCredentials, environmentOfKey } from './credentials.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { createPresenter, type Presenter } from './output.js';
import { DEFAULT_API_URL, type Environment } from './version.js';

export interface GlobalOptions {
  json: boolean;
  live: boolean;
  nonInteractive: boolean;
  apiUrl: string | undefined;
  timeout: number | undefined;
}

export interface ResolvedAuth {
  secretKey: string;
  environment: Environment;
  /** Where the key came from, for `whoami` and `doctor`. Never the key itself. */
  source: 'env' | 'credentials';
}

export interface Context {
  io: Io;
  options: GlobalOptions;
  environment: Environment;
  presenter: Presenter;
  apiUrl(): Promise<string>;
  auth(): Promise<ResolvedAuth>;
}

export function readGlobalOptions(raw: Record<string, unknown>, io: Io): GlobalOptions {
  const timeoutRaw = raw.timeout;
  let timeout: number | undefined;
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new CliError('parameter_invalid', '--timeout must be a positive number of seconds.', {
        param: 'timeout',
        fix: 'Pass a positive number, for example `--timeout 30`.',
      });
    }
    timeout = Math.round(parsed * 1000);
  }
  return {
    json: raw.json === true,
    live: raw.live === true,
    // A pipe is not a terminal, and a command that would block on a prompt there hangs an
    // agent forever. There is no hidden interactivity anywhere in the CLI: every prompt has a
    // flag that replaces it, and outside a terminal the flag is the only way in.
    nonInteractive: raw.nonInteractive === true || !io.isTTY,
    apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : undefined,
    timeout,
  };
}

export function createContext(io: Io, options: GlobalOptions): Context {
  const environment: Environment = options.live ? 'live' : 'test';
  const presenter = createPresenter(io, { json: options.json, environment });

  let authPromise: Promise<ResolvedAuth> | undefined;
  let urlPromise: Promise<string> | undefined;

  return {
    io,
    options,
    environment,
    presenter,
    apiUrl() {
      urlPromise ??= resolveApiUrl(io, options);
      return urlPromise;
    },
    auth() {
      authPromise ??= resolveAuth(io, environment);
      return authPromise;
    },
  };
}

async function resolveApiUrl(io: Io, options: GlobalOptions): Promise<string> {
  const fromEnv = io.env.BOOKRAIL_API_URL?.trim();
  const explicit = options.apiUrl?.trim();
  if (explicit && explicit !== '') return trimSlash(explicit);
  if (fromEnv && fromEnv !== '') return trimSlash(fromEnv);
  const credentials = await loadCredentials(io);
  const stored = credentials.file.api_url?.trim();
  return trimSlash(stored && stored !== '' ? stored : DEFAULT_API_URL);
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * The single place a secret key is chosen, and the single place the test/live barrier is
 * enforced: test is the default, live is reached only by typing `--live`.
 *
 * `BOOKRAIL_SECRET_KEY` wins over the credentials file, because that is the variable a CI job
 * sets and it must not be silently overridden by whatever a developer once logged in with.
 * A live key while the command is running in `test` is a hard error, not a downgrade: it is
 * the only way to guarantee that no request built by this process can reach the live
 * environment unless `--live` was typed.
 */
export async function resolveAuth(io: Io, environment: Environment): Promise<ResolvedAuth> {
  const fromEnv = io.env.BOOKRAIL_SECRET_KEY?.trim();
  if (fromEnv && fromEnv !== '') {
    assertKeyMatchesEnvironment(fromEnv, environment, 'BOOKRAIL_SECRET_KEY');
    return { secretKey: fromEnv, environment, source: 'env' };
  }

  const credentials = await loadCredentials(io);
  const stored = credentials.file.keys[environment];
  if (!stored) {
    throw new CliError('missing_api_key', `No ${environment} API key is configured.`, {
      fix:
        environment === 'live'
          ? 'Run `bookrail login --token sk_live_...`, or set BOOKRAIL_SECRET_KEY to a live key.'
          : 'Run `bookrail login`, or set BOOKRAIL_SECRET_KEY to a test key.',
      exitCode: EXIT.auth,
    });
  }
  assertKeyMatchesEnvironment(stored, environment, credentials.path);
  return { secretKey: stored, environment, source: 'credentials' };
}

export function assertKeyMatchesEnvironment(
  key: string,
  environment: Environment,
  origin: string,
): void {
  const keyEnvironment = environmentOfKey(key);
  if (keyEnvironment === null) {
    throw new CliError('invalid_api_key', `The key in ${origin} is not a server secret key.`, {
      fix: 'Use a key that starts with `sk_test_` or `sk_live_`. Publishable `pk_` keys are for browsers and are refused by the server API.',
      exitCode: EXIT.auth,
    });
  }
  if (keyEnvironment === environment) return;
  if (keyEnvironment === 'live') {
    throw new CliError(
      'live_key_without_live',
      `The key in ${origin} is a live key, and this command is running against the test environment.`,
      {
        fix: 'Add `--live` to operate on the live environment, or use a `sk_test_` key.',
        exitCode: EXIT.auth,
      },
    );
  }
  throw new CliError(
    'test_key_with_live',
    `The key in ${origin} is a test key, and \`--live\` was requested.`,
    {
      fix: 'Run `bookrail login --token sk_live_...` first, or drop `--live`.',
      exitCode: EXIT.auth,
    },
  );
}
