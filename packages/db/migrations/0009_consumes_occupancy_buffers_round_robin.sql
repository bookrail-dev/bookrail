-- 0009 — What a requirement consumes, the buffers an occupancy carries, and the round robin
-- cursor of a group (brief 003a).
--
-- Three columns, one per hole the availability engine of brief 002b left open and the
-- booking transaction of 003a has to close.
--
-- 1. `service_requirements.consumes` (decisione del PM, 2026-09-02). Until now the engine
--    compared the requested quantity with the residual capacity of **every** required
--    resource: the yoga class of `25 § 3` — fifteen seats, one instructor, one room — forced
--    the instructor and the room to be modelled with a fictitious capacity of fifteen.
--    `'per_unit'` keeps the old behaviour (the requirement takes `quantity` units of the
--    resource: the room, the table); `'whole'` takes the resource entirely whatever the
--    quantity is (the instructor, the doctor, the machine), and the resource is usable only
--    when it is completely free. The same number is written to `occupancies.capacity_used`
--    and `booking_allocations.capacity_used`.
--
-- 2. `occupancies.buffer_before_ms` / `buffer_after_ms`. An occupancy did not carry the
--    buffers of the service that created it, so the engine widened every existing occupancy
--    with the buffers of the service it was *querying*: two services with different buffers
--    on one resource computed a distance that was not the real one. The footprint of an
--    occupancy now travels with the row. `services.buffer_sharing` keeps its meaning — it is
--    a property of the crossing, not of the row: without sharing the two buffers add up,
--    with sharing they overlap.
--
--    Milliseconds, not minutes: the engine's domain is integer milliseconds everywhere, and
--    an integer column of milliseconds cannot lose a sub-minute buffer a future API may
--    accept.
--
-- 3. `resource_groups.round_robin_cursor`: the last resource the group allocated. The
--    `round_robin` strategy needs state, and brief 002b could only rotate by the index of
--    the slot inside one response. The cursor is updated inside the booking transaction.
--
-- No new table, so no new RLS policy: 0007 enabled and forced row level security on the
-- three tables and its table-level GRANTs cover columns added later.

ALTER TABLE service_requirements
  ADD COLUMN consumes text NOT NULL DEFAULT 'per_unit'
  CHECK (consumes IN ('per_unit', 'whole'));

COMMENT ON COLUMN service_requirements.consumes IS
  'per_unit: the requirement consumes `quantity` units of the resource. '
  'whole: it consumes the entire capacity of the resource, which must therefore be free. '
  '04-modello-dati.md, § Service.';

-- The 24 hour ceiling is not decoration: every reader widens its query window by a fixed
-- padding before looking for the occupancies whose footprint could reach into it (26 hours in
-- `load.ts`, 25 in the booking transaction). A buffer larger than that padding would make an
-- occupancy invisible to a query it should have blocked. The API already caps a service's
-- buffers at 1440 minutes.
ALTER TABLE occupancies
  ADD COLUMN buffer_before_ms integer NOT NULL DEFAULT 0
    CHECK (buffer_before_ms BETWEEN 0 AND 86400000),
  ADD COLUMN buffer_after_ms  integer NOT NULL DEFAULT 0
    CHECK (buffer_after_ms BETWEEN 0 AND 86400000);

COMMENT ON COLUMN occupancies.buffer_before_ms IS
  'Buffer the occupancy carries before its period, in milliseconds. Blocks carry none. '
  '06-motore-disponibilita.md, case 5.';
COMMENT ON COLUMN occupancies.buffer_after_ms IS
  'Buffer the occupancy carries after its period, in milliseconds.';

ALTER TABLE resource_groups
  ADD COLUMN round_robin_cursor uuid;

-- Composite, like every other foreign key between project tables: the cursor can never point
-- at a resource of another project or of the other environment. The column-list form of
-- ON DELETE SET NULL is mandatory here, because project_id and environment are NOT NULL.
ALTER TABLE resource_groups
  ADD CONSTRAINT resource_groups_round_robin_cursor_fkey
  FOREIGN KEY (round_robin_cursor, project_id, environment)
  REFERENCES resources (id, project_id, environment)
  ON DELETE SET NULL (round_robin_cursor);

COMMENT ON COLUMN resource_groups.round_robin_cursor IS
  'Last resource this group allocated; round_robin starts from the next one. '
  '06-motore-disponibilita.md, § Gruppi e allocazione.';
