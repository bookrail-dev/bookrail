import { serve } from '@hono/node-server';
import { createDatabase, createPool } from '@bookrail/db';
import { createLogger } from '@bookrail/shared';
import { createApp } from './app.js';
import { createAvailabilityCache } from './cache.js';
import { loadConfig } from './config.js';
import { startWorker, type Worker } from './jobs/index.js';
import { createLogMailer, createSmtpMailer, type Mailer } from './mail/index.js';
import { createRateLimiter } from './rate-limit.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'bookrail-api' } });

const appPool = createPool({ connectionString: config.urls.app });

/**
 * The privileged pool exists **only** when `POST /internal/bootstrap` does.
 *
 * The rule is the smallest privilege that works, and until now every API process opened a superuser
 * pool whether or not anything could reach it: without `BOOKRAIL_BOOTSTRAP_TOKEN` the `/internal`
 * routes are not mounted at all (see `app.ts`), so the pool was a connection with the right to
 * write `accounts`, `projects` and `api_keys` sitting open behind a door with no handle.
 *
 * When there is no token, `adminDb` is the **application** database. It is unreachable (the one
 * route that reads it is not registered), and pointing it at the RLS-bound role rather than at a
 * plausible-looking stub means that a future caller which forgot the check would see nothing
 * instead of everything, which is the direction a mistake here has to fail in.
 */
const adminPool =
  config.bootstrapToken === undefined
    ? null
    : createPool({ connectionString: config.urls.admin, max: 2 });

const cache = createAvailabilityCache(config.redisUrl, logger);

/**
 * The rate limiter, on its own Redis connection.
 *
 * A second client rather than the cache's, because the two want opposite settings from the same
 * server: the cache waits a second for an answer, since a miss costs a recomputation, and the
 * limiter waits fifty milliseconds, since waiting buys it nothing. One connection cannot have
 * both command timeouts, and the limiter is on the path of every single request.
 */
const rateLimiter = config.rateLimit.enabled ? createRateLimiter(config.redisUrl) : null;

const db = createDatabase(appPool);
const adminDb = adminPool === null ? db : createDatabase(adminPool);

/**
 * The mailer, or nothing at all.
 *
 * Nothing at all is a supported deployment: `/v1/signups` then answers `503 signup_disabled`
 * with the address to write to, which is the state this product was in before self service
 * existed and is still the truth for anybody self hosting without a mailbox. The one
 * combination that cannot happen is `log` in production, and `loadConfig` has already refused
 * to return from that.
 */
const mailer: Mailer | undefined =
  config.mailer === undefined
    ? undefined
    : config.mailer === 'log'
      ? createLogMailer(logger)
      : await createSmtpMailer({
          url: config.smtpUrl ?? '',
          from: config.mailFrom ?? '',
        });

const app = createApp({
  db,
  adminDb,
  logger,
  cache,
  bootstrapToken: config.bootstrapToken,
  webhookSecretKey: config.webhookSecretKey,
  mailer,
  siteUrl: config.siteUrl,
  siteOrigin: config.siteOrigin,
  ...(rateLimiter === null
    ? {}
    : {
        rateLimit: {
          limiter: rateLimiter,
          limits: { test: config.rateLimit.test, live: config.rateLimit.live },
        },
      }),
});

/**
 * The background worker runs inside the API process by default.
 *
 * A single process is the whole deployment for anyone running Bookrail themselves, and a
 * sweeper that has to be remembered separately is a sweeper that will be forgotten, the
 * symptom being stale availability and late `hold.expired` events, neither of which looks
 * like a missing process. A deployment that would rather run it on its own (`pnpm worker`)
 * sets `BOOKRAIL_WORKER=off` here; pg-boss makes two copies harmless anyway, since the
 * queue's `short` policy admits one queued job per name whatever the number of instances.
 */
let worker: Worker | null = null;
if (config.worker) {
  worker = await startWorker(
    { db, cache, logger, webhookSecretKey: config.webhookSecretKey },
    {
      connectionString: config.urls.admin,
      intervalSeconds: config.holdExpiryIntervalSeconds,
      webhookOutboxIntervalSeconds: config.webhookOutboxIntervalSeconds,
      webhookDeliveryIntervalSeconds: config.webhookDeliveryIntervalSeconds,
      integrityCheckCron: config.integrityCheckCron,
      integrityCheckMaxWindows: config.integrityCheckMaxWindows,
      orphanReconcileCron: config.orphanReconcileCron,
      orphanReconcileHorizonDays: config.orphanReconcileHorizonDays,
      orphanReconcileLimit: config.orphanReconcileLimit,
      orphanReconcileScopes: config.orphanReconcileScopes,
    },
  );
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  logger.info('listening', {
    address: info.address,
    port: info.port,
    database: config.urls.databaseName,
    admin_pool: adminPool === null ? 'none' : 'open',
    availability_cache: config.redisUrl === undefined ? 'memory' : 'redis',
    rate_limiter: rateLimiter === null ? 'off' : rateLimiter.kind,
    rate_limit_test: `${String(config.rateLimit.test.rate)}/s burst ${String(config.rateLimit.test.burst)}`,
    rate_limit_live: `${String(config.rateLimit.live.rate)}/s burst ${String(config.rateLimit.live.burst)}`,
    worker: config.worker ? config.holdExpiryIntervalSeconds : 'off',
    webhook_secret_key: config.webhookSecretKey === undefined ? 'missing' : 'configured',
    mailer: config.mailer ?? 'off',
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([
      worker === null ? Promise.resolve() : worker.stop(),
      appPool.end(),
      adminPool === null ? Promise.resolve() : adminPool.end(),
      cache.close(),
      rateLimiter === null ? Promise.resolve() : rateLimiter.close(),
      mailer === undefined ? Promise.resolve() : mailer.close(),
    ]).finally(() => process.exit(0));
  });
}

console.error(`bookrail api starting on ${config.host}:${config.port}`);
