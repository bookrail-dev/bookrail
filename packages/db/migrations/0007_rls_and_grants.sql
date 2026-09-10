-- 0007 — Row Level Security and the privileges of the application role.
--
-- Every project table gets one permissive policy that pins both project_id and environment
-- to the transaction-local settings app.project_id / app.environment. `current_setting(..., true)`
-- returns NULL when the setting was never assigned, and `nullif(..., '')` turns the reset value
-- back into NULL, so a connection that forgot to set the context sees exactly zero rows:
-- the failure mode is empty, never permissive.

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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        FOR ALL
        TO ${APP_ROLE}
        USING (
          project_id = nullif(current_setting('app.project_id', true), '')::uuid
          AND environment = nullif(current_setting('app.environment', true), '')
        )
        WITH CHECK (
          project_id = nullif(current_setting('app.project_id', true), '')::uuid
          AND environment = nullif(current_setting('app.environment', true), '')
        )
    $p$, t || '_project_isolation', t);
  END LOOP;
END
$$;

-- api_keys is project scoped like the rest, but authentication has to find the key BEFORE a
-- project context exists. The lookup policy is therefore readable only while no context is
-- set; as soon as the request adopts a project, the usual isolation policy is the only one
-- that can match, for reads as well as writes.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY api_keys_auth_lookup ON api_keys
  FOR SELECT
  TO ${APP_ROLE}
  USING (nullif(current_setting('app.project_id', true), '') IS NULL);

CREATE POLICY api_keys_project_isolation ON api_keys
  FOR ALL
  TO ${APP_ROLE}
  USING (
    project_id = nullif(current_setting('app.project_id', true), '')::uuid
    AND environment = nullif(current_setting('app.environment', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('app.project_id', true), '')::uuid
    AND environment = nullif(current_setting('app.environment', true), '')
  );

-- Privileges -----------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE};

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};

-- accounts and projects are control plane: the runtime reads them, only the admin
-- connection (POST /internal/bootstrap, migrations) writes them.
REVOKE INSERT, UPDATE, DELETE ON accounts, projects FROM ${APP_ROLE};

-- events is append-only. This is the guarantee behind `04-modello-dati.md § Event`.
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM ${APP_ROLE};

-- api_keys: the runtime reads keys to authenticate and stamps last_used_at. Nothing else.
-- Without this, a key scoped to a tenant could mint a new key for the same project without
-- that scope, which is privilege escalation. Key lifecycle belongs to the admin connection.
REVOKE INSERT, UPDATE, DELETE ON api_keys FROM ${APP_ROLE};
GRANT UPDATE (last_used_at) ON api_keys TO ${APP_ROLE};

-- The migration ledger is not application data: the role that serves HTTP requests must not
-- be able to rewrite the checksums that guard against edits to applied migrations.
-- The table is created by the migration runner before the first file, so it already exists.
DO $$
BEGIN
  IF to_regclass('public._slotbase_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON _slotbase_migrations FROM ${APP_ROLE}';
  END IF;
END
$$;

-- Migrations own the schema; the application never changes it.
REVOKE CREATE ON SCHEMA public FROM ${APP_ROLE};
