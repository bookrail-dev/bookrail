import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import type { Environment } from './version.js';

export interface CredentialsFile {
  version: 1;
  /** Base URL of the API, when the deployment is not the hosted one. */
  api_url?: string;
  /** One secret key per environment. Never logged, never echoed back. */
  keys: Partial<Record<Environment, string>>;
}

const EMPTY: CredentialsFile = { version: 1, keys: {} };

/** `~/.config/bookrail/credentials.json`, or `$XDG_CONFIG_HOME/bookrail/...` when set. */
export function credentialsPath(io: Io): string {
  const base = io.env.XDG_CONFIG_HOME?.trim();
  return join(
    base && base !== '' ? base : join(io.home, '.config'),
    'bookrail',
    'credentials.json',
  );
}

export interface LoadedCredentials {
  file: CredentialsFile;
  path: string;
  exists: boolean;
  /** File mode as three octal digits, e.g. `600`. `null` when the file does not exist. */
  mode: string | null;
}

export async function loadCredentials(io: Io): Promise<LoadedCredentials> {
  const path = credentialsPath(io);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: { ...EMPTY, keys: {} }, path, exists: false, mode: null };
    }
    throw new CliError('credentials_unreadable', `Could not read ${path}: ${String(error)}`, {
      fix: `Check the permissions of ${path}, or run \`bookrail login\` again.`,
      exitCode: EXIT.auth,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('credentials_corrupt', `${path} is not valid JSON.`, {
      fix: `Delete ${path} and run \`bookrail login\` again.`,
      exitCode: EXIT.auth,
    });
  }

  const stats = await stat(path);
  const mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
  const object = (parsed ?? {}) as Partial<CredentialsFile>;
  const keys = (object.keys ?? {}) as Partial<Record<Environment, string>>;
  const file: CredentialsFile = { version: 1, keys: {} };
  if (typeof keys.test === 'string') file.keys.test = keys.test;
  if (typeof keys.live === 'string') file.keys.live = keys.live;
  if (typeof object.api_url === 'string') file.api_url = object.api_url;
  return { file, path, exists: true, mode };
}

/**
 * Writes the file with mode 600 and its directory with 700.
 *
 * `chmod` is called after the write as well as passed to it: an existing file keeps its old
 * mode when `writeFile` reuses it, and a credentials file that was once 644 would stay 644.
 */
export async function saveCredentials(io: Io, file: CredentialsFile): Promise<string> {
  const path = credentialsPath(io);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function clearCredentials(io: Io, environment?: Environment): Promise<string> {
  const loaded = await loadCredentials(io);
  if (!loaded.exists) return loaded.path;
  if (environment === undefined) {
    await rm(loaded.path, { force: true });
    return loaded.path;
  }
  delete loaded.file.keys[environment];
  return saveCredentials(io, loaded.file);
}

/** `sk_test_...` -> `test`. Returns null for anything that is not a server secret key. */
export function environmentOfKey(key: string): Environment | null {
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_')) return 'live';
  return null;
}

/**
 * `sk_test_****wxyz`: enough to recognise a key, never enough to use one.
 *
 * The split is on the documented two-segment prefix, not on the last underscore: the random
 * part of a key is base64url and may itself contain `_`, which would have made the mask show
 * a different amount of the secret depending on the key.
 */
export function maskKey(key: string): string {
  const match = /^(sk_(?:test|live)_)(.*)$/.exec(key);
  const prefix = match?.[1] ?? '';
  const body = match?.[2] ?? key;
  if (body.length <= 4) return `${prefix}****`;
  return `${prefix}****${body.slice(-4)}`;
}
