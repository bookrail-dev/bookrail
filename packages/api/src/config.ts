import { resolveDatabaseUrls, type DatabaseUrls } from '@bookrail/db';
import type { LogLevel } from '@bookrail/shared';
import {
  DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS,
  DEFAULT_WEBHOOK_DELIVERY_INTERVAL_SECONDS,
  DEFAULT_WEBHOOK_OUTBOX_INTERVAL_SECONDS,
} from './jobs/worker.js';
import { DEFAULT_INTEGRITY_CHECK_CRON, DEFAULT_ORPHAN_RECONCILE_CRON } from './jobs/worker.js';
import {
  DEFAULT_INTEGRITY_MAX_WINDOWS,
  DEFAULT_RECONCILE_HORIZON_DAYS,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_SCOPES,
} from './jobs/reconcile.js';
import { parseWebhookSecretKey } from './webhooks/secrets.js';

export interface ApiConfig {
  urls: DatabaseUrls;
  port: number;
  /**
   * The interface the HTTP server binds to.
   *
   * `127.0.0.1` under `NODE_ENV=production`, `0.0.0.0` everywhere else, and `HOST` overrides both.
   * The default is that way round because of what is mounted on this server:
   * `POST /internal/bootstrap` creates accounts, projects and API keys on the connection that
   * bypasses RLS, and in production the only thing that may reach it is the machine itself:
   * anything privileged gets the smallest reach that still works. A deployment puts a reverse proxy
   * in front, and the proxy is on the same host; a firewall rule is a second line, not the first.
   * Outside production the server is a development one, often reached from a container or another
   * machine, so it listens everywhere.
   */
  host: string;
  logLevel: LogLevel;
  /**
   * Shared secret for POST /internal/bootstrap. When unset the endpoint does not exist:
   * an unconfigured deployment cannot be talked into creating accounts.
   */
  bootstrapToken: string | undefined;
  /** Shared availability cache. Unset means the process-local LRU. */
  redisUrl: string | undefined;
  /**
   * Background worker (hold expiry, idempotency key purge). On by default, because a
   * deployment that forgets it gets stale availability and late `hold.expired` events rather
   * than a loud failure. `BOOKRAIL_WORKER=off` turns it off: that is how the API test suite
   * runs, and how a deployment that runs `pnpm worker` as its own process avoids a second
   * copy inside every API instance.
   */
  worker: boolean;
  /** Seconds between two hold expiry sweeps. Ten by default. */
  holdExpiryIntervalSeconds: number;
  /** Seconds between two outbox ticks. Five. */
  webhookOutboxIntervalSeconds: number;
  /**
   * The two daily reconciliation jobs: the integrity check and the orphan reconciliation.
   *
   * They are cron jobs and not self-rearming loops: once a day is a schedule cron can express,
   * and unlike the sweeps nothing goes wrong if a run is missed: the next one asks the same
   * question about the same state. Both crons are configurable because "daily at 03:00" is a
   * deployment's business, not ours, and because a test needs them to be "every minute".
   */
  integrityCheckCron: string;
  /** How many live occupancies one integrity run measures. A cap, not a sample. */
  integrityCheckMaxWindows: number;
  orphanReconcileCron: string;
  /**
   * How far ahead the reconciliation looks, in days.
   *
   * The interactive path stops at `DEFAULT_ORPHAN_HORIZON_DAYS` (ninety), because a `PATCH` on a
   * schedule is something a dashboard does while somebody waits. This job has all night, so its
   * horizon is the one that actually covers the bookings that exist.
   */
  orphanReconcileHorizonDays: number;
  /** Bookings one scope's reconciliation examines per run. */
  orphanReconcileLimit: number;
  /** (project, environment) pairs one reconciliation run visits. */
  orphanReconcileScopes: number;
  /** Seconds between two delivery ticks. One: the first retry of the ladder is at three. */
  webhookDeliveryIntervalSeconds: number;
  /**
   * The 32 bytes that encrypt every webhook signing secret at rest. `undefined` when the
   * deployment has not configured one, and the webhook endpoints then fail loudly rather than
   * storing a secret in the clear.
   *
   * There is deliberately **no** environment variable that relaxes the SSRF guard: see
   * `AppDeps.allowPrivateWebhookTargets`.
   */
  webhookSecretKey: Buffer | undefined;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const level = env.LOG_LEVEL;
  return {
    urls: resolveDatabaseUrls({ env }),
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? (env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'),
    logLevel: level && (LOG_LEVELS as string[]).includes(level) ? (level as LogLevel) : 'info',
    bootstrapToken: env.BOOKRAIL_BOOTSTRAP_TOKEN,
    redisUrl: env.REDIS_URL,
    worker: !OFF.has((env.BOOKRAIL_WORKER ?? 'on').toLowerCase()),
    holdExpiryIntervalSeconds: positiveInt(
      env.BOOKRAIL_HOLD_EXPIRY_INTERVAL_SECONDS,
      DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS,
    ),
    webhookOutboxIntervalSeconds: positiveInt(
      env.BOOKRAIL_WEBHOOK_OUTBOX_INTERVAL_SECONDS,
      DEFAULT_WEBHOOK_OUTBOX_INTERVAL_SECONDS,
    ),
    integrityCheckCron: env.BOOKRAIL_INTEGRITY_CHECK_CRON ?? DEFAULT_INTEGRITY_CHECK_CRON,
    integrityCheckMaxWindows: positiveInt(
      env.BOOKRAIL_INTEGRITY_CHECK_MAX_WINDOWS,
      DEFAULT_INTEGRITY_MAX_WINDOWS,
    ),
    orphanReconcileCron: env.BOOKRAIL_ORPHAN_RECONCILE_CRON ?? DEFAULT_ORPHAN_RECONCILE_CRON,
    orphanReconcileHorizonDays: positiveInt(
      env.BOOKRAIL_ORPHAN_RECONCILE_HORIZON_DAYS,
      DEFAULT_RECONCILE_HORIZON_DAYS,
    ),
    orphanReconcileLimit: positiveInt(env.BOOKRAIL_ORPHAN_RECONCILE_LIMIT, DEFAULT_RECONCILE_LIMIT),
    orphanReconcileScopes: positiveInt(
      env.BOOKRAIL_ORPHAN_RECONCILE_SCOPES,
      DEFAULT_RECONCILE_SCOPES,
    ),
    webhookDeliveryIntervalSeconds: positiveInt(
      env.BOOKRAIL_WEBHOOK_DELIVERY_INTERVAL_SECONDS,
      DEFAULT_WEBHOOK_DELIVERY_INTERVAL_SECONDS,
    ),
    webhookSecretKey: parseWebhookSecretKey(env.WEBHOOK_SECRET_KEY),
  };
}

const OFF = new Set(['off', 'false', '0', 'no']);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
