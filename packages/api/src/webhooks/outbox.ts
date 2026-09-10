/**
 * The outbox: turning the event log into deliveries, exactly once.
 *
 * `events` is already the transactional outbox: the row is written by the transaction that made the
 * change, so it survives if and only if the change did. What this file adds is the consumer, and a
 * consumer of an append-only log lives or dies by one property: **a row it has stepped over must
 * never turn up behind it.**
 *
 * ## Why the cursor is a pair, and why it has a horizon
 *
 * `seq` is a `bigserial`, handed out at the `INSERT` and not at the `COMMIT`. Two transactions
 * that write an event each and commit in the opposite order leave a hole below a cursor that
 * has already passed it. A worker advancing `last_seq`
 * blindly loses that event **for ever**: not late, gone.
 *
 * So the cursor is `(last_txid, last_seq)`, and the scan only ever reads rows below
 * `pg_snapshot_xmin(pg_current_snapshot())`: every transaction under that bound has finished,
 * so its rows are visible now or never, and everything still in flight will commit with a
 * *higher* `txid` and therefore sort after everything already dispatched. It is the same
 * horizon `GET /v1/events` uses, for the same reason, and it costs the same thing: a delivery
 * latency equal to the longest write transaction currently open anywhere in the database.
 *
 * ## Why the horizon is enough here, when the obvious objection says it is not
 *
 * The objection is right about what it says: *the horizon makes a cursor safe for a reader
 * that pages, not for a queue, and a delivery wants to take the row, not read it.* The taking
 * is real and it happens twice, just not on `events`:
 *
 *  - on `outbox_cursor`, with `SELECT … FOR UPDATE`. That row is the lease over one
 *    (project, environment): the second worker to arrive waits, then reads a cursor that has
 *    already moved and finds nothing. This is exactly the lock discipline `next_transition`
 *    uses for the automatic transitions;
 *  - on `webhook_deliveries`, with `FOR UPDATE SKIP LOCKED`, at delivery time (`dispatch.ts`).
 *
 * The conversion and the cursor advance are **one transaction**, so there is no state in which
 * deliveries exist and the cursor does not, or the reverse. And because an argument about code
 * is not a guarantee, `webhook_deliveries_event_uniq` (migration 0012) makes a second delivery
 * of the same event to the same endpoint impossible at the database level: a cursor rewound by
 * a restore, or a job somebody ran twice by hand, produces nothing rather than a duplicate.
 *
 * ## Which events, and for whom
 *
 * The scan reads **every** event in the window and advances the cursor to the last of them,
 * then filters when creating deliveries. Filtering in the `WHERE` instead would leave the
 * cursor stuck behind a tail of events nobody wants, and the window would grow for ever.
 *
 * Two filters:
 *
 *  - `webhook.*` events are never delivered ({@link subscribes} refuses them). They are about
 *    the delivery machinery, and an endpoint that received "your endpoint is failing" would
 *    generate the event that generates the delivery that fails;
 *  - an endpoint only receives events that happened **after it was created**
 *    (`events.occurred_at >= webhooks.created_at`). Without it, a second endpoint registered on
 *    a project whose outbox is momentarily behind would receive the backlog of the first.
 *
 * That the *first* endpoint of a project does not receive its history is a different mechanism,
 * and it is not this one: `POST /v1/webhooks` creates the `outbox_cursor` row **in the same
 * transaction as the endpoint**, positioned at the horizon of that moment. Creating it here
 * instead, on the first tick, would leave a window: every event written between the
 * registration and the tick five seconds later would be below the freshly created cursor and
 * lost. The two mechanisms overlap on purpose: the cursor is the position, `occurred_at` is the
 * per-endpoint guard, and neither on its own is enough.
 *
 * A `failing` endpoint still queues new events; only `disabled` stops the flow. That is
 * deliberate, and it is what makes `failing` recoverable: when the endpoint comes back, everything
 * it missed is still in the queue.
 */
import { sql, withProjectContext, type Database, type Transaction } from '@bookrail/db';
import {
  subscribes,
  uuidv7,
  type Environment,
  type Logger,
  INTERNAL_EVENT_PREFIX,
} from '@bookrail/shared';
import type { AppDeps } from '../context.js';

/**
 * How many (project, environment) pairs one tick takes on.
 *
 * Unlike the hold sweep and the transition scheduler, the set this cap is applied to does **not**
 * drain: a project keeps its endpoints for ever. A fixed `LIMIT` over an `ORDER BY project_id`
 * therefore meant the projects sorting after the 200th never had their outbox run at all, silently,
 * for ever. The discovery is now a rotation over `outbox_cursor.updated_at`, and every visited
 * scope is stamped whether or not it converted anything, so no scope can be starved by the ones in
 * front of it.
 */
export const MAX_OUTBOX_SCOPES_PER_TICK = 200;

