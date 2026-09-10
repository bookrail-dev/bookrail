/**
 * The delivery worker: claiming a due delivery, sending it, and deciding when to try again.
 *
 * ## Where the retry schedule lives
 *
 * In `webhook_deliveries.next_attempt_at`, and not in the job queue. The obvious alternative
 * is pg-boss's `startAfter`, and for the first two steps of the ladder that would work, but the
 * ladder ends at **24 hours**, and a delay that exists only as a queue row is a schedule that a
 * queue purge, a retention window (`retentionHours: 1` on our own queues), or a `pnpm db:reset`
 * silently loses. Three further reasons decided it:
 *
 *  1. our queues use pg-boss's `short` policy (at most one job per name in the `created`
 *     state), so a `startAfter: 3` sent while a `startAfter: 86400` is already queued would be
 *     **dropped**, and the fast retry would wait a day;
 *  2. `next_attempt_at` is what `GET /v1/webhooks/{id}/deliveries` has to show a customer
 *     anyway, and a schedule that is displayed from one place and enforced from another drifts;
 *  3. the timers have to be something a test can accelerate. A column and an injected `now` do
 *     that exactly; a queue delay can only be waited for.
 *
 * So the queue keeps the job it is good at (waking this function up), and the database keeps
 * the schedule. `runWebhookDeliveries` is a sweep, like the hold expiry and the transition
 * scheduler, and takes `now` as a parameter for the same reason they do.
 *
 * ## The claim
 *
 * `FOR UPDATE SKIP LOCKED` over the due rows, and the same statement writes `leased_until` and
 * increments `attempt`. Three things follow. A second worker skips what the first is holding, so
 * one endpoint never receives the same event twice from two processes. `attempt` becomes the
 * **identity of the claim**, and every statement that records an outcome is conditional on it,
 * so a worker whose lease expired under a very slow attempt cannot overwrite what a later one
 * already wrote. And a worker that dies **mid-flight** (after the HTTP request left but before
 * the outcome was recorded) leaves a row that becomes due again when the lease expires, having
 * consumed one attempt: at-most-eight attempts with a possible duplicate at the network level
 * (which the receiver deduplicates on `Bookrail-Event-Id`, the header that exists for it)
 * rather than a row that loops for ever.
 *
 * The lease has its own column. It used to be written into `next_attempt_at`, which meant the
 * value a customer reads in the delivery log during an attempt was a lease deadline belonging to
 * no rung of the documented ladder.
 *
 * The claim also refuses a **disabled** endpoint. `disabled` stops all the traffic towards an
 * endpoint and not only the queueing, and before this it only stopped the outbox: everything
 * already queued kept going out for the 39 hours of the ladder.
 *
 * The HTTP call happens **outside** any transaction. Ten seconds of a receiver's silence must
 * not be ten seconds of an open Postgres transaction: that is what holds `pg_snapshot_xmin`
 * back, and the horizon of the outbox and of `GET /v1/events` is measured against it.
 *
 * ## The clock, and why there are two
 *
 * `options.now` says what is **due**; the instant that **signs** a delivery and schedules its
 * next attempt is read when the POST leaves ({@link DispatchOptions.signingNow}, `Date.now` in
 * production). A tick is not an instant, and stamping every POST of a tick with the instant the
 * tick began made the last ones carry a `t` outside our own ±300 s tolerance.
 */
import { inArray } from 'drizzle-orm';
import {
  events as eventsTable,
  sql,
  webhooks as webhooksTable,
  withProjectContext,
  type Database,
} from '@bookrail/db';
import { insertEvent } from '@bookrail/engine';
import { encodeId, WEBHOOK_FAILING_EVENT, type Environment, type Logger } from '@bookrail/shared';
import type { AppDeps } from '../context.js';
import { serializeEvent } from '../serialize.js';
import { deliver, truncate, type DeliveryAttempt } from './deliver.js';
import { decryptWebhookSecret } from './secrets.js';
import type { SsrfOptions } from './ssrf.js';

