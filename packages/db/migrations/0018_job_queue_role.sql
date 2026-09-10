-- 0018 — A role of its own for the job queue (brief 014; `11 § Il worker dei job`).
--
-- pg-boss owns the `pgboss` schema and runs its own DDL there at start-up, so it needs a
-- connection that can create tables in that schema. Until this migration that connection was
-- the migration role: on Neon `neondb_owner`, which has BYPASSRLS and can read and write every
-- tenant's rows in every table. The process holding it is the worker, and the worker is the
-- one process in the system that makes outbound HTTP requests to addresses customers choose.
-- The pairing was the wrong way round.
--
-- ${JOBS_ROLE} owns the `pgboss` schema and nothing else:
--
--   * NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT, like the application role;
--   * CONNECT on this database, USAGE on `public` (it needs the built-in functions, not the
--     tables: 0007's REVOKE leaves it with no privilege on any table there, and this file adds
--     none);
--   * owner of the schema `pgboss` and of every object already inside it, which is what lets
--     pg-boss run its own migrations.
--
-- The password is not here. Migration files are checksummed and a checksum of a secret is a
-- secret in the repository: the runner sets it from JOBS_DB_PASSWORD after the migrations, the
-- same way it does for the application role.
--
-- Idempotent: a re-run finds the role, finds the ownership already transferred, and does
-- nothing. Transferring ownership needs the right to SET ROLE to the new owner, which is not
-- what creating a role gives you; the GRANT below is what arranges it, and its comment says
-- why it is unconditional.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${JOBS_ROLE}') THEN
    CREATE ROLE ${JOBS_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- Re-assert the security-relevant attributes even if the role pre-existed, and fail loudly
-- rather than quietly when a managed platform refuses the ALTER (same shape as 0001).
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = '${JOBS_ROLE}';
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    BEGIN
      ALTER ROLE ${JOBS_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'role ${JOBS_ROLE} has elevated attributes and cannot be altered here';
    END;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ${JOBS_ROLE};
GRANT USAGE ON SCHEMA public TO ${JOBS_ROLE};

-- The queue is not application data and the application role has never had access to it; this
-- only restates it now that the schema changes hands.
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON SCHEMA pgboss FROM ${APP_ROLE};

DO $$
DECLARE
  obj record;
BEGIN
  -- `ALTER ... OWNER TO` requires the right to `SET ROLE` to the new owner, and that is not
  -- what a role gets for having created another one. On Postgres 16 and later a CREATEROLE
  -- role receives its new role back with ADMIN OPTION but with SET and INHERIT decided by
  -- `createrole_self_grant`, which is empty by default: on Neon the first attempt at this
  -- migration failed with "must be able to SET ROLE bookrail_jobs" even though
  -- `pg_has_role(..., 'MEMBER')` was already true. So the grant is unconditional and explicit
  -- about the option that matters, and it is idempotent: re-granting updates the option
  -- instead of failing. Not swallowed either: a platform that refuses it stops the migration
  -- here, with its own message, rather than three statements later with a confusing one.
  --
  -- It grants the *weaker* role to the stronger one, which adds no privilege to anybody: the
  -- migration role already has everything bookrail_jobs has and a great deal more.
  EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE', '${JOBS_ROLE}');

  EXECUTE format('ALTER SCHEMA pgboss OWNER TO %I', '${JOBS_ROLE}');

  FOR obj IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE pgboss.%I OWNER TO %I', obj.relname, '${JOBS_ROLE}');
    ELSIF obj.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW pgboss.%I OWNER TO %I', obj.relname, '${JOBS_ROLE}');
    ELSIF obj.relkind = 'm' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW pgboss.%I OWNER TO %I', obj.relname, '${JOBS_ROLE}');
    ELSE
      EXECUTE format('ALTER TABLE pgboss.%I OWNER TO %I', obj.relname, '${JOBS_ROLE}');
    END IF;
  END LOOP;

  FOR obj IN
    SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'pgboss' AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE pgboss.%I OWNER TO %I', obj.typname, '${JOBS_ROLE}');
  END LOOP;

  FOR obj IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'pgboss'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', obj.signature, '${JOBS_ROLE}');
  END LOOP;
END
$$;
