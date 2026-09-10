-- 0016 — The three corrections the independent review of brief 007a asked for.
--
-- All three are about the same function family, and it is worth saying what they have in
-- common: migration 0014 gave the capacity guard the privileges of the definer because the
-- plan Row Level Security forced on it was a scan of the whole project, and 0015 built the
-- nightly integrity check on top of it. Both were right about the plan and careless about the
-- surface: what the *trigger* needs elevated is not the same as what the *application role*
-- should be able to call, and a check that truncates without an order is not a check.
--
--   I2 — `occupancies_over_capacity` was `SECURITY DEFINER` **and** granted to the application
--        role, so a request could ask it about a resource of another tenant and get back a
--        resource id, a peak and a capacity. The elevation moves to the trigger function, where
--        the arguments are `NEW.resource_id` and nothing else, and the inner function loses both
--        the grant and the elevation it no longer needs.
--   m1 — `occupancies_assert_capacity()` had no `SET search_path`. It does now, which it must,
--        because it is the one function here that a stranger's statement causes to run.
--   I1 — the integrity check has to tell a **legitimate** capacity reduction from a broken
--        invariant, and to do that it needs to know *which window* is over capacity, so that the
--        job can look for the `booking.orphaned` event that explains it. `occupancies_over_capacity`
--        computed the window and threw it away.
--   I3 — `capacity_violations` truncated with `LIMIT` and no `ORDER BY`: above the cap the
--        subset measured changed from run to run, so a real violation could be seen one night
--        and not the next with nothing having changed. Not partial: random.
--
-- ## What this supersedes, and why the older files still say otherwise
--
-- Migrations 0014 and 0015 are applied on databases this file has never seen, so their **text**
-- cannot be touched: the runner checks a checksum per file, and editing an applied migration —
-- even a comment — makes it drift. Two things they say are therefore no longer true, and they
-- are corrected here rather than there:
--
--   * `0014`'s comment on `occupancies_over_capacity` says the function is `SECURITY DEFINER`
--     because a resource belongs to one project, "so nothing crosses a tenant boundary". That
--     holds for the trigger's call and not for a caller that chooses the arguments, which is the
--     hole this migration closes. Its measurement table is stale too; the new numbers are below.
--   * `0015` says `capacity_violations` is "always empty" and that a row in it means the
--     invariant has been broken. It is not, and it does not: lowering `resources.capacity` below
--     what is already sold is an allowed operation that leaves the resource genuinely over
--     capacity, and it is what `booking.orphaned` reports with `capacity_exceeded`. The caller
--     now separates the explained rows from the rest (`runIntegrityCheck`), and the `COMMENT ON`
--     re-issued at the bottom of this file is the one the database actually carries.

-- --- I2 and m1: the elevation moves to the trigger --------------------------------------------
--
-- `occupancies_assert_capacity()` is the only caller that has to run elevated, and it is the one
-- caller whose arguments nobody chooses: `ARRAY[NEW.resource_id]` and the row's own period. As a
-- `SECURITY DEFINER` function it keeps the fast plan for the trigger — which is the whole reason
-- 0014 elevated anything — while the application role goes back to having no way at all to ask
-- about a resource it cannot see.
--
-- `SET search_path` is not decoration here. A `SECURITY DEFINER` function resolves its tables,
-- functions and operators with the caller's `search_path` unless it pins its own; pinning it is
-- what stops a caller who could create an object in an earlier schema from having it run with
-- the definer's privileges. Today no such caller exists — the application role can create
-- neither schemas nor functions in `public` — but that is a property of today's grants, not of
-- this function.
-- ## And it turned out to be ten times cheaper
--
-- Unexpected, and worth recording because the number in migration 0014's comment is now stale.
-- With the elevation on the **inner** function the trigger body ran as the application role and
-- only the measurement switched user; with it on the trigger function the whole body runs as one
-- role, and the plan for the measurement stops being re-planned on every call (Postgres keys a
-- cached plan to the user when Row Level Security is in play on any table it touches). Measured
-- on the same fixture as `packages/engine/scripts/consolidation-bench.ts`, 1 000 inserts in a
-- plpgsql loop as the application role:
--
--     guard off                          : 0,041 ms per row
--     guard on, elevation on the inner fn: 2,3-2,8 ms per row, growing with the project
--     guard on, elevation here (0016)    : 0,102 ms per row
--
-- End to end on `createBooking`: **+1,4 %** on the p50, where 0014 measured +12,6 % and the
-- brief allowed +15 %. The security fix paid for itself.
ALTER FUNCTION occupancies_assert_capacity() SECURITY DEFINER;
ALTER FUNCTION occupancies_assert_capacity() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION occupancies_assert_capacity() FROM PUBLIC;

