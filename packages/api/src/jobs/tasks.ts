/**
 * What the background worker actually does, as plain functions.
 *
 * They are separated from the queue on purpose: pg-boss decides *when* they run and how many
 * processes may run them at once, and none of that is worth reasoning about while reading
 * what a sweep does. A test calls these directly and gets a real answer in milliseconds; the
 * worker test then proves only that the queue reaches them.
 *
 * **There is no admin connection here any more.** Every task still starts
 * with a question no project can answer for itself (*which* projects have expired holds, which
 * have a transition due, which rows are past their retention), and Row Level Security still
 * makes that question unanswerable to the application role by design. What changed is the
 * answer: those four questions are now `SECURITY DEFINER` functions created by migration 0013
 * (`due_hold_expiry_scopes`, `due_transition_scopes`, `purge_expired_idempotency_keys`), whose
 * return type is a pair of `(project_id, environment)` or a count of deleted rows and therefore
 * cannot carry a booking, a customer or an event. The worker runs on the application pool
 * alone; everything that then reads or writes project data goes through `withProjectContext`
 * and the engine, exactly as before.
 *
 * The rule everywhere is the smallest privilege that works, and a long-lived
 * superuser pool in an unattended process was the largest privilege in the deployment and the
 * least watched one. The only privileged connection left in the worker process is pg-boss's own,
 * which owns the `pgboss` schema and carries no tenant data.
 */
import { sql, withProjectContext, type Database } from '@bookrail/db';
import {
  dueTransitions,
  expireHolds,
  transition,
  type TouchedDay,
  type TransitionResult,
} from '@bookrail/engine';
import type { Environment, Logger } from '@bookrail/shared';
import { invalidateTouchedDays } from '../cache.js';
import type { AppDeps } from '../context.js';

/** How many (project, environment) pairs one tick takes on. */
export const MAX_SCOPES_PER_TICK = 200;

export interface HoldExpiryReport {
  scopes: number;
  expired: number;
  invalidated: number;
}

interface Scope {
  projectId: string;
  environment: Environment;
}

/**
 * The (project, environment) pairs that have at least one hold occupancy past its expiry.
 *
 * Ordered by project so the answer is stable, and capped: a tick that found ten thousand
 * scopes would hold the worker for minutes and starve the next one. Both properties live in
 * the function (migration 0013), so the ordering and the cap are the same wherever it is
 * called from.
 */
