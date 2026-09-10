-- 0006 — Triggers: updated_at everywhere, denormalised capacity flag on occupancies.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations', 'schedules', 'schedule_rules', 'schedule_exceptions', 'resources',
    'resource_groups', 'resource_group_members', 'resource_blocks', 'policies', 'services',
    'service_requirements', 'customers', 'recurrences', 'holds', 'bookings',
    'booking_allocations', 'occupancies', 'waitlist_entries', 'entitlements', 'payments',
    'events', 'webhooks', 'webhook_deliveries'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t
    );
  END LOOP;
END
$$;

-- occupancies.single_capacity_resource mirrors `resources.capacity = 1`.
-- It exists only so that the exclusion constraint occ_no_overlap_cap1 can be a partial
-- index predicate: a predicate cannot contain a subquery, so the fact has to live on the row.
CREATE OR REPLACE FUNCTION occupancies_set_single_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resource_capacity integer;
BEGIN
  SELECT capacity INTO resource_capacity FROM resources WHERE id = NEW.resource_id;
  IF resource_capacity IS NULL THEN
    RAISE EXCEPTION 'occupancy % references unknown resource %', NEW.id, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.single_capacity_resource := (resource_capacity = 1);
  RETURN NEW;
END
$$;

CREATE TRIGGER occupancies_single_capacity
  BEFORE INSERT OR UPDATE OF resource_id ON occupancies
  FOR EACH ROW EXECUTE FUNCTION occupancies_set_single_capacity();

-- Changing the capacity of a resource has to re-flag its occupancies, otherwise a resource
-- lowered to capacity 1 would keep accepting overlaps.
CREATE OR REPLACE FUNCTION resources_sync_single_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE occupancies
     SET single_capacity_resource = (NEW.capacity = 1)
   WHERE resource_id = NEW.id
     AND single_capacity_resource IS DISTINCT FROM (NEW.capacity = 1);
  RETURN NULL;
END
$$;

CREATE TRIGGER resources_capacity_sync
  AFTER UPDATE OF capacity ON resources
  FOR EACH ROW WHEN (OLD.capacity IS DISTINCT FROM NEW.capacity)
  EXECUTE FUNCTION resources_sync_single_capacity();
