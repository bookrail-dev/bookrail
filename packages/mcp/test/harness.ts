import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp, MemoryRateLimiter, DEFAULT_PAYMENT_TIMEOUT_MINUTES } from '@bookrail/api';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { silentLogger as silentApiLogger } from '@bookrail/shared';
import { createServer } from '../src/server.js';
import { createLogger, type LogLevel } from '../src/log.js';
import { TEST_DB_NAME } from './db-name.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token-for-mcp-tests';
const WEBHOOK_SECRET_KEY = Buffer.alloc(32, 0x3c);

export interface Project {
  projectId: string;
  testKey: string;
  liveKey: string;
}

export interface Session {
  client: Client;
  /** Every line the server wrote to its logger, which is the only stream it has. */
  stderr: string[];
  close(): Promise<void>;
  /** Calls a tool and returns the parsed envelope, whatever the outcome. */
  call<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    isError: boolean;
    envelope: {
      ok: boolean;
      environment: string;
      data?: T;
      next_steps?: string[];
      requires_confirmation?: boolean;
      preview?: unknown;
      error?: { code: string; message: string; fix?: string; doc_url: string };
    };
    raw: CallToolResult;
  }>;
}

export interface Harness {
  url: string;
  /** Every `Authorization` header the API has seen, in order. */
  seenKeys: string[];
  /** Every `<method> <path>` the API has seen, in order. */
  seenRequests: string[];
  /** The `Bookrail-Actor` of every request, `null` when one carried none. */
  seenActors: (string | null)[];
  configHome: string;
  root: string;
  /**
   * The privileged pool, for the one fixture this package cannot build through a tool.
   *
   * A `payments` row needs a Stripe platform **and** a connected account; proving that flow is
   * `@bookrail/api`'s job, against a fake Stripe. What the two payment tools owe is that they
   * reach the right endpoint and hand back what it said, and one row written directly is enough
   * for that.
   */
  adminPool: ReturnType<typeof createPool>;
  workdir(): Promise<string>;
  bootstrap(name: string): Promise<Project>;
  /**
   * Empties every rate limit bucket, so the next call starts from a full budget.
   *
   * A test that waited for the budget to come back instead would be asserting a clock: it would
   * pass while the machine is idle and fail on the day the suite runs beside a build.
   */
  resetRateLimit(): void;
  /**
   * Starts one MCP server and connects an in-process client to it over a linked pair of
   * in-memory transports: a real client speaking the real protocol to the real server, with
   * no process boundary and therefore no stdout in the picture at all.
   */
  session(options?: {
    cwd?: string;
    home?: string;
    env?: Record<string, string>;
    log?: LogLevel;
  }): Promise<Session>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Mount the per key rate limiter, with one ceiling: what a client does when it is refused
   * does not depend on which environment the key belongs to, and the choice between the two
   * policies is asserted where it is made, in `packages/api/test/rate-limit-api.test.ts`.
   *
   * Off by default: the flow suite makes a long sequence of calls with one key. The test that is
   * about the limit asks for a ceiling it can reach in two calls, which is what
   * `RATE_LIMIT_TEST_RPS` and `RATE_LIMIT_TEST_BURST` set on a deployment.
   */
  rateLimit?: { rate: number; burst: number };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const appPool = createPool({ connectionString: urls.app, max: 3 });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const cache = new MemoryAvailabilityCache();
  const rateLimiter = new MemoryRateLimiter();

  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger: silentApiLogger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    paymentTimeoutMinutes: DEFAULT_PAYMENT_TIMEOUT_MINUTES,
    // There is no sign up tool and there will not be one: a sign up needs a person to open a
    // link in a mailbox, and an agent has neither. Nothing here sends mail.
    mailer: undefined,
    siteUrl: 'https://bookrail.dev',
    siteOrigin: 'https://bookrail.dev',
    allowPrivateWebhookTargets: true,
    // A Stripe platform whose two bases point at a port nothing listens on, deliberately.
    // The two tools this package has (`bookrail_stripe_status`, `bookrail_stripe_connect`) make
    // **no** call to Stripe on the paths they take here: minting an authorisation state is a
    // local write, and reading a connection that does not exist reads nothing but our own
    // database. A base that cannot be reached is therefore the honest configuration: if one of
    // the two ever starts calling Stripe, the test fails instead of quietly talking to a fake.
    stripe: {
      redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
      environments: {
        // One OAuth application per mode, as Stripe requires.
        test: {
          clientId: 'ca_McpTestApplication',
          secretKey: 'rk_test_mcpHarness',
          publishableKey: 'pk_test_mcpHarness',
        },
        live: {
          clientId: 'ca_McpLiveApplication',
          secretKey: 'rk_live_mcpHarness',
          publishableKey: 'pk_live_mcpHarness',
        },
      },
      webhookSecrets: { test: null, live: null },
      apiBase: 'http://127.0.0.1:1',
      connectBase: 'http://127.0.0.1:1',
    },
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
  const seenActors: (string | null)[] = [];