/**
 * The published retry ladder, verbatim: 3s, 30s, 5m, 30m, 2h, 12h, 24h.
 *
 * Seven retries after the first attempt, so eight attempts in all, spread over a little more
 * than 39 hours. An endpoint that is down for a working day is still reached.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [3, 30, 300, 1800, 7200, 43_200, 86_400] as const;

/** First attempt plus one per delay. */
export const MAX_DELIVERY_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

/**
 * How long a claimed delivery is invisible to other workers.
 *
 * Comfortably above the ten second delivery timeout plus the round trips around it, and far
 * below the shortest retry that matters, so a lease that expires really does mean the worker
 * died rather than that it was slow.
 */
export const DELIVERY_LEASE_SECONDS = 120;

/** How many deliveries one scope sends per tick. */
export const MAX_DELIVERIES_PER_SCOPE = 50;

/** Same cap as every other sweep. */
export const MAX_DISPATCH_SCOPES_PER_TICK = 200;

/**
 * How many deliveries are in flight at once, per scope and across scopes.
 *
 * Before this the whole estate was one `await` chain: 200 scopes × 50 deliveries × a 10 second
 * timeout is a tick of **27 hours**, and the queue's `short` policy means no other delivery in
 * the system starts while it runs. One customer with a dead endpoint held everybody else's
 * webhooks.
 *
 * Eight, not more: the point is to stop head-of-line blocking, not to become a load generator
 * aimed at somebody's server. It is also the natural mitigation of I1, because a shorter tick
 * is a smaller spread between the instants of the first and the last signature.
 */
export const DELIVERY_CONCURRENCY = 8;

/** Ceiling on sockets open at once across every scope of one tick. */
export const MAX_DELIVERIES_IN_FLIGHT = 32;

export interface DispatchReport {
  scopes: number;
  attempted: number;
  succeeded: number;
  /** Failed and scheduled for another attempt. */
  retried: number;
  /** Failed for the last time: the delivery is `failed` and the endpoint is `failing`. */
  exhausted: number;
  failed: number;
}

export interface DispatchOptions extends SsrfOptions {
  /**
   * The instant of the tick: what counts as **due**. A parameter so a test can walk the retry
   * ladder without waiting for it.
   *
   * It is deliberately *not* the instant that signs a delivery or that schedules the next
   * attempt: see {@link signingNow}.
   */
  now?: number;
  /**
   * The clock read at the moment each POST leaves, defaulting to `Date.now`.
   *
   * A tick is not an instant. The POSTs of one tick are spread over as long as the slowest
   * receivers take, and stamping them all with the instant the tick *began* meant the last ones
   * carried a `t` older than the ±300 s tolerance of our own `verifySignature`: the receiver saw
   * an invalid signature, which is the worst possible diagnosis for "we were slow". The same
   * stale instant was the base of `next_attempt_at`, so after a long tick the first rung of the
   * ladder was already in the past and the ladder collapsed.
   *
   * A function rather than a number because it is read once per delivery, not once per tick.
   * The ladder test fixes it to the injected `now` so the rungs stay exactly measurable.
   */
  signingNow?: () => number;
  batchSize?: number;
  timeoutMs?: number;
  concurrency?: number;
}

interface Scope {
  projectId: string;
  environment: Environment;
}

interface ClaimedRow {
  [column: string]: unknown;
  id: string;
  webhook_id: string;
  event_id: string;
  attempt: number;
}

/**
 * Cross-project, through `due_webhook_delivery_scopes`, a `SECURITY DEFINER` function whose
 * result is a list of (project, environment) pairs and nothing else (migration 0013).
 * It used to be a query on the worker's superuser connection; the question is
 * the same one Row Level Security cannot answer to the application role, the answer is now the
 * smallest thing that answers it.
 *
 * Unlike the outbox's discovery this set **drains** (a delivery that succeeds or fails leaves
 * it), so a fixed `LIMIT` cannot starve anybody: the next tick finds different rows.
 */
