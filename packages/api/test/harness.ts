import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache, type AvailabilityCache } from '@bookrail/engine';
import { silentLogger, type Logger } from '@bookrail/shared';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/context.js';
import { createLogMailer, type LogMailer } from '../src/mail/index.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/rate-limit.js';
import { COVERAGE_FILE_ENV, takeContractViolations } from '../src/openapi/contract.js';
import { COVERAGE_FILE } from './coverage-file.js';
import { TEST_DB_NAME } from './db-name.js';

export const BOOTSTRAP_TOKEN = 'bootstrap-token-for-tests';

/**
 * The 32 byte key that encrypts webhook signing secrets in the test database.
 *
 * Fixed rather than random so that a row written by one suite is still readable by the next
 * one on the same database, and obviously a test value.
 */
export const WEBHOOK_SECRET_KEY = Buffer.alloc(32, 0x2b);

/** Where the confirmation link points in a test, and the origin the sign up routes allow. */
export const SITE_URL = 'https://bookrail.dev';
export const SITE_ORIGIN = 'https://bookrail.dev';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface BootstrappedProject {
  projectId: string;
  testKey: string;
  liveKey: string;
  apiKeyIds: string[];
}

export interface Harness {
  app: Hono<AppEnv>;
  /** The availability cache the app was built with, so a test can inspect or invalidate it. */
  cache: AvailabilityCache;
  call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<ApiResponse<T>>;
  bootstrap(name: string): Promise<BootstrappedProject>;
  pools: { app: Pool; admin: Pool };
  /** The logger the app was built with, for a test that calls a job function directly. */
  logger: Logger;
  /** The key the app encrypts webhook secrets with, for a test that calls the worker directly. */
  webhookSecretKey: Buffer;
  /** The rate limiter the app was built with, `null` when the limit is off. */
  rateLimiter: RateLimiter | null;
  /**
   * The mailer the app was built with, unless the test asked for none.
   *
   * It is the `log` one, which keeps every message it "sent" in memory, so a test reads the
   * confirmation link out of the message the API actually produced rather than out of a value
   * the test made up. `undefined` when the harness was built with `mailer: false`, which is how
   * the `503 signup_disabled` answer is exercised.
   */
  mailer: LogMailer | undefined;
  close(): Promise<void>;
}

export interface HarnessOptions {
  cache?: AvailabilityCache;
  /**
   * Let webhooks point at 127.0.0.1, which every delivery test needs and no deployment gets:
   * the flag lives in `AppDeps` and is deliberately unreachable from the environment.
   */
  allowPrivateWebhookTargets?: boolean;
  logger?: Logger;
  /**
   * Validate every response against the schema the OpenAPI document declares for it, and
   * record which operations the suite exercises. On by default: a suite that ran without it
   * would prove the API works and prove nothing about the specification. A test turns it off
   * only if it deliberately produces a response outside the contract. None does today.
   */
  contract?: boolean;
  /**
   * `false` builds the app with no mailer at all, which is a deployment that has not configured
   * one: the three sign up endpoints then answer `503 signup_disabled`. `'failing'` builds one
   * that refuses every message, which is a mail server that is down: `502 signup_email_failed`.
   */
  mailer?: false | 'failing';
  /** The origin `/v1/signups` allows in a browser. Defaults to the production one. */
  siteOrigin?: string;
  /**
   * Mount the per key rate limiter: this policy for test keys, and `live` for live ones.
   *
   * **Off by default**, which is what every other suite in this package needs: they fire hundreds
   * of requests at one key inside a second, and with a limit in front of them they would be
   * measuring the limiter. The suite that is about the limiter asks for it, with a ceiling low
   * enough to reach in three calls.
   *
   * `live` defaults to the same numbers, because most of the tests here care about one key. The
   * one that cares about the choice between the two policies gives the two environments different
   * ceilings, so that a middleware reading the wrong one could not pass.
   *
   * `limiter` replaces the in-process one, which is how the Redis implementation and an
   * unreachable Redis are exercised. The harness closes whichever limiter ends up mounted.
   */
  rateLimit?: {
    rate: number;
    burst: number;
    live?: { rate: number; burst: number };
    limiter?: RateLimiter;
  };
}

