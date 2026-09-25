/**
 * `server.ts` opens a privileged connection only when something can use one,
 * and it binds where it is told to.
 *
 * This is the one thing in the package that cannot be tested through `createApp`: the pool is
 * built by the entry point, not by the application, so the entry point is what has to run. Each
 * case therefore forks the real `src/server.ts`, waits for `/health`, exercises the path that
 * would open the pool, and then asks **Postgres**, not the process, who is connected.
 *
 * `PGAPPNAME` is what makes that question answerable: every connection the child opens carries
 * it, so `pg_stat_activity` can be filtered down to this test's server and nothing else, on a
 * database the rest of the suite is using at the same time.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resolveDatabaseUrls } from '@bookrail/db';
import { LEGAL_VERSIONS, legalVersionsRefusal } from '@bookrail/shared';
import { TEST_DB_NAME } from './db-name.js';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));

interface RunningServer {
  child: ChildProcess;
  port: number;
  appName: string;
  /** Everything the process wrote to stdout: the `listening` line lives here. */
  output(): string;
  stop(): Promise<void>;
}

let nextPort = 4310;

async function startServer(env: Record<string, string | undefined>): Promise<RunningServer> {
  const port = nextPort++;
  const appName = `bookrail-admin-pool-test-${String(port)}`;
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const child = fork(SERVER, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      DATABASE_URL: urls.admin,
      PORT: String(port),
      // The suite is not production, so the default here is 0.0.0.0; the case that cares sets
      // NODE_ENV itself. HOST is cleared so that a developer's shell cannot change the answer.
      HOST: undefined,
      NODE_ENV: undefined,
      PGAPPNAME: appName,
      BOOKRAIL_WORKER: 'off',
      LOG_LEVEL: 'info',
      // Deliberately cleared, then set by the caller when the case wants it.
      BOOKRAIL_BOOTSTRAP_TOKEN: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('the server did not come up');
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    child,
    port,
    appName,
    output: () => output,
    async stop() {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

/** Starts the server with an environment it must refuse, and answers how it exited. */
async function startServerExpectingExit(
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; output: string }> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const child = fork(SERVER, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      DATABASE_URL: urls.admin,
      PORT: String(nextPort++),
      HOST: undefined,
      BOOKRAIL_WORKER: 'off',
      BOOKRAIL_BOOTSTRAP_TOKEN: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, output };
}

describe('the API entry point and its privileged pool', () => {
  let observer: Client;
  let appRole: string;

  beforeAll(async () => {
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    appRole = urls.appRole;
    observer = new Client({ connectionString: urls.admin });
    await observer.connect();
  });

  afterAll(async () => {
    await observer.end();
  });

  async function connectionsOf(appName: string): Promise<{ usename: string }[]> {
    const { rows } = await observer.query<{ usename: string }>(
      `SELECT usename FROM pg_stat_activity WHERE application_name = $1`,
      [appName],
    );
    return rows;
  }

  it('binds to loopback in production, and says which address it took', async () => {
    // `POST /internal/bootstrap` is mounted on this server and creates accounts, projects and
    // API keys on the connection that bypasses RLS. In production the only thing that may
    // reach it is the machine itself: a firewall rule is the second line of defence, and until
    // this test existed it was the first.
    //
    // While the terms the API records are drafts, a production server does not start at all
    // (`legalVersionsRefusal`): that refusal is what this case proves until they are approved,
    // and the binding is proved by `loadConfig` in `config.test.ts` meanwhile. One case, not a
    // skipped one: whichever state the constant is in, the real process is asked.
    if (legalVersionsRefusal(LEGAL_VERSIONS) !== null) {
      const refused = await startServerExpectingExit({ NODE_ENV: 'production' });
      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain('are drafts');
      return;
    }
    const server = await startServer({ NODE_ENV: 'production' });
    try {
      const health = await fetch(`http://127.0.0.1:${String(server.port)}/health`);
      expect(health.ok).toBe(true);
      expect(server.output()).toContain('"address":"127.0.0.1"');

      // Nothing is listening on a non-loopback address of this machine on that port. `::1` is
      // loopback too, and a socket bound to 127.0.0.1 does not answer there.
      await expect(fetch(`http://[::1]:${String(server.port)}/health`)).rejects.toThrow();
    } finally {
      await server.stop();
    }
  }, 60_000);

  it('binds to every interface outside production, which is what a development server is', async () => {
    const server = await startServer({});
    try {
      expect(server.output()).toContain('"address":"0.0.0.0"');
    } finally {
      await server.stop();
    }
  }, 60_000);

  it('opens no privileged connection when there is no bootstrap token', async () => {
    const server = await startServer({});
    try {
      // A request that forces the application pool to open: authentication reads api_keys.
      const denied = await fetch(`http://127.0.0.1:${String(server.port)}/v1/project`, {
        headers: { authorization: 'Bearer sk_test_0123456789abcdef0123456789abcdef' },
      });
      expect(denied.status).toBe(401);

      // And the route that would need one does not exist at all.
      const bootstrap = await fetch(`http://127.0.0.1:${String(server.port)}/internal/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(bootstrap.status).toBe(404);

      const connections = await connectionsOf(server.appName);
      expect(connections.length).toBeGreaterThan(0);
      expect(connections.every((row) => row.usename === appRole)).toBe(true);

      // And the pool was never even built. `pg.Pool` opens no socket until somebody queries it,
      // so the assertion above would pass on a process that had one sitting there unused; the
      // startup line is what says whether the object exists.
      expect(server.output()).toContain('"admin_pool":"none"');
    } finally {
      await server.stop();
    }
  }, 60_000);

  it('opens one, and only for the bootstrap endpoint, when the token is set', async () => {
    const server = await startServer({ BOOKRAIL_BOOTSTRAP_TOKEN: 'token-for-this-test' });
    try {
      const created = await fetch(`http://127.0.0.1:${String(server.port)}/internal/bootstrap`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer token-for-this-test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          account_name: 'Admin pool test',
          project_name: 'Admin pool test',
          default_timezone: 'Europe/Rome',
        }),
      });
      expect(created.status).toBe(201);

      const connections = await connectionsOf(server.appName);
      expect(connections.some((row) => row.usename !== appRole)).toBe(true);
      expect(server.output()).toContain('"admin_pool":"open"');
    } finally {
      await server.stop();
    }
  }, 60_000);
});
