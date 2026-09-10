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
import { createDatabase, createPool } from '@bookrail/db';
import { createLogger } from '@bookrail/shared';
import { createAvailabilityCache } from './cache.js';
import { loadConfig } from './config.js';
import { startWorker } from './jobs/index.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'bookrail-worker' } });

const appPool = createPool({ connectionString: config.urls.app, max: 4 });
const cache = createAvailabilityCache(config.redisUrl, logger);

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
  },
);

logger.info('worker_started', {
  database: config.urls.databaseName,
  hold_expiry_interval_seconds: config.holdExpiryIntervalSeconds,
  availability_cache: config.redisUrl === undefined ? 'memory' : 'redis',
  webhook_secret_key: config.webhookSecretKey === undefined ? 'missing' : 'configured',
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void worker
      .stop()
      .then(() => Promise.all([appPool.end(), cache.close()]))
      .finally(() => process.exit(0));
  });
}