COMMENT ON FUNCTION occupancies_assert_capacity() IS
  'The net for capacity N: recomputes the peak of capacity_used over the period the row just '
  'written occupies, and raises 23514 if it is above resources.capacity. SECURITY DEFINER since '
  'migration 0016, because this is the caller whose arguments nobody chooses; the measurement '
  'function underneath it is no longer reachable from the application role. Deliberately not '
  'granted to anyone: a trigger function is called by the trigger, never by hand.';

-- --- I1 and I3: the measurement keeps its window ----------------------------------------------
--
-- Same arithmetic as migration 0014 — still one definition, still `occupancy_footprint` — with
-- the window carried through to the result instead of being grouped away. `capacity_violations`
-- needs it to ask "is there a `booking.orphaned` that explains this?", and the trigger does not
-- care: `occupancies_assert_capacity` reads `resource_id`, `peak` and `capacity` by name out of
-- a `record`, so a fourth column changes nothing for it.
--
-- It is also no longer `SECURITY DEFINER`. It does not need to be: both callers
-- (`occupancies_assert_capacity` and `capacity_violations`) are definer functions owned by this
-- role, so the query inside them already runs with the privileges that keep the GiST index
-- `occ_resource_period` in the plan. Elevation now lives in exactly two named places, and
-- neither of them takes its arguments from a request.
DROP FUNCTION capacity_violations(integer);
DROP FUNCTION occupancies_over_capacity(uuid[], tstzrange[]);