/** How many events one scope converts per tick. Keeps the transaction, and the tick, bounded. */
export const MAX_EVENTS_PER_OUTBOX_TICK = 500;

export interface OutboxReport {
  scopes: number;
  /** Events read and stepped over, whether or not anybody was subscribed to them. */
  events: number;
  /** `webhook_deliveries` rows actually inserted. */
  deliveries: number;
  failed: number;
  /** At least one scope filled its batch and has more waiting. */
  more: boolean;
}

interface Scope {
  projectId: string;
  environment: Environment;
}

export interface OutboxOptions {
  batchSize?: number;
  /** How many scopes one tick visits. Lowered by the rotation test; production uses the cap. */
  scopeLimit?: number;
  /**
   * Test seam: called inside the transaction, after the deliveries are inserted and **before**
   * the cursor is advanced. A test throws from here to prove that the two cannot come apart.
   * Nothing in production passes it.
   */
  onBeforeCursorAdvance?: () => void | Promise<void>;
}

/**
 * The scopes an outbox tick visits, least recently visited first.
 *
 * Driven by `webhooks`, not by `events`: a project with no endpoint has nothing to deliver, and
 * asking `events` instead would scan the log of the whole estate every five seconds to discover
 * that. Cross-project, so it runs on the admin connection: Row Level Security makes "which
 * projects have work" unanswerable to the application role by construction, exactly as for the
 * hold sweep and the transition scheduler.
 *
 * Two things it deliberately does **not** do.
 *
 * It does not filter on `webhooks.status`. A scope whose endpoints are all `disabled` still has
 * to have its cursor advanced, or the cursor freezes and re-enabling an endpoint a month later
 * fires a month of deliveries at it, and whether that happened depended on whether the project
 * happened to have another, active endpoint, which is the same gesture with two opposite
 * outcomes. Which endpoints actually *receive* is decided per row,
 * inside {@link convertScope}.
 *
 * And it does not order by `project_id`. That set does not drain, so a stable order plus a fixed
 * `LIMIT` starves everything past the limit for ever. `outbox_cursor.updated_at` is stamped
 * on every visit (by the trigger of migration 0012, on an `UPDATE` that runs even when there
 * was nothing to convert), so ordering by it is a rotation: the scopes this tick visits are the
 * ones that have waited longest. A scope with no cursor row yet sorts first.
 *
 * Both properties now live in `webhook_outbox_scopes`, the `SECURITY DEFINER` function of
 * migration 0013: the rotation is part of the answer rather than of the
 * caller, and the worker no longer needs a superuser connection to ask the question.
 */