async function dueScopes(db: Database): Promise<Scope[]> {
  const { rows } = await db.execute<{ project_id: string; environment: Environment }>(
    sql`SELECT project_id, environment FROM due_hold_expiry_scopes(${MAX_SCOPES_PER_TICK})`,
  );
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/**
 * Marks every hold whose time is up, writes its `hold.expired` event, and drops the days it
 * occupied from the availability cache.
 *
 * A failure on one project does not stop the others: the sweep is idempotent (a hold already
 * expired is simply no longer due), so the right answer to one project's error is to log it
 * and carry on, not to leave the rest of the estate stale.
 */
export async function runHoldExpiry(
  deps: Pick<AppDeps, 'db' | 'cache' | 'logger'>,
): Promise<HoldExpiryReport> {
  const report: HoldExpiryReport = { scopes: 0, expired: 0, invalidated: 0 };
  for (const scope of await dueScopes(deps.db)) {
    report.scopes += 1;
    try {
      let more = true;
      while (more) {
        const result = await expireHolds(deps.db, {
          projectId: scope.projectId,
          environment: scope.environment,
        });
        report.expired += result.expired.length;
        const days: TouchedDay[] = [...result.touchedDays];
        report.invalidated += days.length;
        await invalidateTouchedDays(deps, days);
        more = result.more && result.expired.length > 0;
      }
    } catch (error) {
      deps.logger.warn('hold_expiry_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/**
 * Deletes the `idempotency_keys` rows past their 24 hour retention.
 *
 * Cross-project by nature and pure housekeeping (the rows carry a stored response, never a
 * decision), so it is one statement rather than one transaction per project. It is also the
 * only cross-project **write** in the worker, which is why `purge_expired_idempotency_keys`
 * returns a count and nothing else: there is no shape of its result that could carry a row of
 * somebody's data out of the function. The cap keeps a first run after a long outage from
 * writing a single enormous transaction.
 */
export async function purgeIdempotencyKeys(
  deps: { db: Database; logger: Logger },
  limit = 10_000,
): Promise<number> {
  const { rows } = await deps.db.execute<{ deleted: number }>(
    sql`SELECT purge_expired_idempotency_keys(${limit}) AS deleted`,
  );
  return rows[0]?.deleted ?? 0;
}

/**
 * Clears the sign up rows nothing can use any more.
 *
 * Three things in one statement each, and all three are housekeeping rather than a decision:
 * an envelope past its fifteen minutes is a key nobody may collect, an unconfirmed request past
 * its hour is a link that no longer works, and a row older than a week is a record of somebody
 * asking for a key that was either issued or abandoned. The last one is why this exists at all:
 * the address in it is personal data, and keeping it after it has stopped being useful is the
 * one thing a retention promise cannot survive.
 *
 * Cross project by nature, like the idempotency purge next to it, and for the same reason it
 * runs through a `SECURITY DEFINER` function whose result is a count and nothing else.
 */
export async function purgeSignups(deps: { db: Database; logger: Logger }): Promise<number> {
  const { rows } = await deps.db.execute<{ touched: number }>(
    sql`SELECT signups_purge() AS touched`,
  );
  return rows[0]?.touched ?? 0;
}

/**
 * Deletes the Stripe OAuth states whose fifteen minutes have run out.
 *
 * Cross project by nature, like the two purges above, and for the same reason it goes through a
 * `SECURITY DEFINER` function whose result is a count and nothing else. Unlike the sign up
 * purge this is tidiness rather than retention: a state row carries no address and no secret,
 * only a digest of a value that is already useless. What it prevents is an unbounded table of
 * rows nothing will ever read.
 */
export async function purgeStripeOauthStates(deps: {
  db: Database;
  logger: Logger;
}): Promise<number> {
  const { rows } = await deps.db.execute<{ deleted: number }>(
    sql`SELECT stripe_oauth_states_purge() AS deleted`,
  );
  return rows[0]?.deleted ?? 0;
}

// --- Automatic state transitions --------------------------------------------------

/** How many bookings one project's tick moves. Keeps each transaction, and the tick, bounded. */
export const MAX_TRANSITIONS_PER_SCOPE = 200;

export interface TransitionReport {
  scopes: number;
  applied: number;
  /** Somebody else had already moved the booking: not an error, and not work either. */
  skipped: number;
  failed: number;
  invalidated: number;
}

/**
 * The (project, environment) pairs with at least one booking whose automatic transition is due.
 *
 * Same shape, and same justification, as {@link dueScopes} for the hold sweep: *which*
 * projects have work is a cross-project question that Row Level Security makes unanswerable
 * to the application role by construction, so it is asked of a `SECURITY DEFINER` function
 * whose answer is a list of scope pairs. Everything that then reads or writes a booking goes
 * back through the application role, inside `withProjectContext`, through the engine.
 */
async function dueTransitionScopes(db: Database, now: number): Promise<Scope[]> {
  // The instant is the caller's, not the database's: the whole point of `now` being a
  // parameter is that a test can ask "what would happen at 09:15 next Monday" without waiting
  // for it, and a discovery query on `now()` would answer for today instead. It is therefore
  // an argument of the function too.
  const { rows } = await db.execute<{ project_id: string; environment: Environment }>(sql`
    SELECT project_id, environment
      FROM due_transition_scopes(${new Date(now).toISOString()}::timestamptz,
                                 ${MAX_SCOPES_PER_TICK})
  `);
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/**
 * Applies every automatic transition whose time has come.
 *
 * `in_progress` at the start, `completed` at the end, `no_show` after the grace period, each
 * only if the frozen policy asked for it. All three go through the **same** `transition()` a
 * customer's `POST` goes through (the matrix, the consequences, the event and the cache
 * coordinates are computed once, in one place), with `actor: {type: 'system'}` as the only
 * difference.
 *
 * **Two workers are safe, and not by luck.** Each booking is moved in its own transaction,
 * which locks the row `FOR UPDATE` and only then checks that `next_transition` is still the
 * one this tick selected. The second worker to arrive waits on that lock, finds the column
 * cleared or changed, and returns `applied: false` without writing anything or emitting an
 * event. `skipped` in the report is exactly that count.
 *
 * One booking failing does not stop the rest: a transition the state machine now refuses (a
 * booking cancelled a millisecond before the worker reached it) is a log line, and the next
 * tick will not find it again because the cancellation cleared its clock.
 */
export async function runBookingTransitions(
  deps: Pick<AppDeps, 'db' | 'cache' | 'logger'>,
  options: { now?: number; batchSize?: number } = {},
): Promise<TransitionReport> {
  const now = options.now ?? Date.now();
  const batchSize = options.batchSize ?? MAX_TRANSITIONS_PER_SCOPE;
  const report: TransitionReport = {
    scopes: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    invalidated: 0,
  };

  for (const scope of await dueTransitionScopes(deps.db, now)) {
    report.scopes += 1;
    // The due list is read in its own short transaction and then released: holding it open
    // while every booking is moved would keep one snapshot, and one connection, for the whole
    // batch.
    let due;
    try {
      due = await withProjectContext(
        deps.db,
        { projectId: scope.projectId, environment: scope.environment },
        (tx) => dueTransitions(tx, now, batchSize),
      );
    } catch (error) {
      report.failed += 1;
      deps.logger.warn('booking_transitions_scan_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const item of due) {
      let result: TransitionResult;
      try {
        result = await transition(deps.db, {
          projectId: scope.projectId,
          environment: scope.environment,
          bookingId: item.bookingId,
          action: item.action,
          actor: { type: 'system', id: null },
          now,
          expectedNextTransition: item.action,
        });
      } catch (error) {
        report.failed += 1;
        deps.logger.warn('booking_transition_failed', {
          project_id: scope.projectId,
          environment: scope.environment,
          booking_id: item.bookingId,
          action: item.action,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!result.applied) {
        report.skipped += 1;
        continue;
      }
      report.applied += 1;
      report.invalidated += result.touchedDays.length;
      await invalidateTouchedDays(deps, [...result.touchedDays]);
    }
  }
  return report;
}
