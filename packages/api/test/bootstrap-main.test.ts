/**
 * `bookrail-bootstrap`, the command that creates a customer in production.
 *
 * It is the path a deployment should take: with `POST /internal/bootstrap` left unmounted,
 * which is what a deployment that does not want the route on the internet does, this command
 * is how an account, a project and the two keys come into existence. Two things are worth
 * testing: the command line, which is the part with the most ways to be wrong, and the
 * envelope, because a deployment's smoke test reads `.secrets.test` and `.secrets.live` out of
 * it with `jq`, and a change in shape breaks the smoke test of every release.
 *
 * The parsing is tested directly. The envelope is tested by running the real entry point as a
 * child process against the test database, which is also what proves that importing the module
 * does not create an account and that running it does.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resolveDatabaseUrls } from '@bookrail/db';
import { parseBootstrapArgs } from '../src/bootstrap-main.js';
import { TEST_DB_NAME } from './db-name.js';

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL('../src/bootstrap-main.ts', import.meta.url));

async function bootstrap(
  args: string[],
  entry: string = ENTRY,
): Promise<{ stdout: string; stderr: string }> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  return run(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: urls.admin,
      DATABASE_ADMIN_URL: urls.admin,
      NODE_ENV: 'production',
    },
  });
}

describe('parseBootstrapArgs', () => {
  it('takes two names and nothing else', () => {
    const { body, json } = parseBootstrapArgs(['Acme', 'Acme production']);
    expect(body.account_name).toBe('Acme');
    expect(body.project_name).toBe('Acme production');
    expect(body.default_timezone).toBeUndefined();
    expect(json).toBe(false);
  });

  it('takes the options in any position, before or after the names', () => {
    const after = parseBootstrapArgs([
      'Acme',
      'Acme production',
      '--timezone',
      'Europe/Rome',
      '--currency',
      'EUR',
      '--json',
    ]);
    const before = parseBootstrapArgs([
      '--json',
      '--timezone',
      'Europe/Rome',
      '--currency',
      'EUR',
      'Acme',
      'Acme production',
    ]);
    // The old parser looked at `argv[i - 1]` and swallowed "Acme" as the value of --currency.
    expect(before).toEqual(after);
    expect(after.json).toBe(true);
    expect(after.body.default_timezone).toBe('Europe/Rome');
    expect(after.body.default_currency).toBe('EUR');
  });

  it('carries a tenant id when it is given', () => {
    const { body } = parseBootstrapArgs(['A', 'B', '--tenant-id', 'club-42']);
    expect(body.tenant_id).toBe('club-42');
  });

  it('refuses the shapes that would otherwise create the wrong account', () => {
    expect(() => parseBootstrapArgs(['Acme'])).toThrow(/Usage/);
    expect(() => parseBootstrapArgs([])).toThrow(/Usage/);
    // An unquoted name with a space: three positionals, and the account would silently be wrong.
    expect(() => parseBootstrapArgs(['Acme', 'Acme', 'production'])).toThrow(/Too many arguments/);
    expect(() => parseBootstrapArgs(['A', 'B', '--timezone'])).toThrow(/needs a value/);
    expect(() => parseBootstrapArgs(['A', 'B', '--timezone', '--json'])).toThrow(/needs a value/);
    expect(() => parseBootstrapArgs(['A', 'B', '--secret'])).toThrow(/Unknown option/);
    // The Zod schema of the HTTP route, applied here too.
    expect(() => parseBootstrapArgs(['A', 'B', '--timezone', 'Mars/Olympus'])).toThrow();
  });
});

describe('the bookrail-bootstrap command', () => {
  it('creates an account, a project and two keys, and prints the secrets once', async () => {
    const { stdout } = await bootstrap([
      'Bootstrap probe',
      'Bootstrap probe project',
      '--timezone',
      'Europe/Rome',
      '--currency',
      'EUR',
      '--json',
    ]);
    const envelope = JSON.parse(stdout) as {
      object: string;
      account: { id: string; name: string };
      project: { id: string; default_timezone: string; default_currency: string };
      api_keys: { environment: string; prefix: string }[];
      secrets: { test: string; live: string };
    };

    expect(envelope.object).toBe('bootstrap');
    expect(envelope.account.id).toMatch(/^acct_/);
    expect(envelope.project.id).toMatch(/^proj_/);
    expect(envelope.project.default_timezone).toBe('Europe/Rome');
    expect(envelope.project.default_currency).toBe('EUR');
    expect(envelope.api_keys.map((k) => k.environment).sort()).toEqual(['live', 'test']);
    // The two fields a deployment's smoke test reads with jq.
    expect(envelope.secrets.test).toMatch(/^sk_test_/);
    expect(envelope.secrets.live).toMatch(/^sk_live_/);

    // The row is really there, and only the hash of the key is.
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    const client = new Client({ connectionString: urls.admin });
    await client.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects WHERE name = 'Bootstrap probe project'`,
      );
      expect(Number(rows[0]!.n)).toBe(1);
      const { rows: keys } = await client.query<{ key_hash: string }>(
        `SELECT key_hash FROM api_keys WHERE key_hash = encode(sha256($1::bytea), 'hex')`,
        [envelope.secrets.test],
      );
      expect(keys).toHaveLength(1);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('without --json prints the envelope without the secrets, and the keys on their own lines', async () => {
    const { stdout } = await bootstrap(['Bootstrap probe two', 'Bootstrap probe project two']);
    const [envelopeText, rest] = stdout.split('\nThe two keys');
    const envelope = JSON.parse(envelopeText!) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty('secrets');
    expect(rest).toMatch(/test: sk_test_/);
    expect(rest).toMatch(/live: sk_live_/);
  }, 60_000);

  /**
   * The shape a real deployment runs, and the one the first version of the entry point guard
   * did not survive. `bookrail-bootstrap` is invoked inside a release directory reached
   * through a symlink that moves at every release. Node leaves `argv[1]` as given and resolves
   * the module's real path before assigning `import.meta.url`, so a guard comparing the two
   * strings is false through the symlink: the command prints nothing and exits 0, and a smoke
   * test's `jq -r '.secrets.test'` on an empty string exits 0 as well.
   *
   * Two assertions, and the second one is the point: not that it did not crash, but that it
   * **acted**.
   */
  it('acts when it is run through a symlinked directory, which is how a release runs it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bookrail-entrypoint-'));
    try {
      // `<root>/current` -> the real source directory, so the path node is given differs from
      // the module's real path in exactly the way a release symlink does.
      await symlink(dirname(ENTRY), join(root, 'current'), 'dir');
      const throughSymlink = join(root, 'current', 'bootstrap-main.ts');

      const { stdout } = await bootstrap(
        ['Symlink probe', 'Symlink probe project', '--json'],
        throughSymlink,
      );
      expect(stdout.trim(), 'the command printed nothing: the entry point guard is false').not.toBe(
        '',
      );
      const envelope = JSON.parse(stdout) as { secrets: { test: string } };
      expect(envelope.secrets.test).toMatch(/^sk_test_/);

      const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
      const client = new Client({ connectionString: urls.admin });
      await client.connect();
      try {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM projects WHERE name = 'Symlink probe project'`,
        );
        expect(Number(rows[0]!.n), 'nothing was created through the symlink').toBe(1);
      } finally {
        await client.end();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails with a message and no stack when the command line is wrong', async () => {
    await expect(bootstrap(['only-one-name'])).rejects.toMatchObject({ code: 1 });
    const failed = await bootstrap(['only-one-name']).catch(
      (error: { stderr: string }) => error.stderr,
    );
    expect(failed).toMatch(/Usage: bookrail-bootstrap/);
    expect(failed).not.toMatch(/at .*bootstrap-main/);
  }, 60_000);
});
