-- 0014 — The footprint of an occupancy, once, in SQL; and the database net for capacity N
-- (brief 007a, points 5 and 6).
--
-- ## Why a function
--
-- The arithmetic that turns an occupancy row into the span of time it takes away from a
-- resource existed three times: `occupancyFootprint` in TypeScript, the `CASE … GREATEST` of
-- `peakUsage` in `queries.ts`, and a third copy in `peakUsagePerPeriod` in `orphaned.ts`. Three
-- copies of a rule that decides whether a booking is accepted is two copies too many: the read
-- side and the write side disagreeing by one millisecond is a slot that is offered and then
-- refused. From here the SQL side has one definition and the TypeScript one is held against it
-- by a property test on random inputs.
--
-- ## The parameters
--
-- `share_left_ms` / `share_right_ms` are how much of the occupancy's own buffer the *querying*
-- context absorbs. `services.buffer_sharing` is a property of the crossing, not of the row
-- (migration 0009): without sharing the two buffers add up and the caller passes zero; with
-- sharing they overlap and the caller passes its own buffers, so only the excess survives.
-- `NULL` — the default — means "absorb everything", which yields the bare period and is what a
-- reader with no querying service at all asks for. Blocks carry no buffers in any case.
--
-- `IMMUTABLE` deserves a word, because `timestamptz + interval` is only `STABLE` in general: an
-- interval carrying months or days depends on the session time zone. The intervals here never
-- do — `interval '1 millisecond' * n` is a pure time interval — so the result is a function of
-- the arguments alone, which is exactly what `IMMUTABLE` claims.

CREATE FUNCTION occupancy_footprint(
  period tstzrange,
  kind text,
  buffer_before_ms integer,
  buffer_after_ms integer,
  share_left_ms integer DEFAULT NULL,
  share_right_ms integer DEFAULT NULL
) RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT tstzrange(
    lower(period) - interval '1 millisecond' *
      (CASE WHEN kind = 'block' THEN 0
            ELSE GREATEST(0, buffer_before_ms - COALESCE(share_left_ms, buffer_before_ms))
       END),
    upper(period) + interval '1 millisecond' *
      (CASE WHEN kind = 'block' THEN 0
            ELSE GREATEST(0, buffer_after_ms - COALESCE(share_right_ms, buffer_after_ms))
       END),
    '[)')
$$;

COMMENT ON FUNCTION occupancy_footprint(tstzrange, text, integer, integer, integer, integer) IS
  'The span an occupancy takes away from a resource: its period widened by its own buffers, '
  'less what the querying context absorbs. NULL shares mean "absorb everything", i.e. the bare '
  'period. The single SQL definition behind peakUsage, peakUsagePerPeriod and the capacity '
  'guard; occupancyFootprint in TypeScript is held against it by a property test.';