/** Fails the test that produced the violation, naming the request. */
function assertNoContractViolations(what: string): void {
  const found = takeContractViolations();
  if (found.length === 0) return;
  throw new Error(
    `OpenAPI contract violated by ${what}:\n  ${found.join('\n  ')}\n` +
      'The response and the specification disagree. Either the schema in ' +
      '`src/schemas/responses.ts` is wrong, or the response is.',
  );
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const appPool = createPool({ connectionString: urls.app, max: 5 });
  const adminPool = createPool({ connectionString: urls.admin, max: 2 });
  const cache = options.cache ?? new MemoryAvailabilityCache();

  const logger = options.logger ?? silentLogger;
  const mailer: LogMailer | undefined =
    options.mailer === false ? undefined : createLogMailer(logger);
  if (options.mailer === 'failing' && mailer !== undefined) {
    // A mail server that is down, which is the only way to reach `502 signup_email_failed`
    // without one. Everything else about the request is real, the row included.
    mailer.send = (): Promise<void> => Promise.reject(new Error('connection refused'));
  }
  const contract = options.contract !== false;
  if (contract) process.env[COVERAGE_FILE_ENV] = COVERAGE_FILE;
  const rateLimitPolicy = options.rateLimit;
  const rateLimiter =
    rateLimitPolicy === undefined ? null : (rateLimitPolicy.limiter ?? new MemoryRateLimiter());
  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    mailer,
    siteUrl: SITE_URL,
    siteOrigin: options.siteOrigin ?? SITE_ORIGIN,
    ...(rateLimitPolicy === undefined || rateLimiter === null
      ? {}
      : {
          rateLimit: {
            limiter: rateLimiter,
            limits: {
              test: { rate: rateLimitPolicy.rate, burst: rateLimitPolicy.burst },
              live: rateLimitPolicy.live ?? {
                rate: rateLimitPolicy.rate,
                burst: rateLimitPolicy.burst,
              },
            },
          },
        }),
    // `app.request` opens no socket, so without this every request would count against the
    // single `unknown` bucket and the per caller limit would fire after ten tests.
    trustForwardedFor: true,
    allowPrivateWebhookTargets: options.allowPrivateWebhookTargets === true,
    contractGuard: contract,
  });

  async function call<T>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await app.request(path, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    // Thrown here rather than inside the guard: an exception raised in the middleware would be
    // caught by `app.onError` and answered as a 500, which is precisely the shape of failure a
    // contract violation must not be allowed to take (`src/openapi/contract.ts`).
    assertNoContractViolations(`${method} ${path}`);
    return {
      status: response.status,
      headers: response.headers,
      body: (text ? JSON.parse(text) : null) as T,
    };
  }

  async function bootstrap(name: string): Promise<BootstrappedProject> {
    const response = await call<{
      project: { id: string };
      api_keys: { id: string }[];
      secrets: { test: string; live: string };
    }>('POST', '/internal/bootstrap', {
      token: BOOTSTRAP_TOKEN,
      body: { account_name: name, project_name: name, default_timezone: 'Europe/Rome' },
    });
    if (response.status !== 201) {
      throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return {
      projectId: response.body.project.id,
      testKey: response.body.secrets.test,
      liveKey: response.body.secrets.live,
      apiKeyIds: response.body.api_keys.map((k) => k.id),
    };
  }

  return {
    app,
    cache,
    call,
    bootstrap,
    pools: { app: appPool, admin: adminPool },
    logger,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    rateLimiter,
    mailer,
    async close(): Promise<void> {
      assertNoContractViolations('a request made outside harness.call');
      if (rateLimiter !== null) await rateLimiter.close();
      await cache.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}
