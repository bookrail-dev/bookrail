-- 0017 — The application role follows the product's new name (brief 014).
--
-- The product was called Slotbase until 7 September 2026 and is called Bookrail from that day.
-- Every identifier derived from the old name is renamed in the same change; this file is the
-- database's half of it, and it is the ONE file in this repository that still spells the old
-- name, because a migration that has been applied can never be edited again: its text is
-- checksummed, and rewriting it would make every existing database look tampered with.
--
-- ## The role
--
-- `ALTER ROLE ... RENAME TO ...` keeps the role's oid, and therefore every grant, every policy
-- that names it, every default privilege and every object it owns. It does NOT keep a password
-- that was set with the pre-2016 `md5` verifier, because that verifier hashes the role name
-- into the digest. SCRAM-SHA-256 does not: its verifier stores a salt and two keys derived from
-- the password alone, so a SCRAM password survives a rename. Postgres has defaulted to SCRAM
-- since version 14 and Neon uses it exclusively, so the connection strings keep working with
-- only the user name changed. Postgres warns about this in the ALTER ROLE documentation, and
-- the migration verifies it rather than trusting it: if the role somehow still carried an md5
-- verifier, the block below refuses to rename instead of silently locking the API out.
--
-- Idempotent in both directions: on a database created after the rename, migration 0001 has
-- already created the role under its new name and there is nothing here to do.
--
-- ## The ledger
--
-- Renaming the migration ledger cannot be done here: it is the table this runner reads to know
-- which migrations are applied, so it is adopted by `adoptLegacyMigrationsTable` in
-- `packages/db/src/migrate.ts` before any migration runs. What is left for this file is the
-- privilege: migration 0007 revoked the application role's access to the ledger only when it
-- found it under the old name, so on a database created after the rename the revoke never ran.

DO $$
DECLARE
  legacy_role CONSTANT text := 'slotbase_app';
  verifier text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = legacy_role)
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN

    -- pg_authid is superuser-only, and on a managed platform the migration role is not one.
    -- Not being able to look is not a reason to stop: Postgres has defaulted to SCRAM since 14
    -- and Neon uses nothing else. The check runs where it can, and is skipped where it cannot.
    BEGIN
      SELECT rolpassword INTO verifier FROM pg_authid WHERE rolname = legacy_role;
    EXCEPTION WHEN insufficient_privilege THEN
      verifier := NULL;
    END;
    IF verifier IS NOT NULL AND verifier LIKE 'md5%' THEN
      RAISE EXCEPTION
        'role % still has an md5 password verifier, which is derived from the role name: '
        'renaming it would invalidate the password. Set a SCRAM password first.', legacy_role;
    END IF;

    EXECUTE format('ALTER ROLE %I RENAME TO %I', legacy_role, '${APP_ROLE}');
  END IF;
END
$$;

-- The migration ledger is not application data: the role that serves HTTP requests must not be
-- able to rewrite the checksums that guard against edits to applied migrations. Same statement
-- as 0007, under the name the ledger has now.
DO $$
BEGIN
  IF to_regclass('public._bookrail_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON _bookrail_migrations FROM ${APP_ROLE}';
  END IF;
END
$$;