CREATE FUNCTION occupancies_over_capacity(p_rids uuid[], p_wins tstzrange[])
RETURNS TABLE (resource_id uuid, window_period tstzrange, peak bigint, capacity integer)
LANGUAGE sql
STABLE
AS $$
  WITH win AS (
    SELECT t.rid, t.w FROM unnest(p_rids, p_wins) AS t(rid, w)
  ), fp AS (
    SELECT win.rid, win.w, o.capacity_used AS used,
           occupancy_footprint(o.period, o.kind, o.buffer_before_ms, o.buffer_after_ms) AS f
      FROM win
      JOIN occupancies o
        ON o.resource_id = win.rid
       AND o.active
       AND (o.expires_at IS NULL OR o.expires_at > now())
       AND o.period && win.w
  ), ev AS (
    -- ORDER BY at, delta below is load bearing, exactly as in `peakUsage`: at one instant the
    -- closes have to be applied before the opens, which is what a half open period means.
    SELECT fp.rid, fp.w, GREATEST(lower(fp.f), lower(fp.w)) AS at, fp.used AS delta FROM fp
    UNION ALL
    SELECT fp.rid, fp.w, LEAST(upper(fp.f), upper(fp.w)), -fp.used FROM fp
  ), run AS (
    SELECT ev.rid, ev.w,
           SUM(ev.delta) OVER (PARTITION BY ev.rid, ev.w ORDER BY ev.at, ev.delta
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
      FROM ev
  ), peaks AS (
    SELECT run.rid, run.w, MAX(run.running) AS used FROM run GROUP BY run.rid, run.w
  )
  SELECT peaks.rid, peaks.w, peaks.used, r.capacity
    FROM peaks JOIN resources r ON r.id = peaks.rid
   WHERE peaks.used > r.capacity
$$;

COMMENT ON FUNCTION occupancies_over_capacity(uuid[], tstzrange[]) IS
  'The (resource, window) pairs whose peak of capacity_used is above resources.capacity, with '
  'the window kept so a caller can say which period is over. SECURITY INVOKER: its two callers '
  'are definer functions, so the GiST index on (resource_id, period) is in the plan anyway — '
  'the && operator is not leakproof, so under Row Level Security the policy predicate runs '
  'first and the plan degenerates into a scan of the whole project. Not granted to the '
  'application role: migration 0014 did grant it, and that let a request ask about a resource '
  'of another tenant.';

REVOKE ALL ON FUNCTION occupancies_over_capacity(uuid[], tstzrange[]) FROM PUBLIC;

-- --- I3: a deterministic scan, and a size to compare it with ----------------------------------
--
-- `ORDER BY` before `LIMIT`, so the subset measured is the same on every run: a check whose
-- answer wanders is worse than no check, because an `error` that appears and disappears trains
-- everybody to ignore it. The order is `(resource_id, period)`, and it is **total** because the
-- scan is over `DISTINCT (resource_id, period)` and the default ordering of `tstzrange` is by
-- lower bound and then upper bound. Ordering by the two output columns rather than by
-- `lower(period)` is also what `SELECT DISTINCT` allows: an expression that is not in the select
-- list cannot be an ordering key there, which is Postgres refusing to sort by something it might
-- have collapsed.
--
-- The cap stays: this is a full scan of the live occupancies and it runs on a schedule. What is
-- new is that the caller can now say how much of the estate it measured, because
-- `capacity_scan_size()` answers the other half of the sentence. "50 000 windows measured" means
-- nothing on its own; "50 000 of 51 200" and "50 000 of 3 000 000" are different situations.
CREATE FUNCTION capacity_scan_size()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::bigint FROM (
    SELECT DISTINCT o.resource_id, o.period
      FROM occupancies o
     WHERE o.active AND (o.expires_at IS NULL OR o.expires_at > now())
  ) s
$$;

COMMENT ON FUNCTION capacity_scan_size() IS
  'How many (resource, occupied period) windows a full integrity scan would have to measure. '
  'The denominator of the integrity check log line: without it a capped scan cannot say whether '
  'it saw the estate or a corner of it.';

CREATE FUNCTION capacity_violations(max_windows integer)
RETURNS TABLE (
  project_id uuid,
  environment text,
  resource_id uuid,
  window_start timestamptz,
  window_end timestamptz,
  peak bigint,
  capacity integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH scanned AS (
    SELECT DISTINCT o.resource_id AS rid, o.period AS w
      FROM occupancies o
     WHERE o.active AND (o.expires_at IS NULL OR o.expires_at > now())
     ORDER BY 1, 2
     LIMIT max_windows
  ), agg AS (
    SELECT array_agg(scanned.rid) AS rids, array_agg(scanned.w) AS wins FROM scanned
  ), bad AS (
    SELECT v.resource_id AS rid, v.window_period AS w, v.peak AS pk, v.capacity AS cap
      FROM agg, LATERAL occupancies_over_capacity(agg.rids, agg.wins) v
     WHERE agg.rids IS NOT NULL
  )
  SELECT r.project_id, r.environment, bad.rid, lower(bad.w), upper(bad.w), bad.pk, bad.cap
    FROM bad JOIN resources r ON r.id = bad.rid
   ORDER BY r.project_id, r.environment, bad.rid, lower(bad.w)
$$;

COMMENT ON FUNCTION capacity_violations(integer) IS
  'Every (resource, occupied window) whose peak of capacity_used is above the resource capacity, '
  'in a stable order so a capped scan measures the same subset every night. A row here is NOT '
  'necessarily a broken invariant: lowering resources.capacity below what is already sold is an '
  'allowed operation (04 § Invarianti 1) and leaves the resource genuinely over capacity. The '
  'caller separates the two by looking for a booking.orphaned event with reason capacity_exceeded '
  'over the same window; see runIntegrityCheck in packages/api/src/jobs/reconcile.ts.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'capacity_violations(integer)',
    'capacity_scan_size()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
