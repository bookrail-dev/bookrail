-- 0015 — The two questions the daily reconciliation jobs ask (brief 007a, point 9).
--
-- `11-infrastruttura-e-affidabilita.md § Integrità dei dati` asks for a periodic check that the
-- invariants still hold, on the grounds that an invariant nobody measures is a hope. Two of them
-- are measurable from the database alone:
--
--   1. **capacity is never exceeded** (`04 § Invarianti`, 1). Migration 0014 added the trigger
--      that keeps it true going forward; this function answers the different question of whether
--      it *is* true right now, including for rows written before the trigger existed, or written
--      while it was disabled, or written by a repair that got it wrong. It must always find zero;
--   2. **every future booking still stands on its calendar.** `booking.orphaned` is emitted by
--      the write that breaks a booking, and only within the ninety day horizon of
--      `06 § Finestra`: a booking further out is broken silently. The reconciliation job walks
--      the same detection over a wider horizon, on its own schedule, and the scopes it has to
--      visit are what `future_booking_scopes` returns.
--
-- Both are `SECURITY DEFINER` for the reason migration 0013 gives: they are cross-project
-- questions, Row Level Security makes them unanswerable to the application role by design, and
-- a function with a fixed result type is a smaller privilege than a superuser connection.
-- Neither can return a customer, a booking or an event.

CREATE FUNCTION capacity_violations(max_windows integer)
RETURNS TABLE (project_id uuid, environment text, resource_id uuid, peak bigint, capacity integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH scanned AS (
    SELECT DISTINCT o.resource_id AS rid, o.period AS w
      FROM occupancies o
     WHERE o.active AND (o.expires_at IS NULL OR o.expires_at > now())
     LIMIT max_windows
  ), agg AS (
    SELECT array_agg(scanned.rid) AS rids, array_agg(scanned.w) AS wins FROM scanned
  ), bad AS (
    SELECT v.resource_id AS rid, v.peak AS pk, v.capacity AS cap
      FROM agg, LATERAL occupancies_over_capacity(agg.rids, agg.wins) v
     WHERE agg.rids IS NOT NULL
  )
  SELECT r.project_id, r.environment, bad.rid, bad.pk, bad.cap
    FROM bad JOIN resources r ON r.id = bad.rid
$$;

COMMENT ON FUNCTION capacity_violations(integer) IS
  'Every (resource, occupied period) whose peak of capacity_used is above the resource capacity. '
  'Always empty; a row here means invariant 1 of 04 § Invarianti has been broken by something '
  'that did not go through takeOccupancy. Capped, because it is a full scan of the live '
  'occupancies and it runs on a schedule, not on a request.';

CREATE FUNCTION future_booking_scopes(from_at timestamptz, max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT b.project_id, b.environment
    FROM bookings b
   WHERE b.status IN ('pending', 'confirmed', 'in_progress')
     AND b.starts_at > from_at
   ORDER BY b.project_id, b.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION future_booking_scopes(timestamptz, integer) IS
  'The (project, environment) pairs with at least one live booking starting after from_at. The '
  'set the orphan reconciliation job walks; a scope with nothing in the future has nothing to '
  'reconcile.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'capacity_violations(integer)',
    'future_booking_scopes(timestamptz, integer)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
