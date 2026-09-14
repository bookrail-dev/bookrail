import { resolveDatabaseUrls, type DatabaseUrls } from '@bookrail/db';
import type { LogLevel } from '@bookrail/shared';
import type { RateLimitPolicy } from './context.js';
import {
  DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS,
  DEFAULT_INTEGRITY_CHECK_CRON,
  DEFAULT_ORPHAN_RECONCILE_CRON,
  DEFAULT_USAGE_DIGEST_CRON,
  DEFAULT_WEBHOOK_DELIVERY_INTERVAL_SECONDS,
  DEFAULT_WEBHOOK_OUTBOX_INTERVAL_SECONDS,
} from './jobs/worker.js';
import {
  DEFAULT_INTEGRITY_MAX_WINDOWS,
  DEFAULT_RECONCILE_HORIZON_DAYS,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_SCOPES,
} from './jobs/reconcile.js';
import { isMailerKind, MAILER_KINDS, type MailerKind } from './mail/index.js';
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
  /**
   * How the confirmation message of a sign up leaves this process.
   *
   * `undefined` (the variable unset) switches self service sign up off: the three endpoints
   * answer `503 signup_disabled` with the address to write to, and the website says the same
   * thing. That is a deployment choice, not a fault, so it is not an error at start-up.
   */
  mailer: MailerKind | undefined;
  /** `smtps://user:password@host:465`. Required when the mailer is `smtp`. */
  smtpUrl: string | undefined;
  /** `Bookrail <noreply@bookrail.dev>`. Required when the mailer is `smtp`. */
  mailFrom: string | undefined;
  /**
   * Where the daily usage digest goes, and whether it exists at all.
   *
   * `undefined` (the variable unset) means the worker does not register the job: there is no
   * default address, because a report about who is using the service must never be sent to a
   * mailbox nobody chose. A deployment that wants one sets it to an address it reads.
   */
  usageDigestTo: string | undefined;
  /** When the digest runs, in Europe/Rome. `0 7 * * *` unless a deployment says otherwise. */
  usageDigestCron: string;
  /** Where the confirmation link points, and where the pages that read it live. */
  siteUrl: string;
  /** The one browser origin allowed to call `/v1/signups`. */
  siteOrigin: string;
  /**
   * The per key rate limit: whether it is applied at all, and the ceiling per environment.
   *
   * `enabled` is false only when `RATE_LIMIT=off`, which exists for development and for a test
   * that is measuring something else. A deployment never sets it: `install-remote.sh` does not
   * write the variable, so an API without it is an API with the limit on.
   */
  rateLimit: {
    enabled: boolean;
    test: RateLimitPolicy;
    live: RateLimitPolicy;
  };
}

/**
 * The defaults, and where each number comes from.
 *
 * The test ceiling is the one the pricing table has always printed against the free tier, 20
 * requests a second. The live one is the number the API reference has always printed, 100 a
 * second with a burst of 500. Neither is a measurement: they are both far above anything a real
 * integration does (a booking flow is a handful of calls per customer) and far below what one
 * process can serve, so they bound a runaway script without being in anybody's way. The burst of
 * a test key is twice its rate, which covers a cold start that sets up a project in one go.
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<'test' | 'live', RateLimitPolicy>> = {
  test: { rate: 20, burst: 40 },
  live: { rate: 100, burst: 500 },
};

export const DEFAULT_SITE_URL = 'https://bookrail.dev';

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
    mailer: resolveMailerKind(env),
    smtpUrl: trimmed(env.SMTP_URL),
    mailFrom: trimmed(env.MAIL_FROM),
    usageDigestTo: trimmed(env.USAGE_DIGEST_TO),
    usageDigestCron: trimmed(env.USAGE_DIGEST_CRON) ?? DEFAULT_USAGE_DIGEST_CRON,
    siteUrl: trimSlash(trimmed(env.BOOKRAIL_SITE_URL) ?? DEFAULT_SITE_URL),
    siteOrigin: trimSlash(trimmed(env.BOOKRAIL_SITE_ORIGIN) ?? DEFAULT_SITE_URL),
    rateLimit: {
      enabled: !OFF.has((env.RATE_LIMIT ?? 'on').toLowerCase()),
      test: rateLimitPolicy('TEST', env.RATE_LIMIT_TEST_RPS, env.RATE_LIMIT_TEST_BURST),
      live: rateLimitPolicy('LIVE', env.RATE_LIMIT_LIVE_RPS, env.RATE_LIMIT_LIVE_BURST),
    },
  };
}

/**
 * The largest `rate * (burst + 1)` this limiter will start with.
 *
 * Not a product anybody wants, a product the **arithmetic** stops being exact above. The admission
 * test allows a slack for the rounding of a timestamp, and that slack grows with the burst while
 * the emission interval shrinks with the rate; past a certain product the slack is wider than half
 * an interval and the limiter would admit `burst + 1` requests where `RateLimit-Limit` promises
 * `burst`. `gcra` caps the slack at half an interval so that this can never happen, which is the
 * belt; this is the braces, and it is here because a deployment should be told at boot that the
 * numbers it asked for are outside the regime the promise was made in, rather than find out from a
 * counter that is off by one.
 *
 * A million is forty times the busiest default (`100 * 501 = 50 100`) and a factor of two and a
 * half below the point where the slack reaches an interval with today's clock. The threshold moves
 * down as the epoch grows, which is another reason to keep the margin wide.
 */
