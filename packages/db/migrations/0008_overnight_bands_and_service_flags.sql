-- 0008 — Overnight schedule bands, buffer sharing and split bookings (brief 002b).
--
-- Two unrelated but small changes, kept in one migration because both close a gap the
-- availability engine already has and the API did not.
--
-- 1. The `end_time > start_time` checks of 0003 made every band that crosses midnight
--    unstorable. `06-motore-disponibilita.md § Fusi orari` says a band whose end is not
--    strictly after its start crosses midnight (`22:00-02:00` is four hours) and that
--    `00:00-00:00` is the whole local day, which is exactly what `materializeSchedule`
--    produces. The database rejected both, so the engine's support for night shifts was
--    unreachable through the API.
--
--    The two constraints are dropped by looking their definition up in the catalogue rather
--    than by their generated name (`schedule_rules_check`, `schedule_exceptions_check1`),
--    which depends on the order the unnamed checks happened to be created in.
--
-- 2. `services` gains `buffer_sharing` (case 5 of `06 § Casi limite`: two adjacent bookings
--    may share the gap between them instead of each demanding its own) and `allow_split`
--    (case 8: eight people across two tables of four). Both default to false, which is the
--    behaviour every existing row already had.
--
-- No new table, so no new RLS policy: 0007 enabled and forced row level security on
-- `schedule_rules`, `schedule_exceptions` and `services`, and its table-level GRANTs cover
-- columns added later.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('schedule_rules'::regclass, 'schedule_exceptions'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%end_time > start_time%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END
$$;

-- A band still has to be complete: both times or neither. Neither means "the whole local
-- day" for an exception; a half specified band has no meaning and the engine raises on it,
-- which would be a 500 rather than a 400. The API already refuses it since brief 002a; this
-- is the same rule one layer down.
ALTER TABLE schedule_exceptions
  ADD CONSTRAINT schedule_exceptions_band_complete
  CHECK ((start_time IS NULL) = (end_time IS NULL));

ALTER TABLE services
  ADD COLUMN buffer_sharing boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_split    boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN services.buffer_sharing IS
  'When true two adjacent bookings may overlap each other buffers; the gap between them is '
  'max(buffer_before, buffer_after) instead of their sum. 06-motore-disponibilita.md, case 5.';
COMMENT ON COLUMN services.allow_split IS
  'When true a quantity larger than any single resource may be served by summing the residual '
  'capacity of several resources of the same group. 06-motore-disponibilita.md, case 8.';