  const server: ServerType = serve({
    fetch: (request: Request) => {
      const authorization = request.headers.get('authorization');
      if (authorization) seenKeys.push(authorization.replace(/^Bearer\s+/i, ''));
      seenRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      seenActors.push(request.headers.get('bookrail-actor'));
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

  const root = await mkdtemp(join(tmpdir(), 'bookrail-mcp-'));
  const configHome = join(root, 'config');
  const sessions: Session[] = [];
  let counter = 0;

  return {
    url,
    seenKeys,
    seenRequests,
    seenActors,
    configHome,
    root,
    adminPool,
    async workdir(): Promise<string> {
      counter += 1;
      return mkdtemp(join(root, `work-${counter}-`));
    },
    resetRateLimit(): void {
      rateLimiter.clear();
    },
    async bootstrap(name): Promise<Project> {
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
      seenKeys.length = 0;
      seenRequests.length = 0;
      seenActors.length = 0;
      return { projectId: body.project.id, testKey: body.secrets.test, liveKey: body.secrets.live };
    },
    async session(options = {}): Promise<Session> {
      const stderr: string[] = [];
      const { server: mcp } = createServer({
        cwd: options.cwd ?? root,
        home: options.home ?? root,
        env: {
          XDG_CONFIG_HOME: configHome,
          BOOKRAIL_API_URL: url,
          ...(options.env ?? {}),
        },
        logger: createLogger(options.log ?? 'debug', (chunk) => {
          stderr.push(chunk.trimEnd());
        }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'bookrail-mcp-test', version: '0.0.0' });
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

      const session: Session = {
        client,
        stderr,
        async close(): Promise<void> {
          await client.close();
          await mcp.close();
        },
        async call(name, args = {}) {
          const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
          const first = raw.content?.[0];
          if (first === undefined || first.type !== 'text') {
            throw new Error(`${name} returned no text content: ${JSON.stringify(raw)}`);
          }
          return {
            isError: raw.isError === true,
            envelope: JSON.parse(first.text),
            raw,
          };
        },
      };
      sessions.push(session);
      return session;
    },
    async close(): Promise<void> {
      for (const session of sessions) {
        try {
          await session.close();
        } catch {
          /* a test may have closed it already */
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rateLimiter.close();
      await cache.close();
      await appPool.end();
      await adminPool.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The padel courts model, as the object an agent would hand to `bookrail_config_push`. */
export const PADEL_CONFIG = {
  locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],
  schedules: {
    club_hours: {
      name: 'Club hours',
      timezone: 'Europe/Rome',
      rules: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '08:00', to: '23:00' },
      ],
    },
  },
  resources: [
    { id: 'court_1', name: 'Court 1', type: 'court', location: 'club', schedule: 'club_hours' },
    { id: 'court_2', name: 'Court 2', type: 'court', location: 'club', schedule: 'club_hours' },
  ],
  resourceGroups: {
    courts: {
      name: 'Courts',
      resources: ['court_1', 'court_2'],
      allocationStrategy: 'first_available',
    },
  },
  policies: {
    prepaid: {
      name: 'Prepaid',
      cancellation: [
        { before: '12h', refundPercent: 100 },
        { before: '0h', refundPercent: 0 },
      ],
      holdDuration: '10m',
    },
  },
  services: [
    {
      id: 'match',
      name: 'Match',
      durationOptions: [60, 90],
      slotInterval: 30,
      alignTo: 'hour',
      price: { amount: 3000, currency: 'EUR' },
      policy: 'prepaid',
      bookingWindow: { minNoticeMinutes: 60, maxAdvanceDays: 30 },
      requirements: [{ group: 'courts', quantity: 1 }],
    },
  ],
};

const DAY_MS = 86_400_000;

/** Midnight UTC of a day a week out, so nothing is near `now` or the booking window's edge. */
export function nextWeek(offsetDays = 7): string {
  const day = new Date(Date.now() + offsetDays * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  return day.toISOString();
}
