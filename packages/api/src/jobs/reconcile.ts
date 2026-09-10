/**
 * The two nightly reconciliations that keep the data integrity promises honest.
 *
 * Everything else in `jobs/` is a sweep: work that is *due* and has to be done. These two are
 * not. They do no work at all in the normal case; they exist to find out whether the normal case
 * is what is actually happening. An invariant that nobody measures is a hope, and the two the
 * system leans on hardest are both measurable from the database alone:
 *
 *  * **capacity is never exceeded.** The trigger of migration 0014 keeps it true going forward;
 *    {@link runIntegrityCheck} asks whether it *is* true, which is a different question and the
 *    only one that covers rows written before the trigger existed, written while it was
 *    disabled, or written by a repair that got it wrong.
 *
 *    **A resource over capacity is not automatically a broken invariant**, and getting this wrong
 *    was the first version's mistake. Lowering `resources.capacity` below what is already sold is
 *    an **allowed** operation: what the invariant binds is every write that *takes* capacity, and
 *    lowering the column takes nothing. The trigger deliberately does not fire on it, and it is
 *    exactly what `booking.orphaned` reports with reason `capacity_exceeded`. It leaves the
 *    resource genuinely over capacity until the business resolves it. A check that shouted `error`
 *    at that would shout at business as usual, and an alarm built on a line that cries wolf is the
 *    surest way to make sure nobody looks the night it is real. So the job separates the two: a
 *    window over capacity for which an explaining `booking.orphaned` exists is **expected** and
 *    counted apart, and only the rest is a violation of the invariant. Above zero the line is at
 *    `error` level and there is nothing else: nothing yet watches those log lines, so a capacity
 *    violation is a paging incident on paper only, and pretending otherwise in a comment would be
 *    worse than saying so;
 *
 *  * **a future booking still stands on its calendar.** `booking.orphaned` is emitted by the
 *    write that breaks a booking, but only for the bookings that start within ninety days of that
 *    write: a horizon that exists because a `PATCH` on a schedule happens while somebody waits for
 *    the response. A booking further out is broken in silence. {@link runOrphanReconciliation} runs
 *    the same detection, on its own time, over a horizon wide enough to cover the bookings that
 *    exist.
 *
 * **No deduplication.** A booking that is still inconsistent tonight gets another
 * `booking.orphaned` tonight. That is the semantics of the log: one event per detection, not
 * one per problem. The alternative (remembering what was already reported) would be a state
 * machine about a state machine. A consumer that wants "new since yesterday" has the event id
 * and the cursor.
 */
import { sql, withProjectContext, type Database } from '@bookrail/db';
import { detectOrphanedBookings } from '@bookrail/engine';
import { encodeId, type Environment } from '@bookrail/shared';
import type { AppDeps } from '../context.js';

/** Live occupancies one integrity run measures. Above this it stops and says so. */
export const DEFAULT_INTEGRITY_MAX_WINDOWS = 50_000;

/**
 * How far ahead the reconciliation looks.
 *
 * Two years, not ninety days: the point of this job is precisely the bookings the interactive
 * path does not reach. Wider than the bookings anybody actually takes, and still a bounded scan.
 */
export const DEFAULT_RECONCILE_HORIZON_DAYS = 730;

/** Bookings one scope examines per run. */
export const DEFAULT_RECONCILE_LIMIT = 5_000;

/** (project, environment) pairs one run visits. */
export const DEFAULT_RECONCILE_SCOPES = 500;

export interface IntegrityReport {
  /**
   * Windows over capacity that **nothing explains**: the invariant is broken. Always zero.
   *
   * A count of (resource, occupied window) pairs and not of resources: one resource with ten
   * overlapping occupancies produces ten of them, which is why {@link resources} is reported
   * beside it.
   */
  violations: number;
  /** Distinct resources among the unexplained windows. */
  resources: number;
  /**
   * Windows over capacity that a `booking.orphaned` (reason `capacity_exceeded`) accounts for:
   * somebody lowered a capacity under what was already sold, which is allowed and already
   * reported to the customer. Expected, not an error.
   */
  explained: number;
  /** Windows this run measured, and how many exist. `scanned < total` means the cap bit. */
  scanned: number;
  total: number;
  /** The first few unexplained ones, so the log says where to look. */
  samples: { projectId: string; environment: string; resourceId: string; peak: number }[];
}

/** How many offenders the log names before it stops naming them. */
const MAX_SAMPLES = 5;

