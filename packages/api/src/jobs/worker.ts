/**
 * The background worker: pg-boss, eight queues, and the reasons for all of them.
 *
 * The cadences are a hold expiry every ten seconds, the automatic booking transitions every
 * thirty, the webhook outbox every five, the webhook delivery sweep every second, an hourly
 * cleanup of `Idempotency-Key` rows, the two nightly reconciliations (the integrity check and
 * the orphan sweep), and the usage digest at seven in the morning, which is the only job here
 * that sends a message to a person and the only one whose cron is in a local time zone.
 *
 * pg-boss keeps the queue in Postgres, which is the point: there is no second datastore to
 * lose, and a job and the rows it will touch live in the same database and the same backup.
 *
 * **Ten seconds is not a cron.** Cron's finest grain is one minute, so the expiry loop is a
 * job that re-arms itself: each run queues the next one with `startAfter`. The queue's policy
 * is `short` (at most one job per name in the `created` state), so several API instances
 * re-arming the same loop produce one job, not one per instance, and a cron watchdog can
 * safely re-arm it every minute without ever queueing a second copy. That watchdog is what
 * makes the loop self-healing: if a tick is ever lost (a process killed between the run and
 * the re-arm), the next minute puts it back.
 *
 * **The connection.** pg-boss owns the schema `pgboss`, created by migration 0010, and
 * connects as the **admin** role: it runs its own DDL migrations at start-up and 0007
 * deliberately took `CREATE` away from the application role. The application role is granted
 * nothing on that schema, so the process that serves HTTP cannot read or write the queue,
 * and there is nothing in it to read, because the jobs carry no payload. Everything the jobs
 * then do to project data goes through the application role and Row Level Security
 * (`jobs/tasks.ts`).
 *
 * That connection string is now the **only** privileged thing the worker holds. The tasks
 * themselves used to take an admin pool as well, to ask which projects had work; they ask
 * a `SECURITY DEFINER` function on the application pool instead, so `startWorker` no longer
 * takes an `adminDb` at all: a worker that cannot be handed one cannot accidentally use one.
 *
 * **The worker is optional.** `startWorker` returns null when it is disabled, which is how
 * the API test suite runs: those tests are about HTTP, and a sweeper ticking underneath them
 * would make them non-deterministic. `packages/api/test/jobs.test.ts` starts a real one.
 */
import PgBoss from 'pg-boss';
import type { Logger } from '@bookrail/shared';
import type { AppDeps } from '../context.js';
import {
  purgeIdempotencyKeys,
  purgeSignups,
  runBookingTransitions,
  runHoldExpiry,
} from './tasks.js';
import { runIntegrityCheck, runOrphanReconciliation } from './reconcile.js';
import { DIGEST_TIMEZONE, runUsageDigest, type UsageDigestOptions } from './usage-digest.js';
import { runWebhookDeliveries } from '../webhooks/dispatch.js';
import { runWebhookOutbox } from '../webhooks/outbox.js';
import type { Mailer } from '../mail/index.js';

export const HOLD_EXPIRY_QUEUE = 'hold-expiry';
export const IDEMPOTENCY_PURGE_QUEUE = 'idempotency-purge';
export const BOOKING_TRANSITIONS_QUEUE = 'booking-transitions';
export const WEBHOOK_OUTBOX_QUEUE = 'webhook-outbox';
export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
export const INTEGRITY_CHECK_QUEUE = 'integrity-check';
export const ORPHAN_RECONCILE_QUEUE = 'orphan-reconcile';
export const USAGE_DIGEST_QUEUE = 'usage-digest';

/**
 * When the daily usage digest goes out: 07:00 in the founder's own time zone.
 *
 * The only cron here that is **not** in UTC, and the reason is what it is for: it is a message
 * a person reads over coffee, so the hour has to mean the same thing in March and in November.
 * pg-boss 10 takes a `tz` on a schedule and hands it to `cron-parser`, so the expression is
 * evaluated in Europe/Rome and the job moves with the clock rather than drifting an hour twice
 * a year. The two reconciliations stay in UTC because nobody reads them.
 */
