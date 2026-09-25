import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import {
  createApp,
  createLogMailer,
  MemoryRateLimiter,
  type LogMailer,
  DEFAULT_PAYMENT_TIMEOUT_MINUTES,
} from '@bookrail/api';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { silentLogger, type PlanTable } from '@bookrail/shared';
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
  /**
   * The privileged pool, for the one fixture this suite cannot build through the CLI.
   *
   * A `payments` row needs a Stripe platform and a connected account, and proving that flow is
   * `@bookrail/api`'s job. What the CLI owes is that `bookrail payments get|list` build the
   * right request and render what comes back, and for that one row written directly is enough.
   */
  adminPool: ReturnType<typeof createPool>;
  /** A fresh working directory, wiped at the end. */
  workdir(): Promise<string>;
  /** Creates an account, a project and its two secret keys. */
  bootstrap(name: string): Promise<Project>;
  /**
   * Empties every rate limit bucket, so the next call starts from a full budget.
   *
   * A test that waited for the budget to come back instead would be asserting a clock: it would
   * pass while the machine is idle and fail on the day the suite runs beside a build.
   */
  resetRateLimit(): void;
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
      /**
       * Interrupt (Ctrl-C) the invocation as soon as this says so.
       *
       * A **condition**, not a delay, and the better of the two. The handler a long running
       * command registers exists only once that command has got as far as its loop, and how
       * long that takes is a real HTTP round trip plus a call into Postgres: a timer aimed at
       * the middle of that window is right until the machine is loaded, and then fires into an
       * empty list and loses the interrupt. The predicate is polled every few milliseconds and
       * the interrupt is delivered once, when it holds **and** a handler is there to receive it.
       */
      interruptWhen?: () => boolean;
      /**
       * Called with every chunk the invocation writes to stdout, as it writes it.
       *
       * `CliResult.stdout` is the whole of it and arrives only when the command has finished,
       * which is no use for a command that prints something and then waits for the world to
       * change. `bookrail stripe connect` prints the authorisation link and then polls until a
       * browser has used it: a test drives the browser's half, and this is how it learns the
       * link without the command having ended first.
       */
      onStdout?: (chunk: string) => void;
    },
  ): Promise<CliResult>;
  /** The isolated `$XDG_CONFIG_HOME` the credentials file lives in. */
  configHome: string;
  /** The mail the API would have sent, kept in memory. `bookrail signup` reads its link here. */
  mailer: LogMailer;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Build the API with no mailer, which is a deployment that has not configured one: the three
   * sign up endpoints then answer `503 signup_disabled` with the address to write to. It is how
   * the CLI's handling of an error the server explains, and only the server can explain, is
   * exercised.
   */
  mailer?: false;
  /**
   * Build the API as a Stripe Connect platform pointed at {@link startFakeStripe}.
   *
   * Off by default, because every other suite here wants the state a deployment without Stripe
   * credentials is in: `bookrail stripe ...` then reports the `503 stripe_not_configured` the
   * API produced, which is one of the things the Stripe suite checks.
   */
  stripeBase?: string;
  /**
   * Mount the per key rate limiter, with one ceiling: what a client does when it is refused
   * does not depend on which environment the key belongs to, and the choice between the two
   * policies is asserted where it is made, in `packages/api/test/rate-limit-api.test.ts`.
   *
   * Off by default: the operational suite makes hundreds of calls with one key and would spend
   * its time waiting. The suite that is about the limit asks for a ceiling it can reach in two
   * calls, which is what `RATE_LIMIT_TEST_RPS` and `RATE_LIMIT_TEST_BURST` set on a deployment.
   */
  rateLimit?: { rate: number; burst: number };
  /**
   * The plan table the API runs with, when a suite needs a threshold it can reach: the free
   * plan's thousand bookings lowered to a handful, the same arithmetic. The published one by
   * default.
   */
  plans?: PlanTable;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  // Small pools on purpose: `pnpm test` at the root runs the packages in parallel against a
  // Postgres with `max_connections = 20` on the development machine.
  const appPool = createPool({ connectionString: urls.app, max: 3 });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const cache = new MemoryAvailabilityCache();
  const rateLimiter = new MemoryRateLimiter();
  const mailer = createLogMailer(silentLogger);
  const mounted = options.mailer === false ? undefined : mailer;

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
    paymentTimeoutMinutes: DEFAULT_PAYMENT_TIMEOUT_MINUTES,
    // `bookrail signup` runs against the real endpoints; the only thing replaced is the mail
    // server, and the messages stay in memory so a test can read the link out of the one the
    // API actually wrote.
    mailer: mounted,
    siteUrl: 'https://bookrail.dev',
    siteOrigin: 'https://bookrail.dev',
    allowPrivateWebhookTargets: true,
    ...(options.plans === undefined ? {} : { plans: options.plans }),
    ...(options.stripeBase === undefined
      ? {}
      : {
          stripe: {
            redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
            environments: {
              test: {
                // One OAuth application per mode: a Stripe application is itself live or test,
                // and it is the application that decides the mode of the authorisation.
                clientId: 'ca_CliTestApplication',
                secretKey: 'rk_test_cliHarness',
                publishableKey: 'pk_test_cliHarness',
              },
              live: null,
            },
            webhookSecrets: { test: null, live: null },
            apiBase: options.stripeBase,
            connectBase: options.stripeBase,
          },
        }),
    ...(options.rateLimit === undefined
      ? {}
      : {
          rateLimit: {
            limiter: rateLimiter,
            limits: { test: options.rateLimit, live: options.rateLimit },
          },
        }),
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
    adminPool,
    configHome,
    mailer,
    async workdir(): Promise<string> {
      counter += 1;
      return mkdtemp(join(root, `work-${counter}-`));
    },
    bootstrap,
    resetRateLimit(): void {
      rateLimiter.clear();
    },
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
          options.onStdout?.(chunk);
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
      // A delay, when the caller named one, and otherwise the condition: `interruptWhen`
      // subsumes it, and the two are never both given.
      const after = options.interruptAfterMs;
      const startedAt = Date.now();
      const shouldInterrupt =
        options.interruptWhen ??
        (after === undefined ? undefined : () => Date.now() - startedAt >= after);
      let interruptSent = false;
      const timer =
        shouldInterrupt === undefined
          ? null
          : setInterval(() => {
              // Both halves matter: the condition the test named, and a handler to deliver to.
              // Firing into an empty list would lose the interrupt silently, which is what a
              // plain delay did.
              if (interruptSent || interrupts.length === 0 || !shouldInterrupt()) return;
              interruptSent = true;
              for (const handler of [...interrupts]) handler();
            }, 5);
      let code: number;
      try {
        code = await run(args, io);
      } finally {
        if (timer !== null) clearInterval(timer);
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
      await rateLimiter.close();
      await cache.close();
      await appPool.end();
      await adminPool.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * A fake Stripe on a real socket, for `bookrail stripe`.
 *
 * Small on purpose: what these tests prove is what the **command** does (prints the link, opens
 * nothing without a terminal, polls until the API says connected, refuses to disconnect without
 * `--yes`), not what the API does with Stripe, which is proved in `@bookrail/api`'s own suite
 * against a fuller fake.
 */
export interface FakeStripe {
  url: string;
  stripeUserId: string;
  close(): Promise<void>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const state = { stripeUserId: 'acct_CliTest' };
  const server: Server = createHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const answer = (payload: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (path === '/oauth/token') {
        answer({ stripe_user_id: state.stripeUserId, livemode: false, scope: 'read_write' });
        return;
      }
      if (path === '/oauth/deauthorize') {
        answer({ stripe_user_id: state.stripeUserId });
        return;
      }
      if (path.startsWith('/v1/accounts/')) {
        answer({
          id: path.slice('/v1/accounts/'.length),
          charges_enabled: true,
          details_submitted: true,
          default_currency: 'eur',
          country: 'IT',
        });
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"type":"invalid_request_error","message":"no"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    get stripeUserId() {
      return state.stripeUserId;
    },
    set stripeUserId(value: string) {
      state.stripeUserId = value;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