interface ViolationRow {
  projectId: string;
  environment: Environment;
  resourceId: string;
  windowStart: Date;
  windowEnd: Date;
  peak: number;
  capacity: number;
}

/**
 * Counts the windows whose resource is over capacity, across every project, and splits them.
 *
 * The scan runs on `capacity_violations`, a `SECURITY DEFINER` function of migrations 0015 and
 * 0016: the question is cross-project by nature and Row Level Security makes it unanswerable to
 * the application role, and the function's return type carries a resource, a window and two
 * numbers, never a booking or a customer. Same reasoning as the sweeps' scope discovery in
 * `tasks.ts`.
 *
 * The **second** half of the run is not cross-project at all: deciding whether a window is
 * explained means reading that project's events, and that happens inside `withProjectContext`
 * like every other read of tenant data. One transaction per scope, and a scope that fails is a
 * warning and not the end of the run, but its windows are then counted as unexplained, because
 * "I could not check" must never round down to "nothing to see".
 */
export async function runIntegrityCheck(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  options: { maxWindows?: number } = {},
): Promise<IntegrityReport> {
  const maxWindows = options.maxWindows ?? DEFAULT_INTEGRITY_MAX_WINDOWS;
  const { rows } = await deps.db.execute<{
    project_id: string;
    environment: Environment;
    resource_id: string;
    window_start: Date;
    window_end: Date;
    peak: string;
    capacity: number;
  }>(sql`SELECT * FROM capacity_violations(${maxWindows})`);
  const { rows: sizeRows } = await deps.db.execute<{ total: string }>(
    sql`SELECT capacity_scan_size() AS total`,
  );

  const total = Number(sizeRows[0]?.total ?? 0);
  const violations: ViolationRow[] = rows.map((row) => ({
    projectId: row.project_id,
    environment: row.environment,
    resourceId: row.resource_id,
    windowStart: new Date(row.window_start),
    windowEnd: new Date(row.window_end),
    peak: Number(row.peak),
    capacity: row.capacity,
  }));

  const byScope = new Map<string, ViolationRow[]>();
  for (const row of violations) {
    const key = `${row.projectId}:${row.environment}`;
    const bucket = byScope.get(key);
    if (bucket === undefined) byScope.set(key, [row]);
    else bucket.push(row);
  }

  const unexplained: ViolationRow[] = [];
  let explained = 0;
  for (const bucket of byScope.values()) {
    const scope = { projectId: bucket[0]!.projectId, environment: bucket[0]!.environment };
    let known: Set<number>;
    try {
      known = await withProjectContext(deps.db, scope, (tx) => explainedWindows(tx, bucket));
    } catch (error) {
      // Counted as unexplained on purpose: an integrity check that answers "fine" when it could
      // not look is worse than one that answers "look at this".
      deps.logger.warn('integrity_check_scope_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
      known = new Set();
    }
    bucket.forEach((row, index) => {
      if (known.has(index)) explained += 1;
      else unexplained.push(row);
    });
  }

  const report: IntegrityReport = {
    violations: unexplained.length,
    resources: new Set(unexplained.map((row) => row.resourceId)).size,
    explained,
    scanned: Math.min(maxWindows, total),
    total,
    samples: unexplained.slice(0, MAX_SAMPLES).map((row) => ({
      projectId: row.projectId,
      environment: row.environment,
      resourceId: row.resourceId,
      peak: row.peak,
    })),
  };

  // `violations` and `explained` count (resource, window) pairs, not resources: `unit` says so
  // in the line itself, because a number whose unit has to be looked up is a number that will be
  // read wrong at three in the morning.
  const line = {
    check: 'capacity',
    unit: 'resource_window',
    violations: report.violations,
    resources: report.resources,
    explained: report.explained,
    scanned_windows: report.scanned,
    total_windows: report.total,
  };
  if (report.violations > 0)
    deps.logger.error('integrity.check', { ...line, samples: report.samples });
  else if (report.explained > 0) deps.logger.warn('integrity.check', line);
  else deps.logger.info('integrity.check', line);
  return report;
}

/**
 * Which of a scope's over-capacity windows a `booking.orphaned` already accounts for.
 *
 * The event carries the booking's own period and a list of reasons, each naming a resource; a
 * window is explained when some `booking.orphaned` for **that** resource, with reason
 * `capacity_exceeded`, covers a booking whose period overlaps it. That is the same statement the
 * customer already received, which is what makes the window expected rather than alarming.
 *
 * Deliberately **not** time-bounded. An orphan reported six months ago and never resolved still
 * explains the window today: the point is whether somebody was told, not when.
 */
async function explainedWindows(
  tx: Parameters<Parameters<typeof withProjectContext>[2]>[0],
  bucket: readonly ViolationRow[],
): Promise<Set<number>> {
  const { rows } = await tx.execute<{ i: string }>(sql`
    SELECT DISTINCT t.i
      FROM unnest(${sql.param(bucket.map((row) => encodeId('resource', row.resourceId)))}::text[],
                  ${sql.param(bucket.map((row) => row.windowStart.toISOString()))}::timestamptz[],
                  ${sql.param(bucket.map((row) => row.windowEnd.toISOString()))}::timestamptz[])
             WITH ORDINALITY AS t(rid, ws, we, i)
      JOIN events e
        ON e.type = 'booking.orphaned'
       AND tstzrange((e.data ->> 'start')::timestamptz,
                     (e.data ->> 'end')::timestamptz, '[)') && tstzrange(t.ws, t.we, '[)')
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.data -> 'reasons') r
              WHERE r ->> 'code' = 'capacity_exceeded' AND r ->> 'resource_id' = t.rid
           )
  `);
  // `WITH ORDINALITY` is one based; the caller indexes from zero.
  return new Set(rows.map((row) => Number(row.i) - 1));
}

export interface OrphanReconciliationReport {
  scopes: number;
  /** Bookings reported as orphaned by this run, over every scope. */
  orphaned: number;
  failed: number;
}

interface Scope {
  projectId: string;
  environment: Environment;
}

/**
 * The (project, environment) pairs with at least one live booking in the future.
 *
 * `future_booking_scopes`, migration 0015. A scope whose bookings are all in the past has
 * nothing to reconcile: `booking.orphaned` is about promises, and a promise that has been kept
 * or broken is no longer one.
 */
async function scopesWithFutureBookings(
  db: Database,
  now: number,
  limit: number,
): Promise<Scope[]> {
  const { rows } = await db.execute<{ project_id: string; environment: Environment }>(sql`
    SELECT project_id, environment
      FROM future_booking_scopes(${new Date(now).toISOString()}::timestamptz, ${limit})
  `);
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/**
 * Re-runs `booking.orphaned` detection over a wide horizon, project by project.
 *
 * One transaction per scope, inside `withProjectContext` and therefore under Row Level Security:
 * the detection reads the calendar and writes events exactly as a `PATCH` does, and it must be
 * able to do neither more nor less than one. The resource list is read inside that context too,
 * so a project cannot be asked about somebody else's resources even by accident.
 *
 * One project failing does not stop the rest. The run is idempotent in the only sense that
 * matters here (it observes and reports, it never changes a booking), so the answer to an
 * error is a log line and the next scope.
 */
export async function runOrphanReconciliation(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  options: {
    now?: number;
    horizonDays?: number;
    limit?: number;
    scopes?: number;
  } = {},
): Promise<OrphanReconciliationReport> {
  const now = options.now ?? Date.now();
  const horizonDays = options.horizonDays ?? DEFAULT_RECONCILE_HORIZON_DAYS;
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  const report: OrphanReconciliationReport = { scopes: 0, orphaned: 0, failed: 0 };

  for (const scope of await scopesWithFutureBookings(
    deps.db,
    now,
    options.scopes ?? DEFAULT_RECONCILE_SCOPES,
  )) {
    report.scopes += 1;
    try {
      const found = await withProjectContext(
        deps.db,
        { projectId: scope.projectId, environment: scope.environment },
        async (tx) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            SELECT id FROM resources WHERE status = 'active' AND deleted_at IS NULL
          `);
          if (rows.length === 0) return 0;
          const orphans = await detectOrphanedBookings(tx, {
            projectId: scope.projectId,
            environment: scope.environment,
            resourceIds: rows.map((row) => row.id),
            now,
            horizonDays,
            limit,
          });
          return orphans.length;
        },
      );
      report.orphaned += found;
    } catch (error) {
      report.failed += 1;
      deps.logger.warn('orphan_reconciliation_failed', {
        project_id: scope.projectId,
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (report.orphaned > 0 || report.failed > 0) {
    deps.logger.info('orphan_reconciliation', { ...report, horizon_days: horizonDays });
  }
  return report;
}