export const DEFAULT_USAGE_DIGEST_CRON = '0 7 * * *';
export const USAGE_DIGEST_TIMEZONE = DIGEST_TIMEZONE;

/**
 * The two reconciliations run nightly, at an hour nobody is booking.
 *
 * These two are the only jobs in the file that are **only** a cron. Every other queue is a loop
 * that re-arms itself because its cadence is finer than cron's minute; once a day is exactly
 * what cron is for, and a reconciliation that is missed costs nothing: the next run asks the
 * same question about the same state.
 */
export const DEFAULT_INTEGRITY_CHECK_CRON = '17 3 * * *';
export const DEFAULT_ORPHAN_RECONCILE_CRON = '42 3 * * *';

/** The hold expiry runs every ten seconds. */
export const DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS = 10;

/**
 * The automatic state transitions run every thirty seconds.
 *
 * Thirty seconds is the resolution of `auto_start`, `auto_complete` and `no_show.auto_mark`,
 * and it is deliberate rather than incidental: none of the three is a deadline anybody is
 * watching to the second, and a tighter loop would buy nothing but a query every few seconds
 * against every project in the estate.
 */
export const DEFAULT_TRANSITIONS_INTERVAL_SECONDS = 30;

/** The outbox turns events into deliveries every five seconds. */
export const DEFAULT_WEBHOOK_OUTBOX_INTERVAL_SECONDS = 5;

/**
 * How often the delivery worker looks for something due.
 *
 * One second, because the first rung of the retry ladder is at three seconds and a
 * poll that was slower than the schedule it serves would silently stretch it. The query is an
 * index-only lookup on `webhook_deliveries_pending_idx`, and it finds nothing on a quiet
 * system.
 */
export const DEFAULT_WEBHOOK_DELIVERY_INTERVAL_SECONDS = 1;

/** The schema migration 0010 creates for the queue. */
export const PGBOSS_SCHEMA = 'pgboss';

export interface WorkerOptions {
  /** Admin connection string. pg-boss owns its schema and runs its own migrations. */
  connectionString: string;
  intervalSeconds?: number;
  /** How often the automatic booking transitions are applied. */
  transitionsIntervalSeconds?: number;
  /** How often the webhook outbox converts events into deliveries. */
  webhookOutboxIntervalSeconds?: number;
  /** How often due webhook deliveries are sent. */
  webhookDeliveryIntervalSeconds?: number;
  /** Cap on the pool pg-boss opens. Small: this process is not serving requests. */
  maxConnections?: number;
  /** Off in tests that only need the two queues to exist. */
  schedule?: boolean;
  /** When the nightly capacity integrity check runs. */
  integrityCheckCron?: string;
  /** Live occupancies one integrity run measures. */
  integrityCheckMaxWindows?: number;
  /** When the nightly `booking.orphaned` reconciliation runs. */
  orphanReconcileCron?: string;
  /** How far ahead the reconciliation looks, in days. */
  orphanReconcileHorizonDays?: number;
  /** Bookings one scope's reconciliation examines per run. */
  orphanReconcileLimit?: number;
  /** (project, environment) pairs one reconciliation run visits. */
  orphanReconcileScopes?: number;
  /**
   * Let deliveries reach loopback and private addresses. Test only, and not reachable from
   * the environment on purpose (`AppDeps.allowPrivateWebhookTargets`).
   */
  allowPrivateWebhookTargets?: boolean;
  /**
   * The daily usage digest, or nothing at all.
   *
   * Absent means the queue is not created and nothing is scheduled: a deployment without
   * `USAGE_DIGEST_TO` has nowhere to send a digest, and a queue that exists with no handler
   * would be a job piling up against a schedule nobody reads.
   *
   * It rides on the options rather than on `deps` so that the worker's dependency set stays
   * the four things every sweep needs. The mailer belongs to this job and to no other: it is
   * the second message this product sends, after the sign up confirmation, and the first one
   * the worker sends at all.
   */
  usageDigest?: WorkerUsageDigest;
  /**
   * What to say at start-up when {@link usageDigest} is absent.
   *
   * The caller knows **which** of the two variables is missing; this object only knows that it
   * did not get a digest to run. Passing the sentence in is what keeps the log line true
   * (`usageDigestOffReason`).
   */
  usageDigestOffReason?: string;
}