export const MAX_RATE_LIMIT_PRODUCT = 1_000_000;

/**
 * One environment's policy: two positive integers, and a product small enough to be exact.
 */
function rateLimitPolicy(
  environment: 'TEST' | 'LIVE',
  rawRate: string | undefined,
  rawBurst: string | undefined,
): { rate: number; burst: number } {
  const defaults = environment === 'TEST' ? DEFAULT_RATE_LIMITS.test : DEFAULT_RATE_LIMITS.live;
  const rateName = `RATE_LIMIT_${environment}_RPS`;
  const burstName = `RATE_LIMIT_${environment}_BURST`;
  const rate = requiredPositiveInt(rateName, rawRate, defaults.rate);
  const burst = requiredPositiveInt(burstName, rawBurst, defaults.burst);
  const product = rate * (burst + 1);
  if (product > MAX_RATE_LIMIT_PRODUCT) {
    throw new Error(
      `${rateName} times (${burstName} + 1) must be at most ${String(MAX_RATE_LIMIT_PRODUCT)}, ` +
        `and ${String(rate)} times (${String(burst)} + 1) is ${String(product)}. ` +
        'Above that the limiter can no longer promise exactly the burst it advertises. ' +
        'Lower the rate, lower the burst, or run more processes behind the same Redis.',
    );
  }
  return { rate, burst };
}

/**
 * Which mailer, and the one configuration this refuses to start with.
 *
 * `log` writes the confirmation link to the log and reports success. In production that is a
 * sign up that looks like it works and sends nothing, which nobody notices until somebody
 * checks a mailbox, so the process refuses to start rather than serve it. It is the same
 * shape of guard the rest of this file uses for the dangerous defaults: loud at boot, never
 * silent at run time.
 */
function resolveMailerKind(env: NodeJS.ProcessEnv): MailerKind | undefined {
  const raw = trimmed(env.BOOKRAIL_MAILER)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (!isMailerKind(raw)) {
    throw new Error(
      `BOOKRAIL_MAILER must be one of ${MAILER_KINDS.join(', ')}, or unset to switch sign up off. Got "${raw}".`,
    );
  }
  if (raw === 'log' && env.NODE_ENV === 'production') {
    throw new Error(
      'BOOKRAIL_MAILER=log writes the confirmation link to the log and sends nothing, so it ' +
        'must never run with NODE_ENV=production. Set BOOKRAIL_MAILER=smtp with SMTP_URL and ' +
        'MAIL_FROM, or unset BOOKRAIL_MAILER to switch self service sign up off.',
    );
  }
  if (
    raw === 'smtp' &&
    (trimmed(env.SMTP_URL) === undefined || trimmed(env.MAIL_FROM) === undefined)
  ) {
    throw new Error('BOOKRAIL_MAILER=smtp needs both SMTP_URL and MAIL_FROM to be set.');
  }
  return raw;
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out === undefined || out === '' ? undefined : out;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const OFF = new Set(['off', 'false', '0', 'no']);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A positive integer, or a refusal to start.
 *
 * Unlike {@link positiveInt} above, a value that is set and wrong is an error and not a silent
 * fallback. The difference is what the number controls: a sweep interval that quietly reverts to
 * ten seconds is slower than intended and nothing else, while a rate limit that quietly reverts
 * to its default is a deployment that believes it raised a ceiling and did not. The house rule for
 * those is to be loud at boot, never silent at run time, which is what the mailer check does too.
 *
 * `burst >= 1` falls out of this: a burst of zero would refuse every request, including the first
 * one, and a deployment asking for that is a deployment asking for a mistake.
 */
function requiredPositiveInt(name: string, value: string | undefined, fallback: number): number {
  const raw = trimmed(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Got "${raw}".`);
  }
  return parsed;
}
