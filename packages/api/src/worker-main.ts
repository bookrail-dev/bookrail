/**
 * `pnpm worker`: the background jobs, on their own.
 *
 * The same worker `server.ts` starts inside the API process, for a deployment that would
 * rather scale the two separately: several API replicas with `BOOKRAIL_WORKER=off` and one
 * (or several) of these. Running both is harmless (the queue admits one job per name) but
 * pointless.
 *
 * **One pool, and it is the application one.** The sweeps used to open a
 * second, superuser pool to ask which projects had work; that question is a `SECURITY DEFINER`
 * function now (migration 0013), so nothing here needs a privileged connection. What is left is
 * pg-boss's own connection string, which owns the `pgboss` schema and runs its DDL there: the
 * queue carries no tenant data, which is why keeping it in Postgres costs nothing: there is no
 * second datastore to lose, and a job and the rows it will touch share a database and a backup.
 */
import { hostname } from 'node:os';
import { createDatabase, createPool } from '@bookrail/db';
import { createLogger } from '@bookrail/shared';
import { createAvailabilityCache } from './cache.js';
import { loadConfig } from './config.js';
import { startWorker, usageDigestOffReason } from './jobs/index.js';
import { createLogMailer, createSmtpMailer, type Mailer } from './mail/index.js';
import { createUsageRedis } from './usage-counters.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'bookrail-worker' } });

const appPool = createPool({ connectionString: config.urls.app, max: 4 });
const cache = createAvailabilityCache(config.redisUrl, logger);

/**
 * The mailer, and why this process has one at all.
 *
 * Until the daily usage digest, the worker sent nothing: the one message this product had was
 * the sign up confirmation, and it leaves the API process, in the middle of an HTTP request
 * somebody is waiting on. The digest is the second message and the first one nobody is waiting
 * on, so the worker needs the same three variables as the API (`BOOKRAIL_MAILER`, `SMTP_URL`,
 * `MAIL_FROM`), read by the same `loadConfig`, which is also what keeps `BOOKRAIL_MAILER=log`
 * refused here under `NODE_ENV=production` exactly as it is there.
 *
 * No mailer means no digest: the job is not registered, and the line below says so.
 */
const mailer: Mailer | undefined =
  config.mailer === undefined
    ? undefined
    : config.mailer === 'log'
      ? createLogMailer(logger)
      : await createSmtpMailer({ url: config.smtpUrl ?? '', from: config.mailFrom ?? '' });

/** The reader of the request counters. Absent without `REDIS_URL`, and the digest says so. */
const usageRedis =
  config.usageDigestTo === undefined || mailer === undefined
    ? undefined
    : createUsageRedis(config.redisUrl);

const worker = await startWorker(
  {
    db: createDatabase(appPool),
    cache,
    logger,
    webhookSecretKey: config.webhookSecretKey,
  },
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
    ...(config.usageDigestTo === undefined || mailer === undefined
      ? {
          usageDigestOffReason:
            usageDigestOffReason({ to: config.usageDigestTo, mailer }) ?? undefined,
        }
      : {
          usageDigest: {
            to: config.usageDigestTo,
            cron: config.usageDigestCron,
            host: hostname(),
            mailer,
            usageRedis,
          },
        }),
  },
);

logger.info('worker_started', {
  database: config.urls.databaseName,
  hold_expiry_interval_seconds: config.holdExpiryIntervalSeconds,
  availability_cache: config.redisUrl === undefined ? 'memory' : 'redis',
  webhook_secret_key: config.webhookSecretKey === undefined ? 'missing' : 'configured',
  mailer: config.mailer ?? 'off',
  usage_digest: config.usageDigestTo === undefined ? 'off' : config.usageDigestCron,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void worker
      .stop()
      .then(() =>
        Promise.all([
          appPool.end(),
          cache.close(),
          mailer === undefined ? Promise.resolve() : mailer.close(),
          usageRedis === undefined ? Promise.resolve() : usageRedis.quit().then(() => undefined),
        ]),
      )
      .finally(() => process.exit(0));
  });
}
