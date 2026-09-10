-- 0001 — Extensions and the non-superuser application role.
--
-- Migrations run as a superuser (DATABASE_URL / DATABASE_ADMIN_URL). The API and the
-- integration tests connect as ${APP_ROLE}, which is deliberately NOSUPERUSER and
-- NOBYPASSRLS: without that, Row Level Security would be decorative.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- Idempotent: re-assert the security-relevant attributes even if the role pre-existed.
-- On managed platforms (Neon) roles are owned by the platform and ALTER ROLE is refused to the
-- database owner; that is acceptable only when the attributes are already what we require, so
-- the block verifies them first and fails loudly otherwise (PM fix, 2026-09-04).
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = '${APP_ROLE}';
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    BEGIN
      ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'role ${APP_ROLE} has elevated attributes and cannot be altered here';
    END;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ${APP_ROLE};
GRANT USAGE ON SCHEMA public TO ${APP_ROLE};

-- Shared trigger function that keeps updated_at honest on every table.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