async function dueScopes(db: Database, now: number): Promise<Scope[]> {
  const { rows } = await db.execute<{ project_id: string; environment: Environment }>(sql`
    SELECT project_id, environment
      FROM due_webhook_delivery_scopes(${new Date(now).toISOString()}::timestamptz,
                                       ${MAX_DISPATCH_SCOPES_PER_TICK})
  `);
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/** The webhook payload: exactly the object `GET /v1/events` returns, so one parser serves both. */
export function webhookPayload(row: typeof eventsTable.$inferSelect): string {
  return JSON.stringify(serializeEvent(row));
}

/**
 * Takes up to `batchSize` due deliveries and marks them in flight.
 *
 * Returns everything the send needs, read in the same short transaction as the claim: the
 * endpoint may be deleted a millisecond later, and a delivery whose endpoint is gone has
 * nowhere to go anyway (the `ON DELETE CASCADE` of migration 0005 takes the row with it).
 */
async function claim(
  db: Database,
  scope: Scope,
  now: number,
  batchSize: number,
): Promise<{
  claimed: ClaimedRow[];
  endpoints: Map<string, typeof webhooksTable.$inferSelect>;
  events: Map<string, typeof eventsTable.$inferSelect>;
}> {
  return withProjectContext(db, scope, async (tx) => {
    const nowIso = new Date(now).toISOString();
    const leaseIso = new Date(now + DELIVERY_LEASE_SECONDS * 1000).toISOString();
    // `w.status <> 'disabled'`: disabling an endpoint stops the traffic, which is the whole
    // reason `disabled` exists, queued deliveries included. Before this it only stopped the
    // outbox, so a customer who disabled an endpoint because its URL had leaked kept sending
    // signed payloads to it for the 39 hours of the ladder.
    // The rows stay `pending` and resume if the endpoint comes back.
    //
    // The lease lives in its own column: pushing it into `next_attempt_at` made the value a
    // customer reads during an attempt a lease deadline belonging to no rung of the ladder.
    const { rows } = await tx.execute<ClaimedRow>(sql`
      WITH due AS (
        SELECT d.id
          FROM webhook_deliveries d
          JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.status = 'pending'
           AND w.status <> 'disabled'
           AND d.next_attempt_at IS NOT NULL
           AND d.next_attempt_at <= ${nowIso}::timestamptz
           AND (d.leased_until IS NULL OR d.leased_until <= ${nowIso}::timestamptz)
         ORDER BY d.next_attempt_at
         LIMIT ${batchSize}
         FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE webhook_deliveries d
         SET attempt = d.attempt + 1,
             last_attempt_at = ${nowIso}::timestamptz,
             leased_until = ${leaseIso}::timestamptz
        FROM due
       WHERE d.id = due.id
      RETURNING d.id, d.webhook_id, d.event_id, d.attempt
    `);
    if (rows.length === 0) {
      return { claimed: [], endpoints: new Map(), events: new Map() };
    }

    const endpoints = new Map<string, typeof webhooksTable.$inferSelect>();
    for (const row of await tx
      .select()
      .from(webhooksTable)
      .where(inArray(webhooksTable.id, [...new Set(rows.map((r) => r.webhook_id))]))) {
      endpoints.set(row.id, row);
    }
    const eventRows = new Map<string, typeof eventsTable.$inferSelect>();
    for (const row of await tx
      .select()
      .from(eventsTable)
      .where(inArray(eventsTable.id, [...new Set(rows.map((r) => r.event_id))]))) {
      eventRows.set(row.id, row);
    }
    return { claimed: rows, endpoints, events: eventRows };
  });
}

interface RecordOutcome {
  status: 'succeeded' | 'retried' | 'exhausted';
}

/**
 * Writes what happened, and everything that follows from it.
 *
 * One transaction per delivery, and every statement is conditional on **`attempt` still being
 * the value this worker was handed by its own claim**. `attempt` is incremented only inside the
 * claim, so it is the claim's identity: a worker whose lease expired under a very slow attempt
 * finds a different value and writes nothing, instead of overwriting the outcome (or the next
 * rung) that a later worker has already recorded. `status = 'pending'` alone did not do that,
 * because a recorded *retry* leaves the status pending.
 */
async function record(
  db: Database,
  scope: Scope,
  delivery: ClaimedRow,
  attempt: DeliveryAttempt,
  now: number,
): Promise<RecordOutcome> {
  const nowIso = new Date(now).toISOString();
  const bodyText = attempt.responseBody;
  const errorText = attempt.error === null ? null : truncate(attempt.error, 500);

  if (attempt.ok) {
    return withProjectContext(db, scope, async (tx) => {
      await tx.execute(sql`
        UPDATE webhook_deliveries
           SET status = 'succeeded', delivered_at = ${nowIso}::timestamptz,
               response_status = ${attempt.status}, response_body = ${bodyText},
               duration_ms = ${attempt.durationMs}, error = NULL,
               next_attempt_at = NULL, leased_until = NULL
         WHERE id = ${delivery.id} AND status = 'pending' AND attempt = ${delivery.attempt}
      `);
      // An endpoint that answers again is not failing any more. Leaving the flag on would
      // make `status` a record of the worst thing that ever happened rather than of what is
      // true now, and the customer would have no way to clear it but to guess.
      await tx.execute(sql`
        UPDATE webhooks SET status = 'active'
         WHERE id = ${delivery.webhook_id} AND status = 'failing'
      `);
      return { status: 'succeeded' };
    });
  }

  const exhausted = delivery.attempt >= MAX_DELIVERY_ATTEMPTS;
  if (!exhausted) {
    const delay = WEBHOOK_RETRY_DELAYS_SECONDS[delivery.attempt - 1] ?? 0;
    const nextIso = new Date(now + delay * 1000).toISOString();
    await withProjectContext(db, scope, (tx) =>
      tx.execute(sql`
        UPDATE webhook_deliveries
           SET status = 'pending', next_attempt_at = ${nextIso}::timestamptz,
               leased_until = NULL,
               response_status = ${attempt.status}, response_body = ${bodyText},
               duration_ms = ${attempt.durationMs}, error = ${errorText}
         WHERE id = ${delivery.id} AND status = 'pending' AND attempt = ${delivery.attempt}
      `),
    );
    return { status: 'retried' };
  }

  await withProjectContext(db, scope, async (tx) => {
    const closed = await tx.execute<{ id: string }>(sql`
      UPDATE webhook_deliveries
         SET status = 'failed', next_attempt_at = NULL, leased_until = NULL,
             response_status = ${attempt.status}, response_body = ${bodyText},
             duration_ms = ${attempt.durationMs}, error = ${errorText}
       WHERE id = ${delivery.id} AND status = 'pending' AND attempt = ${delivery.attempt}
      RETURNING id
    `);
    // Somebody else closed this delivery while the attempt was in flight: theirs is the outcome
    // of record, and the endpoint must not be marked failing twice for one delivery.
    if (closed.rows.length === 0) return;
    // `active` only: an endpoint already `failing` does not need a second announcement, and a
    // `disabled` one is not failing, it is off.
    const marked = await tx.execute<{ id: string; url: string }>(sql`
      UPDATE webhooks SET status = 'failing'
       WHERE id = ${delivery.webhook_id} AND status = 'active'
      RETURNING id, url
    `);
    const endpoint = marked.rows[0];
    if (endpoint === undefined) return;
    await insertEvent(tx, scope.projectId, scope.environment, WEBHOOK_FAILING_EVENT, {
      id: encodeId('webhook', endpoint.id),
      object: 'webhook',
      url: endpoint.url,
      status: 'failing',
      delivery_id: encodeId('webhook_delivery', delivery.id),
      event_id: encodeId('event', delivery.event_id),
      attempts: delivery.attempt,
      last_error: errorText,
    });
  });
  return { status: 'exhausted' };
}

/**
 * Sends one claimed delivery. Never throws: every failure is an outcome to record.
 */
export async function sendOne(
  deps: Pick<AppDeps, 'db' | 'logger' | 'webhookSecretKey'>,
  scope: Scope,
  delivery: ClaimedRow,
  endpoint: typeof webhooksTable.$inferSelect,
  event: typeof eventsTable.$inferSelect,
  options: DispatchOptions,
): Promise<RecordOutcome> {
  // **The instant this POST actually leaves**, not the instant the tick began. It signs the
  // payload and it is the base of the next rung of the ladder; `options.now` decided only what
  // was due.
  const now = (options.signingNow ?? Date.now)();
  let attempt: DeliveryAttempt;
  if (deps.webhookSecretKey === undefined) {
    attempt = {
      ok: false,
      status: null,
      responseBody: null,
      error: 'WEBHOOK_SECRET_KEY is not configured, so this delivery cannot be signed.',
      durationMs: 0,
    };
  } else {
    let secret: string;
    try {
      secret = decryptWebhookSecret(endpoint.secret, deps.webhookSecretKey, endpoint.id);
    } catch (error) {
      // Never the secret, never the key: only that one could not be read.
      attempt = {
        ok: false,
        status: null,
        responseBody: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      };
      return record(deps.db, scope, delivery, attempt, now);
    }
    attempt = await deliver(
      {
        url: endpoint.url,
        environment: scope.environment,
        secret,
        body: webhookPayload(event),
        eventId: encodeId('event', event.id),
        webhookId: encodeId('webhook', endpoint.id),
        deliveryId: encodeId('webhook_delivery', delivery.id),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        timestampSeconds: Math.floor(now / 1000),
      },
      options,
    );
  }
  return record(deps.db, scope, delivery, attempt, now);
}

/**
 * One tick: claim what is due, send it, record what happened.
 *
 * A failure on one delivery or one project never stops the rest: every outcome is durable in
 * the row itself, so the worst a thrown error costs is one lease.
 */
export async function runWebhookDeliveries(
  deps: Pick<AppDeps, 'db' | 'logger' | 'webhookSecretKey'>,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const now = options.now ?? Date.now();
  const batchSize = options.batchSize ?? MAX_DELIVERIES_PER_SCOPE;
  const logger: Logger = deps.logger;
  const report: DispatchReport = {
    scopes: 0,
    attempted: 0,
    succeeded: 0,
    retried: 0,
    exhausted: 0,
    failed: 0,
  };

  const concurrency = Math.max(1, options.concurrency ?? DELIVERY_CONCURRENCY);
  const inFlight = limiter(Math.max(concurrency, MAX_DELIVERIES_IN_FLIGHT));

  const runScope = async (scope: Scope): Promise<void> => {
    report.scopes += 1;
    let batch;
    try {
      batch = await claim(deps.db, scope, now, batchSize);
    } catch (error) {
      report.failed += 1;
      logger.warn('webhook_claim_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    await inWindows(batch.claimed, concurrency, async (delivery) => {
      const endpoint = batch.endpoints.get(delivery.webhook_id);
      const event = batch.events.get(delivery.event_id);
      if (endpoint === undefined || event === undefined) {
        // The endpoint or the event went away between the claim and here. Nothing to send and
        // nothing to record: the cascade of migration 0005 has already removed the row, or is
        // about to.
        return;
      }
      report.attempted += 1;
      try {
        const outcome = await inFlight(() =>
          sendOne(
            { db: deps.db, logger: deps.logger, webhookSecretKey: deps.webhookSecretKey },
            scope,
            delivery,
            endpoint,
            event,
            options,
          ),
        );
        if (outcome.status === 'succeeded') report.succeeded += 1;
        else if (outcome.status === 'retried') report.retried += 1;
        else report.exhausted += 1;
      } catch (error) {
        report.failed += 1;
        logger.warn('webhook_delivery_failed', {
          project_id: scope.projectId,
          environment: scope.environment,
          delivery_id: delivery.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  await inWindows(await dueScopes(deps.db, now), concurrency, runScope);
  return report;
}

/**
 * Runs `fn` over `items` in windows of `size`, waiting for each window before the next.
 *
 * A window rather than a rolling pool because the shape of the work is a batch and the code
 * that reads it should be obvious: the slowest item of a window holds only that window, never
 * the tick. The global ceiling is {@link limiter}'s job.
 */
async function inWindows<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(fn));
  }
}

/** A counting semaphore: at most `limit` of the wrapped calls are in flight at once. */
function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
