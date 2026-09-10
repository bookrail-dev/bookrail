import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from '@bookrail/api';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { silentLogger } from '@bookrail/shared';
import { run } from '../src/run.js';
import type { Io } from '../src/io.js';
import { TEST_DB_NAME } from './db-name.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token-for-cli-tests';

/** Fixed and obviously a test value; it only ever encrypts rows of the CLI test database. */
const WEBHOOK_SECRET_KEY = Buffer.alloc(32, 0x2b);

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Every question the invocation asked, in order. */
  questions: string[];
  /** The parsed `--json` envelope, when the invocation produced one. */
  json<T = unknown>(): {
    ok: boolean;
    environment: string;
    data?: T;
    error?: { code: string; message: string; fix?: string; param?: string; doc_url: string };
    next_steps?: string[];
  };
}

export interface Project {
  projectId: string;
  testKey: string;
  liveKey: string;
}

export interface Harness {
  /** Base URL of the real HTTP server the CLI talks to. */
  url: string;
  /** Every `Authorization` header the server has seen, in order. */
  seenKeys: string[];
  /** Every `<method> <path>` the server has seen, in order. */
  seenRequests: string[];
  /**
   * Every `<method> <path><?query>` the server has seen, in order.
   *
   * Separate from {@link seenRequests}, which many tests match against exactly: the query
   * string is what proves a filter was pushed to the server instead of applied locally.
   */
  seenUrls: string[];
  /** The `Bookrail-Actor` header of every request, `null` when the request carried none. */
  seenActors: (string | null)[];
  /** Every `Idempotency-Key` the server has seen, as `<method> <path> <key>`. */
  idempotencyKeys: string[];
  /** A fresh working directory, wiped at the end. */
  workdir(): Promise<string>;
  /** Creates an account, a project and its two secret keys. */
  bootstrap(name: string): Promise<Project>;
  /** Runs the CLI in-process with an isolated home, cwd and environment. */
  cli(
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      home?: string;
      tty?: boolean;
      /**
       * Answers a prompt would get, in order. Giving any makes `Io.prompt` exist, which is
       * what a terminal means to the CLI; without them there is no prompt at all, which is
       * what a pipe means.
       */
      answers?: string[];
      /** What `Io.readStdin()` returns. Empty when not given, as a closed pipe would be. */
      stdin?: string;
      /** Interrupt (Ctrl-C) the invocation after this many milliseconds. */
      interruptAfterMs?: number;
    },
  ): Promise<CliResult>;
  /** The isolated `$XDG_CONFIG_HOME` the credentials file lives in. */
  configHome: string;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  // Small pools on purpose: `pnpm test` at the root runs the packages in parallel against a
  // Postgres with `max_connections = 20` on the development machine.
  const appPool = createPool({ connectionString: urls.app, max: 3 });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const cache = new MemoryAvailabilityCache();

  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger: silentLogger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    // `bookrail webhooks` needs the app to be able to store a signing secret
    // and to deliver to the `node:http` receiver `webhooks listen` opens on 127.0.0.1. The
    // second flag lives in `AppDeps` and is deliberately unreachable from the environment.
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    allowPrivateWebhookTargets: true,
  });

  const seenKeys: string[] = [];
  const seenRequests: string[] = [];
  const seenUrls: string[] = [];
  const seenActors: (string | null)[] = [];
  const idempotencyKeys: string[] = [];

  // A real socket, not `app.request`: the point of this suite is that the binary speaks HTTP
  // to something that answers HTTP. The recorder in front of it is what proves that no live
  // key ever leaves the process without `--live`.
  const server: ServerType = serve({
    fetch: (request: Request) => {
      const authorization = request.headers.get('authorization');
      if (authorization) seenKeys.push(authorization.replace(/^Bearer\s+/i, ''));
      const parsed = new URL(request.url);
      const path = parsed.pathname;
      seenRequests.push(`${request.method} ${path}`);
      seenUrls.push(`${request.method} ${path}${parsed.search}`);
      seenActors.push(request.headers.get('bookrail-actor'));
      const idempotency = request.headers.get('idempotency-key');
      if (idempotency) idempotencyKeys.push(`${request.method} ${path} ${idempotency}`);
      return app.fetch(request);
    },
    port: 0,
    hostname: '127.0.0.1',
  });

  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const root = await mkdtemp(join(tmpdir(), 'bookrail-cli-'));
  const configHome = join(root, 'config');
  let counter = 0;

  async function bootstrap(name: string): Promise<Project> {
    const response = await fetch(`${url}/internal/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${BOOTSTRAP_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        account_name: name,
        project_name: name,
        default_timezone: 'Europe/Rome',
      }),
    });
    if (response.status !== 201) {
      throw new Error(`bootstrap failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      project: { id: string };
      secrets: { test: string; live: string };
    };
    // The bootstrap call is not the CLI, and its own key must not pollute the recorder.
    seenKeys.length = 0;
    seenRequests.length = 0;
    return {
      projectId: body.project.id,
      testKey: body.secrets.test,
      liveKey: body.secrets.live,
    };
  }

  return {
    url,
    seenKeys,
    seenRequests,
    seenUrls,
    seenActors,
    idempotencyKeys,
    configHome,
    async workdir(): Promise<string> {
      counter += 1;
      return mkdtemp(join(root, `work-${counter}-`));
    },
    bootstrap,
    async cli(args, options = {}): Promise<CliResult> {
      let stdout = '';
      let stderr = '';
      const questions: string[] = [];
      const answers = [...(options.answers ?? [])];
      const interrupts: (() => void)[] = [];
      const io: Io = {
        env: {
          XDG_CONFIG_HOME: configHome,
          BOOKRAIL_API_URL: url,
          ...(options.env ?? {}),
        },
        cwd: options.cwd ?? root,
        // The `home` option was declared and ignored for a while; `bookrail mcp install
        // --client windsurf` writes under the home directory, so a test needs one of its own.
        home: options.home ?? root,
        isTTY: options.tty === true,
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: (chunk) => {
          stderr += chunk;
        },
        readStdin: async () => options.stdin ?? '',
        ...(options.answers === undefined
          ? {}
          : {
              prompt: async (question: string): Promise<string> => {
                questions.push(question);
                return answers.shift() ?? '';
              },
            }),
        onInterrupt: (handler) => {
          interrupts.push(handler);
          return () => {
            const index = interrupts.indexOf(handler);
            if (index >= 0) interrupts.splice(index, 1);
          };
        },
      };
      const timer =
        options.interruptAfterMs === undefined
          ? null
          : setTimeout(() => {
              for (const handler of [...interrupts]) handler();
            }, options.interruptAfterMs);
      let code: number;
      try {
        code = await run(args, io);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      return {
        code,
        stdout,
        stderr,
        questions,
        json() {
          try {
            return JSON.parse(stdout);
          } catch {
            throw new Error(`stdout is not JSON:\n${stdout}\n--- stderr ---\n${stderr}`);
          }
        },
      };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cache.close();
      await appPool.end();
      await adminPool.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