async function webhookScopes(db: Database, limit: number): Promise<Scope[]> {
  const { rows } = await db.execute<{ project_id: string; environment: Environment }>(
    sql`SELECT project_id, environment FROM webhook_outbox_scopes(${limit})`,
  );
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/**
 * Creates the cursor of a scope, at the horizon of the calling transaction, if it has none.
 *
 * Called by `POST /v1/webhooks` **inside the transaction that writes the endpoint**, which is
 * the whole point: the position from which the outbox will read is fixed by the same commit
 * that makes the endpoint exist. There is therefore no interval in which an endpoint is
 * registered and nothing is watching the log on its behalf, and no interval in which the first
 * tick invents a position that silently skips what happened in between.
 *
 * `pg_snapshot_xmin(pg_current_snapshot())` is a **lower** bound on what has settled, not an
 * upper one, so a handful of events that committed just before the registration may still sort
 * above it. Those are caught by the second guard, `occurred_at >= webhooks.created_at`.
 */
export async function ensureOutboxCursor(
  tx: Transaction,
  projectId: string,
  environment: Environment,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO outbox_cursor (id, project_id, environment, last_txid, last_seq)
    VALUES (${uuidv7()}, ${projectId}, ${environment},
            pg_snapshot_xmin(pg_current_snapshot()), 0)
    ON CONFLICT (project_id, environment) DO NOTHING
  `);
}

interface ScopeOutcome {
  events: number;
  deliveries: number;
  more: boolean;
}

interface EventRow {
  [column: string]: unknown;
  id: string;
  type: string;
  occurred_at: string;
  txid: string;
  seq: string;
}

interface WebhookRow {
  [column: string]: unknown;
  id: string;
  event_types: string[];
  created_at: string;
}

async function convertScope(
  db: Database,
  scope: Scope,
  options: OutboxOptions,
): Promise<ScopeOutcome> {
  const batchSize = options.batchSize ?? MAX_EVENTS_PER_OUTBOX_TICK;

  return withProjectContext(db, scope, async (tx) => {
    // The cursor is normally created by `POST /v1/webhooks`, in the same transaction as the
    // first endpoint of the scope, so that there is no window between "an endpoint exists" and
    // "somebody is reading the log for it". This is the fallback for a scope whose row is
    // missing anyway (a cursor deleted by hand, a webhook restored without it), and it starts
    // at the current horizon rather than at the beginning of the log: replaying a project's
    // whole history into an endpoint is a worse failure than missing the gap.
    await ensureOutboxCursor(tx, scope.projectId, scope.environment);

    // The lease. A second worker on this scope waits here, then reads the advanced cursor.
    const cursor = await tx.execute<{ last_txid: string; last_seq: string }>(sql`
      SELECT last_txid::text AS last_txid, last_seq::text AS last_seq
        FROM outbox_cursor
       WHERE project_id = ${scope.projectId} AND environment = ${scope.environment}
       FOR UPDATE
    `);
    const position = cursor.rows[0];
    if (position === undefined) return { events: 0, deliveries: 0, more: false };

    const stamp = async (txid: string, seq: string): Promise<void> => {
      // Runs on **every** visit, converted rows or not: the trigger of migration 0012 bumps
      // `updated_at`, and that column is the rotation key of the discovery query. A scope that
      // had nothing to do and was not stamped would be picked first again on the next tick, for
      // ever, and would starve the ones behind it.
      await tx.execute(sql`
        UPDATE outbox_cursor
           SET last_txid = ${txid}::xid8, last_seq = ${seq}::bigint
         WHERE project_id = ${scope.projectId} AND environment = ${scope.environment}
      `);
    };

    const events = await tx.execute<EventRow>(sql`
      SELECT id, type, occurred_at::text AS occurred_at, txid::text AS txid, seq::text AS seq
        FROM events
       WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
         AND (txid, seq) > (${position.last_txid}::xid8, ${position.last_seq}::bigint)
       ORDER BY txid, seq
       LIMIT ${batchSize}
    `);
    const rows = events.rows;
    const last = rows[rows.length - 1];
    if (last === undefined) {
      await stamp(position.last_txid, position.last_seq);
      return { events: 0, deliveries: 0, more: false };
    }

    const endpoints = await tx.execute<WebhookRow>(sql`
      SELECT id, event_types, created_at::text AS created_at
        FROM webhooks
       WHERE status <> 'disabled'
       ORDER BY id
    `);

    const ids: string[] = [];
    const webhookIds: string[] = [];
    const eventIds: string[] = [];
    for (const event of rows) {
      if (event.type.startsWith(INTERNAL_EVENT_PREFIX)) continue;
      const occurredAt = Date.parse(event.occurred_at);
      for (const endpoint of endpoints.rows) {
        if (!subscribes(endpoint.event_types, event.type)) continue;
        // An endpoint never receives what happened before it existed.
        if (occurredAt < Date.parse(endpoint.created_at)) continue;
        ids.push(uuidv7());
        webhookIds.push(endpoint.id);
        eventIds.push(event.id);
      }
    }

    let inserted = 0;
    if (ids.length > 0) {
      const written = await tx.execute<{ id: string }>(sql`
        INSERT INTO webhook_deliveries
               (id, project_id, environment, webhook_id, event_id, status, attempt,
                scheduled_at, next_attempt_at)
        SELECT x.id, ${scope.projectId}::uuid, ${scope.environment}, x.webhook_id, x.event_id,
               'pending', 0, now(), now()
          FROM unnest(${sql.param(ids)}::uuid[],
                      ${sql.param(webhookIds)}::uuid[],
                      ${sql.param(eventIds)}::uuid[]) AS x(id, webhook_id, event_id)
        ON CONFLICT (webhook_id, event_id) DO NOTHING
        RETURNING id
      `);
      inserted = written.rows.length;
    }

    if (options.onBeforeCursorAdvance) await options.onBeforeCursorAdvance();

    await stamp(last.txid, last.seq);

    return { events: rows.length, deliveries: inserted, more: rows.length >= batchSize };
  });
}

/**
 * One tick of the outbox, over every project that has an endpoint.
 *
 * A failure on one project never stops the others: the conversion is idempotent, so the right
 * answer to one scope's error is a log line and the next tick, not a stalled estate.
 */
export async function runWebhookOutbox(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  options: OutboxOptions = {},
): Promise<OutboxReport> {
  const report: OutboxReport = { scopes: 0, events: 0, deliveries: 0, failed: 0, more: false };
  const logger: Logger = deps.logger;

  const scopeLimit = Math.max(1, options.scopeLimit ?? MAX_OUTBOX_SCOPES_PER_TICK);
  for (const scope of await webhookScopes(deps.db, scopeLimit)) {
    report.scopes += 1;
    try {
      const outcome = await convertScope(deps.db, scope, options);
      report.events += outcome.events;
      report.deliveries += outcome.deliveries;
      if (outcome.more) report.more = true;
    } catch (error) {
      report.failed += 1;
      logger.warn('webhook_outbox_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