-- --- The net --------------------------------------------------------------------------------
--
-- `04 § Invarianti` (1) says capacity is never exceeded. Until now that was two guarantees of
-- different kinds: `occ_no_overlap_cap1` — the database itself, for resources of capacity 1 —
-- and `takeOccupancy`, the single door in the application, for capacity N. The second is
-- discipline: it holds because exactly one function writes `occupancies` and it takes the
-- advisory lock before it measures. A fourth writer that skipped it, or a hand-run `INSERT` in
-- a migration or a support session, would not be protected by anything.
--
-- This trigger is the generalisation of `occ_no_overlap_cap1` to capacity N: after every
-- statement that adds or moves capacity, the peak of `capacity_used` over the spans the
-- statement touched is recomputed from the table itself and compared with `resources.capacity`.
-- It does **not** replace the advisory lock — `takeOccupancy` stays the only door, and it is
-- still the thing that makes concurrent bookings queue instead of collide. This is the net
-- under it, and it fails the write with `23514` (`check_violation`), which is the same class of
-- answer the exclusion constraint gives.
--
-- ## Core periods, not footprints
--
-- The guard measures the **bare period** of every occupancy — `occupancy_footprint` with no
-- sharing arguments — and that is deliberate. A footprint is not a property of a row: how much
-- of an occupancy's buffer counts against a new booking depends on the `buffer_sharing` flag of
-- the *service asking*, which the database has no way of knowing at write time. Measuring full
-- footprints here would refuse writes that the engine legitimately accepts on a service with
-- `buffer_sharing: true`, which is the one failure mode a net must never have.
--
-- Measuring core periods, on the other hand, can never refuse what `takeOccupancy` accepted:
-- footprints contain core periods, so the peak the engine computed is never smaller than the
-- one computed here. The net is therefore strictly weaker than the engine's check — it does not
-- police buffers — and strictly a superset of `occ_no_overlap_cap1`, which also ignores them.
-- Buffers are a scheduling courtesy; capacity is a fact about the resource, and this is the
-- fact the invariant is about.
--
-- ## Per row, and the measurement that decided it
--
-- The first version was a statement level trigger with transition tables: one query per
-- statement instead of one per row, which is the right shape for a bulk write. It was measured
-- and it is the wrong shape here. `takeOccupancy` writes **one row per statement**, so the
-- transition tables bought nothing and cost a tuplestore plus a second plpgsql statement (the
-- one that decides which of the transition rows are worth checking) on every write. On a fresh
-- database, six alternating blocks of 33 bookings each, 2000 existing occupancies
-- (`packages/engine/scripts/consolidation-bench.ts`):
--
--     statement level, transition tables : p50 6.75 ms against 5.69 ms without the guard (+18.6 %)
--     row level, invoker rights          : p50 6.76 ms against 5.67 ms (+19.2 %) — the plan below
--     row level, definer rights          : p50 6.09 ms against 5.41 ms (+12.6 %, three runs
--                                          11.9 / 12.7 / 13.3)
--
-- The middle line is the one that mattered, and it is why the measurement function above is
-- `SECURITY DEFINER`: the trigger's shape was already right, and what was expensive was the
-- plan Row Level Security forced on it.
--
-- The `WHEN` clause is what makes the row form cheaper than the statement form rather than
-- merely equal to it: Postgres evaluates it without entering plpgsql at all, so a release
-- (`active` goes false) and a capacity sync cost **nothing**, where the statement form had to
-- start the function and run a query to discover it had nothing to do.
--
-- ## What fires it
--
-- Every INSERT of an active row, and every UPDATE that makes a row active or moves its span,
-- its quantity, its resource, its kind or its expiry. The column that must **not** fire it is
-- `single_capacity_resource`: `resources_capacity_sync` (migration 0006) rewrites it on every
-- capacity change, and lowering a resource's capacity below what is already sold is allowed on
-- purpose — it is what `booking.orphaned` reports (brief 004a). A guard that fired there would
-- turn a documented event into a failed `PATCH`. With `OLD` and `NEW` both in scope the filter
-- is one boolean expression in the trigger definition, which is also the cheapest place it can
-- possibly live.
--
-- It is not a `CONSTRAINT TRIGGER`: deferring the check to `COMMIT` would surface a capacity
-- failure at the commit of a transaction whose statements all succeeded, where no caller is
-- prepared to map it to a `409`.

