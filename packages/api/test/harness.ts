import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache, type AvailabilityCache } from '@bookrail/engine';
import { silentLogger, type Logger } from '@bookrail/shared';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/context.js';
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
  const contract = options.contract !== false;
  if (contract) process.env[COVERAGE_FILE_ENV] = COVERAGE_FILE;
  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
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
    async close(): Promise<void> {
      assertNoContractViolations('a request made outside harness.call');
      await cache.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}
