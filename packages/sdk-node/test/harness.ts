/**
 * The real thing: `createApp` from `@bookrail/api` behind `@hono/node-server`, on a real
 * socket, against the real Postgres named by `DATABASE_URL`.
 *
 * Nothing is mocked here. The SDK speaks HTTP to something that answers HTTP, the rows are
 * written by the real engine under Row Level Security, and the webhook deliveries are signed by
 * the real dispatcher and arrive at a real `node:http` receiver. The recorder in front of the
 * app is what makes the operation-coverage check possible.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createApp, DEFAULT_PAYMENT_TIMEOUT_MINUTES, MemoryRateLimiter } from '@bookrail/api';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { silentLogger } from '@bookrail/shared';
import Bookrail, { type BookrailOptions } from '../src/index.js';
import { TEST_DB_NAME } from './db-name.js';
import { operationFor } from './operations.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token-for-sdk-tests';

/** Fixed and obviously a test value; it only ever encrypts rows of the SDK test database. */
const WEBHOOK_SECRET_KEY = Buffer.alloc(32, 0x5d);

export interface Project {
  projectId: string;
  testKey: string;
  liveKey: string;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
}

export interface Harness {
  url: string;
  /**
   * The privileged pool, for the one fixture this package cannot build through the API.
   *
   * A payment is created by `POST /v1/bookings` with a `payment.mode`, which needs a Stripe
   * platform **and** a connected account. Proving that whole flow is `@bookrail/api`'s job and
   * it does it against a fake Stripe; what this package owes is that `payments.retrieve` and
   * `payments.list` build the right request and return the declared type, and for that one row
   * written directly is honest and enough.
   */
  adminPool: ReturnType<typeof createPool>;
  /** Every request the server saw, in order. */
  seen: SeenRequest[];
  /** The `operationId` of every request that matched the registry, in order. */
  operations: string[];
  bootstrap(name: string): Promise<Project>;
  /** A client pointed at this server. */
  client(secretKey: string, options?: BookrailOptions): Bookrail;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Mount the per key rate limiter, with one ceiling: what a client does when it is refused
   * does not depend on which environment the key belongs to, and the choice between the two
   * policies is asserted where it is made, in `packages/api/test/rate-limit-api.test.ts`.
   *
   * Off by default: the round trip below makes several hundred calls with one key and would
   * otherwise spend its time waiting. The suite that is about the limiter asks for a ceiling it
   * can reach in three calls, which is what `RATE_LIMIT_TEST_RPS` and `RATE_LIMIT_TEST_BURST` set
   * on a deployment.
   */
  rateLimit?: { rate: number; burst: number };
  /**
   * A Stripe platform pointed at {@link startFakeStripe}, so that `bookrail.stripe.*` can be
   * exercised against a success rather than against the `503` of a deployment that is not a
   * Connect platform.
   */
  stripeBase?: string;
}

/**
 * A fake Stripe on a real socket, in this process.
 *
 * Much smaller than the one in `@bookrail/api`'s own suite, because what is proved here is
 * different: that `bookrail.stripe.*` builds the right requests and returns the declared types,
 * not that the API's Stripe logic is right. It answers the three calls this package makes and
 * nothing else.
 */
export interface FakeStripe {
  url: string;
  /** The account the next authorisation hands back. */
  stripeUserId: string;
  close(): Promise<void>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const state = { stripeUserId: 'acct_SdkTest' };
  const server = createServer((request, response) => {
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

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const appPool = createPool({ connectionString: urls.app, max: 4 });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const cache = new MemoryAvailabilityCache();
  const rateLimiter = new MemoryRateLimiter();

  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger: silentLogger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    paymentTimeoutMinutes: DEFAULT_PAYMENT_TIMEOUT_MINUTES,
    // This package has no method for the sign up endpoints, so there is nothing here to send:
    // an SDK is constructed with a key, and those three are how a key comes into being.
    mailer: undefined,
    siteUrl: 'https://bookrail.dev',
    siteOrigin: 'https://bookrail.dev',
    // The receiver below lives on 127.0.0.1, which the SSRF guard refuses in production.
    allowPrivateWebhookTargets: true,
    ...(options.stripeBase === undefined
      ? {}
      : {
          stripe: {
            redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
            environments: {
              test: {
                // One OAuth application per mode: a Stripe application is itself live or test,
                // and it is the application that decides the mode of the authorisation.
                clientId: 'ca_SdkTestApplication',
                secretKey: 'rk_test_sdkHarness',
                publishableKey: 'pk_test_sdkHarness',
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

  const seen: SeenRequest[] = [];
  const operations: string[] = [];

  const server: ServerType = serve({
    fetch: (request: Request) => {
      const parsed = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      seen.push({
        method: request.method,
        path: parsed.pathname,
        query: parsed.search,
        headers,
      });
      const operation = operationFor(request.method, parsed.pathname);
      if (operation !== null) operations.push(operation);
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
  const url = `http://127.0.0.1:${String(port)}`;

  return {
    url,
    seen,
    operations,
    adminPool,
    async bootstrap(name: string): Promise<Project> {
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
        throw new Error(`bootstrap failed: ${String(response.status)} ${await response.text()}`);
      }
      const body = (await response.json()) as {
        project: { id: string };
        secrets: { test: string; live: string };
      };
      // `POST /internal/bootstrap` is not in the registry, so it never counts as coverage;
      // the recorder is deliberately **not** cleared here, because a second project must not
      // erase what the first one proved.
      return { projectId: body.project.id, testKey: body.secrets.test, liveKey: body.secrets.live };
    },
    client(secretKey: string, options: BookrailOptions = {}): Bookrail {
      return new Bookrail(secretKey, { baseUrl: url, ...options });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rateLimiter.close();
      await cache.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}

export interface Received {
  headers: Record<string, string>;
  body: string;
}

/** A minimal webhook receiver on a real socket: records what arrives, answers what it is told. */
export class Receiver {
  status = 200;
  readonly requests: Received[] = [];

  constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  get url(): string {
    return `${this.origin}/hook`;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      this.requests.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(this.status, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

export async function startReceiver(): Promise<Receiver> {
  const holder: { current: Receiver | null } = { current: null };
  const server = createServer((request, response) => holder.current?.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const receiver = new Receiver(server, `http://127.0.0.1:${String(address.port)}`);
  holder.current = receiver;
  return receiver;
}