-- The measurement itself, so that both triggers below share one definition of it.
--
-- The caller passes the (resource, window) pairs its statement touched; the function
-- recomputes, from the table, the peak of `capacity_used` at any single instant of each window
-- and returns the pairs that are over the resource's capacity. A running maximum and not a sum:
-- a plain sum over an interval refuses a slot the availability engine offers, which is the one
-- way the read side and the write side must never disagree (`queries.ts`, `peakUsage`).
--
-- `o.period && win.w` is the exact overlap test **because** the footprints here are bare
-- periods: with the sharing arguments left out, `occupancy_footprint` returns `period` itself,
-- so the GiST index `occ_resource_period` answers the question directly and no padding is
-- needed for buffers that are not being counted.
--
-- ## Why it is `SECURITY DEFINER`, and what that costs
--
-- Measured, not assumed. As a plain `SECURITY INVOKER` function the guard ran under the caller's
-- Row Level Security, and `range_overlaps` (the `&&` of the join) is **not** leakproof: Postgres
-- must then evaluate the policy predicate before it, which takes the GiST index
-- `occ_resource_period` out of play and leaves a scan of every occupancy of the project behind
-- `occupancies_scope_idx`. On the bench fixture that is 13 600 rows read to answer a question
-- about three, 4,4 ms per write instead of 0,06 ms, and — worse than the number — a cost that
-- grows with the size of the project for ever. With the guard bypassing RLS the plan is the
-- index scan the shape of the query deserves.
--
-- Bypassing is also the **correct** reading. A resource belongs to exactly one (project,
-- environment) — the composite foreign key of migration 0004 says so, and every occupancy that
-- names it inherits the pair — so the rows this function can now see are precisely the rows it
-- could see before. Nothing crosses a tenant boundary; what changes is only which index answers.
--
-- The privilege it hands the application role is one question with a fixed shape: given resource
-- ids and windows, which of them are over capacity. It returns a resource id, a peak and a
-- capacity, never a booking, a customer or a period, and only for a resource that is **already**
-- in a state the system does not allow. `12 § Isolamento dei dati` is about tenant data; this is
-- an assertion about the invariant, and the answer to it is always the empty set.
CREATE FUNCTION occupancies_over_capacity(p_rids uuid[], p_wins tstzrange[])
RETURNS TABLE (resource_id uuid, peak bigint, capacity integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
    -- Reversing it would count two occupancies that merely touch as overlapping.
    SELECT fp.rid, fp.w, GREATEST(lower(fp.f), lower(fp.w)) AS at, fp.used AS delta FROM fp
    UNION ALL
    SELECT fp.rid, fp.w, LEAST(upper(fp.f), upper(fp.w)), -fp.used FROM fp
  ), run AS (
    SELECT ev.rid, ev.w,
           SUM(ev.delta) OVER (PARTITION BY ev.rid, ev.w ORDER BY ev.at, ev.delta
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
      FROM ev
  ), peaks AS (
    SELECT run.rid, MAX(run.running) AS used FROM run GROUP BY run.rid, run.w
  )
  SELECT peaks.rid, peaks.used, r.capacity
    FROM peaks JOIN resources r ON r.id = peaks.rid
   WHERE peaks.used > r.capacity
$$;

COMMENT ON FUNCTION occupancies_over_capacity(uuid[], tstzrange[]) IS
  'The (resource, window) pairs whose peak of capacity_used is above resources.capacity. '
  'SECURITY DEFINER, so the GiST index on (resource_id, period) answers it: the && operator is '
  'not leakproof, so under Row Level Security the policy predicate runs first and the plan '
  'degenerates into a scan of the whole project. A resource belongs to one project, so the rows '
  'in scope are the same either way.';

REVOKE ALL ON FUNCTION occupancies_over_capacity(uuid[], tstzrange[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occupancies_over_capacity(uuid[], tstzrange[]) TO ${APP_ROLE};

CREATE FUNCTION occupancies_assert_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offender record;
BEGIN
  SELECT v.* INTO offender
    FROM occupancies_over_capacity(
           ARRAY[NEW.resource_id],
           ARRAY[occupancy_footprint(NEW.period, NEW.kind,
                                     NEW.buffer_before_ms, NEW.buffer_after_ms)]) v
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'capacity of resource % exceeded: % units are taken where capacity is %',
      offender.resource_id, offender.peak, offender.capacity
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'occ_capacity_not_exceeded';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION occupancies_assert_capacity() IS
  'The net for capacity N: recomputes the peak of capacity_used over the period the row just '
  'written occupies, and raises 23514 if it is above resources.capacity. The generalisation of '
  'occ_no_overlap_cap1 to capacity N; takeOccupancy remains the only door.';

CREATE TRIGGER occupancies_capacity_guard_insert
  AFTER INSERT ON occupancies
  FOR EACH ROW WHEN (NEW.active)
  EXECUTE FUNCTION occupancies_assert_capacity();

-- The `WHEN` clause is the whole reason this is a row trigger (see above): it is evaluated
-- without entering plpgsql, so a release (`active` goes false) and a capacity sync (only
-- `single_capacity_resource` moves) cost nothing at all, and lowering a resource under what is
-- already sold stays the allowed operation `booking.orphaned` reports.
CREATE TRIGGER occupancies_capacity_guard_update
  AFTER UPDATE ON occupancies
  FOR EACH ROW
  WHEN (
    NEW.active
    AND (NOT OLD.active
         OR OLD.resource_id IS DISTINCT FROM NEW.resource_id
         OR OLD.period IS DISTINCT FROM NEW.period
         OR OLD.capacity_used IS DISTINCT FROM NEW.capacity_used
         OR OLD.kind IS DISTINCT FROM NEW.kind
         OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
         OR OLD.buffer_before_ms IS DISTINCT FROM NEW.buffer_before_ms
         OR OLD.buffer_after_ms IS DISTINCT FROM NEW.buffer_after_ms)
  )
  EXECUTE FUNCTION occupancies_assert_capacity();