export interface WorkerUsageDigest extends Omit<UsageDigestOptions, 'now'> {
  /** How the message leaves the process. The worker holds no mailer without this. */
  mailer: Mailer;
  /** `0 7 * * *` unless a deployment says otherwise. */
  cron?: string;
}

/**
 * Why there is no digest, in the words of the variable that is missing.
 *
 * Two different omissions switch the job off and they are fixed in two different files, so one
 * message for both is a message that sends the reader to the wrong place. `install-remote.sh`
 * produces the second one by itself on a first run: it always writes `USAGE_DIGEST_TO` and
 * leaves `BOOKRAIL_MAILER` empty until root has put the mailbox password in.
 */
export function usageDigestOffReason(options: {
  to: string | undefined;
  mailer: Mailer | undefined;
}): string | null {
  const missing: string[] = [];
  if (options.to === undefined || options.to === '') missing.push('USAGE_DIGEST_TO is not set');
  if (options.mailer === undefined) missing.push('BOOKRAIL_MAILER is not set');
  return missing.length === 0 ? null : missing.join(' and ');
}

export interface Worker {
  boss: PgBoss;
  stop(): Promise<void>;
}

function isStopped(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stopp?(ed|ing)|not started/i.test(message);
}

/**
 * Starts the queue and every worker. The caller keeps the handle and stops it on shutdown.
 *
 * The handlers never throw: pg-boss would retry them, and both jobs are sweepers whose
 * next tick will find the same work anyway. A failure is a log line and a tick that did
 * nothing, never a job that piles up in a dead letter queue.
 */
export async function startWorker(
  deps: Pick<AppDeps, 'db' | 'cache' | 'logger' | 'webhookSecretKey'>,
  options: WorkerOptions,
): Promise<Worker> {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS;
  const transitionsInterval =
    options.transitionsIntervalSeconds ?? DEFAULT_TRANSITIONS_INTERVAL_SECONDS;
  const outboxInterval =
    options.webhookOutboxIntervalSeconds ?? DEFAULT_WEBHOOK_OUTBOX_INTERVAL_SECONDS;
  const deliveryInterval =
    options.webhookDeliveryIntervalSeconds ?? DEFAULT_WEBHOOK_DELIVERY_INTERVAL_SECONDS;
  const logger: Logger = deps.logger;

  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: PGBOSS_SCHEMA,
    max: options.maxConnections ?? 2,
    schedule: options.schedule ?? true,
    // The queue is a heartbeat, not a ledger: a job that failed is not worth keeping.
    retentionHours: 1,
  });
  boss.on('error', (error: Error) => {
    logger.warn('pgboss_error', { error: error.message });
  });
  await boss.start();

  // `short`: at most one job of this name may sit in the `created` state. Re-arming from
  // several instances, or from the cron watchdog, therefore cannot queue a second copy.
  await boss.createQueue(HOLD_EXPIRY_QUEUE, {
    name: HOLD_EXPIRY_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(IDEMPOTENCY_PURGE_QUEUE, {
    name: IDEMPOTENCY_PURGE_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(BOOKING_TRANSITIONS_QUEUE, {
    name: BOOKING_TRANSITIONS_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(WEBHOOK_OUTBOX_QUEUE, {
    name: WEBHOOK_OUTBOX_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(WEBHOOK_DELIVERY_QUEUE, {
    name: WEBHOOK_DELIVERY_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(INTEGRITY_CHECK_QUEUE, {
    name: INTEGRITY_CHECK_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  await boss.createQueue(ORPHAN_RECONCILE_QUEUE, {
    name: ORPHAN_RECONCILE_QUEUE,
    policy: 'short',
    retryLimit: 0,
  });
  const digest = options.usageDigest;
  if (digest !== undefined) {
    await boss.createQueue(USAGE_DIGEST_QUEUE, {
      name: USAGE_DIGEST_QUEUE,
      policy: 'short',
      retryLimit: 0,
    });
  }

  const rearm = async (queue: string, seconds: number, name: string): Promise<void> => {
    try {
      await boss.send(queue, {}, { startAfter: seconds });
    } catch (error) {
      if (!isStopped(error)) {
        logger.warn(`${name}_rearm_failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await boss.work(
    HOLD_EXPIRY_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: Math.max(0.5, Math.min(intervalSeconds, 2)) },
    async () => {
      try {
        const report = await runHoldExpiry(deps);
        if (report.expired > 0) logger.info('holds_expired', { ...report });
      } catch (error) {
        logger.warn('hold_expiry_tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await rearm(HOLD_EXPIRY_QUEUE, intervalSeconds, 'hold_expiry');
      }
    },
  );

  // Thirty seconds, like the ten of the hold sweep, is finer than cron's minute, so the same
  // shape applies: a job that re-arms itself, with a one minute cron as the watchdog that
  // restarts a loop which was somehow lost. `short` makes the watchdog a no-op while the loop
  // is armed, and makes several API instances arm one loop rather than one each.
  await boss.work(
    BOOKING_TRANSITIONS_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: Math.max(0.5, Math.min(transitionsInterval, 5)) },
    async () => {
      try {
        const report = await runBookingTransitions(deps);
        if (report.applied > 0 || report.failed > 0) {
          logger.info('booking_transitions_applied', { ...report });
        }
      } catch (error) {
        logger.warn('booking_transitions_tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await rearm(BOOKING_TRANSITIONS_QUEUE, transitionsInterval, 'booking_transitions');
      }
    },
  );

  // The outbox and the delivery loop are two jobs and not one on purpose: converting events
  // into deliveries is a database transaction measured in milliseconds, and sending them is a
  // network call measured in seconds against somebody else's server. Sharing a tick would let
  // one slow receiver hold the conversion of every project's events.
  await boss.work(
    WEBHOOK_OUTBOX_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: Math.max(0.5, Math.min(outboxInterval, 2)) },
    async () => {
      // A tick that filled its batch re-arms **immediately**, so a backlog really does drain at
      // the speed of the database rather than at one batch every five seconds. `report.more`
      // is what says the batch was full, and it is read here, which is why it is declared
      // outside the `try`.
      let more = false;
      try {
        const report = await runWebhookOutbox(deps);
        more = report.more;
        if (report.deliveries > 0 || report.failed > 0) {
          logger.info('webhook_outbox_tick', { ...report });
        }
      } catch (error) {
        logger.warn('webhook_outbox_tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await rearm(WEBHOOK_OUTBOX_QUEUE, more ? 0 : outboxInterval, 'webhook_outbox');
      }
    },
  );

  await boss.work(
    WEBHOOK_DELIVERY_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: Math.max(0.5, Math.min(deliveryInterval, 2)) },
    async () => {
      try {
        const report = await runWebhookDeliveries(deps, {
          allowPrivateTargets: options.allowPrivateWebhookTargets === true,
          allowAnyPort: options.allowPrivateWebhookTargets === true,
        });
        if (report.attempted > 0 || report.failed > 0) {
          logger.info('webhook_delivery_tick', { ...report });
        }
      } catch (error) {
        logger.warn('webhook_delivery_tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await rearm(WEBHOOK_DELIVERY_QUEUE, deliveryInterval, 'webhook_delivery');
      }
    },
  );

  // The two reconciliations. No re-arm: they are cron jobs, and a run that fails is a run that
  // did not happen, which the next night makes up for. Each is one query plus, for the orphan
  // scan, one short transaction per project.
  await boss.work(INTEGRITY_CHECK_QUEUE, { batchSize: 1 }, async () => {
    try {
      await runIntegrityCheck(deps, { maxWindows: options.integrityCheckMaxWindows });
    } catch (error) {
      logger.warn('integrity_check_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await boss.work(ORPHAN_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    try {
      await runOrphanReconciliation(deps, {
        horizonDays: options.orphanReconcileHorizonDays,
        limit: options.orphanReconcileLimit,
        scopes: options.orphanReconcileScopes,
      });
    } catch (error) {
      logger.warn('orphan_reconciliation_tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await boss.work(IDEMPOTENCY_PURGE_QUEUE, { batchSize: 1 }, async () => {
    try {
      const deleted = await purgeIdempotencyKeys(deps);
      if (deleted > 0) logger.info('idempotency_keys_purged', { deleted });
      // The same hour, the same queue: a second housekeeping sweep of rows that belong to no
      // project. Sign up rows carry an address, so they have a retention and this is it.
      const signups = await purgeSignups(deps);
      if (signups > 0) logger.info('signups_purged', { touched: signups });
    } catch (error) {
      logger.warn('idempotency_purge_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // The only job here that sends a message to a person, and the only one whose failure is
  // invisible from the outside: nobody is waiting on an HTTP response for it. So everything it
  // can do wrong is a log line, and the line that says it did go out is an `info` of its own
  // (`runUsageDigest`), which is what makes "no digest this morning" a question with an answer.
  if (digest !== undefined) {
    await boss.work(USAGE_DIGEST_QUEUE, { batchSize: 1 }, async () => {
      try {
        await runUsageDigest({ db: deps.db, logger, mailer: digest.mailer }, digest);
      } catch (error) {
        logger.warn('usage_digest_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  if (options.schedule !== false) {
    // The watchdog. `short` makes it a no-op whenever the loop is already armed, so its only
    // effect is to restart a loop that was somehow lost.
    await boss.schedule(HOLD_EXPIRY_QUEUE, '* * * * *');
    await boss.schedule(BOOKING_TRANSITIONS_QUEUE, '* * * * *');
    await boss.schedule(WEBHOOK_OUTBOX_QUEUE, '* * * * *');
    await boss.schedule(WEBHOOK_DELIVERY_QUEUE, '* * * * *');
    await boss.schedule(IDEMPOTENCY_PURGE_QUEUE, '0 * * * *');
    await boss.schedule(
      INTEGRITY_CHECK_QUEUE,
      options.integrityCheckCron ?? DEFAULT_INTEGRITY_CHECK_CRON,
    );
    await boss.schedule(
      ORPHAN_RECONCILE_QUEUE,
      options.orphanReconcileCron ?? DEFAULT_ORPHAN_RECONCILE_CRON,
    );
    if (digest !== undefined) {
      const cron = digest.cron ?? DEFAULT_USAGE_DIGEST_CRON;
      const tz = digest.timezone ?? USAGE_DIGEST_TIMEZONE;
      await boss.schedule(USAGE_DIGEST_QUEUE, cron, {}, { tz });
      logger.info('usage_digest_scheduled', { cron, tz, to: digest.to });
    }
  } else if (digest !== undefined) {
    // Scheduling is off for this process (a test, or a second worker), so the queue exists and
    // nothing arms it. Said out loud, because the alternative is a worker that looks configured
    // and never sends: the two `usage_digest_*` lines have to cover every case between them.
    logger.info('usage_digest_unscheduled', { to: digest.to, reason: 'scheduling is off' });
  }
  if (digest === undefined) {
    // One line at start-up, so that a worker which sends no digest says so where a worker that
    // stopped sending one would say nothing. The reason comes from the caller, which is the only
    // place that can tell `USAGE_DIGEST_TO` from `BOOKRAIL_MAILER`.
    logger.info('usage_digest_off', {
      reason: options.usageDigestOffReason ?? 'USAGE_DIGEST_TO is not set',
    });
  }

  // The first ticks: immediate, so a process that has just started does not wait for the
  // watchdog before sweeping.
  await boss.send(HOLD_EXPIRY_QUEUE, {});
  await boss.send(BOOKING_TRANSITIONS_QUEUE, {});
  await boss.send(WEBHOOK_OUTBOX_QUEUE, {});
  await boss.send(WEBHOOK_DELIVERY_QUEUE, {});

  return {
    boss,
    async stop(): Promise<void> {
      await boss.stop({ graceful: true, wait: true });
    },
  };
}
