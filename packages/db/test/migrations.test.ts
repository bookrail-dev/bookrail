import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ALL_TABLES, DEFINER_ONLY_TABLES, PROJECT_TABLES } from '../src/schema/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptLedger,
  loadMigrations,
  migrate,
  migrationReport,
  resetSchema,
} from '../src/migrate.js';
import { deriveAppUrl, withDatabaseName } from '../src/config.js';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, expectPgError, testUrls } from './helpers.js';
import { createProject } from './fixtures.js';
import { TEST_DB_NAME } from './db-name.js';

/**
 * Throwaway databases named after the suite's own database, not after fixed global names.
 * A cluster is shared: two suites running at once, or a suite while a reviewer works on the
 * same Postgres, used to drop each other's probe database, because `DROP DATABASE IF EXISTS`
 * on a constant name is a constant that two processes both own. `TEST_DATABASE_NAME` already
 * separates the suites; this follows it.
 */
const probeDb = (suffix: string): string => `${TEST_DB_NAME}_${suffix}`;

describe('migrations', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await adminClient();
  });

  afterAll(async () => {
    await admin.end();
  });

  it('creates every table of the data model', async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const table of ALL_TABLES) {
      expect(present.has(table), `missing table ${table}`).toBe(true);
    }
    expect(ALL_TABLES.length).toBe(32);
  });

  it('creates an application role that is neither superuser nor BYPASSRLS', async () => {
    const { appRole } = testUrls();
    const { rows } = await admin.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`, [appRole]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolcanlogin).toBe(true);
  });

  /**
   * Derived from the catalogue, not from a hand written list: a future table that carries a
   * project_id but was forgotten in PROJECT_TABLES and in migration 0007 fails here instead of
   * silently shipping without RLS.
   */
  it('enables and forces row level security on every table that has a project_id', async () => {
    const { rows } = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND a.attnum > 0)
        ORDER BY c.relname`,
    );

    // `api_keys` is project scoped too, with the extra authentication-time lookup policy.
    // `signups` carries a `project_id` and is **not** a project table: the column is the project
    // the sign up created, filled in by the confirm, and there is nothing to key a policy on
    // because the row exists before the project does. It is here because it must still be
    // enabled and forced, which the loop below checks; that it has no policy at all, and that
    // the application role can touch none of it, is `signups.test.ts`.
    const expected = [...PROJECT_TABLES, 'api_keys', ...DEFINER_ONLY_TABLES].sort();
    expect(rows.map((r) => r.relname)).toEqual(expected);

    for (const row of rows) {
      expect(row.relrowsecurity, `RLS off on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `RLS not forced on ${row.relname}`).toBe(true);
    }
  });

  it('gives every project table a policy that pins both project_id and environment', async () => {
    const { rows } = await admin.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE '%_project_isolation'`,
    );
    const byTable = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of [...PROJECT_TABLES, 'api_keys']) {
      const policy = byTable.get(table);
      expect(policy, `no isolation policy on ${table}`).toBeDefined();
      expect(policy?.qual).toContain('app.project_id');
      expect(policy?.qual).toContain('app.environment');
      expect(policy?.with_check).toContain('app.project_id');
      expect(policy?.with_check).toContain('app.environment');
    }
  });

  it('keeps the migration ledger out of reach of the application role', async () => {
    const { appRole } = testUrls();
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const { rows } = await admin.query<{ has: boolean }>(
        `SELECT has_table_privilege($1, '_bookrail_migrations', $2) AS has`,
        [appRole, privilege],
      );
      expect(rows[0]?.has, `${appRole} should not ${privilege} _bookrail_migrations`).toBe(false);
    }
  });

  it('lets the application role read api_keys and touch only last_used_at', async () => {
    const { appRole } = testUrls();
    const table = await admin.query<{ p: string; has: boolean }>(
      `SELECT p, has_table_privilege($1, 'api_keys', p) AS has
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`,
      [appRole],
    );
    const byName = new Map(table.rows.map((r) => [r.p, r.has]));
    expect(byName.get('SELECT')).toBe(true);
    expect(byName.get('INSERT')).toBe(false);
    expect(byName.get('DELETE')).toBe(false);
    // Table-wide UPDATE is gone; only the column grant remains.
    expect(byName.get('UPDATE')).toBe(false);

    const columns = await admin.query<{ c: string; has: boolean }>(
      `SELECT c, has_column_privilege($1, 'api_keys', c, 'UPDATE') AS has
         FROM unnest(ARRAY['last_used_at','scopes','tenant_id','revoked_at','key_hash']) AS c`,
      [appRole],
    );
    const byColumn = new Map(columns.rows.map((r) => [r.c, r.has]));
    expect(byColumn.get('last_used_at')).toBe(true);
    for (const column of ['scopes', 'tenant_id', 'revoked_at', 'key_hash']) {
      expect(byColumn.get(column), `${appRole} should not UPDATE api_keys.${column}`).toBe(false);
    }
  });

  /**
   * Migration 0013 closed the last exception to the rule that every table a request can reach
   * carries Row Level Security. `accounts` and `projects` are control plane, but the application
   * role reads them, so they carry it like everything else. Their policies do not pin an
   * `environment` (neither table has the column), so they are named `_control_plane_isolation`
   * and are not picked up by the `_project_isolation` check above.
   */
  it('forces row level security on the control plane and keeps it read-only', async () => {
    const { appRole } = testUrls();
    const { rows } = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname IN ('accounts','projects')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, `RLS off on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `RLS not forced on ${row.relname}`).toBe(true);
    }

    const { rows: policies } = await admin.query<{ tablename: string; qual: string }>(
      `SELECT tablename, qual FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE '%_control_plane_isolation'`,
    );
    expect(policies.map((p) => p.tablename).sort()).toEqual(['accounts', 'projects']);
    for (const policy of policies) {
      expect(policy.qual).toContain('app.project_id');
    }

    for (const table of ['accounts', 'projects']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
        const { rows: check } = await admin.query<{ has: boolean }>(
          `SELECT has_table_privilege($1, $2, $3) AS has`,
          [appRole, table, privilege],
        );
        expect(check[0]?.has, `${appRole} should not ${privilege} ${table}`).toBe(false);
      }
      const { rows: read } = await admin.query<{ has: boolean }>(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS has`,
        [appRole, table],
      );
      expect(read[0]?.has).toBe(true);
    }
  });

  it('creates the capacity-1 exclusion constraint and the GiST index on occupancies', async () => {
    const { rows: constraints } = await admin.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'occupancies'::regclass AND contype = 'x'`,
    );
    expect(constraints.map((r) => r.conname)).toContain('occ_no_overlap_cap1');
    const definition = constraints.find((r) => r.conname === 'occ_no_overlap_cap1')?.def ?? '';
    expect(definition).toContain('EXCLUDE USING gist');
    expect(definition).toContain('period WITH &&');
    expect(definition).toContain('single_capacity_resource');
    // Deliberately NOT gated on capacity_used: see migration 0004. Gating on it left a hole
    // for occupancies written before the resource capacity was lowered to 1.
    expect(definition).not.toContain('capacity_used');

    const { rows: indexes } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'occupancies'`,
    );
    const gist = indexes.find((r) => r.indexname === 'occ_resource_period');
    expect(gist?.indexdef).toContain('USING gist');
    expect(gist?.indexdef).toContain('WHERE active');
  });

  /**
   * Migration 0020. `price_rule` is the provenance of `price_amount`: it says which rule
   * produced the number, so a booking with no number cannot name a rule that produced it.
   * The engine already holds to it (`priceRuleOf` answers null exactly when `priceForSlot`
   * does), and this is the database saying the same thing, which is where an invariant about
   * the shape of a booking row belongs.
   */
  it('refuses a booking that names a pricing rule without a price', async () => {
    const { projectId } = await createProject(admin, 'Price rule invariant');
    const serviceId = uuidv7();
    await admin.query(
      `INSERT INTO services (id, project_id, environment, name, duration_minutes)
       VALUES ($1, $2, 'test', 'Match 60', 60)`,
      [serviceId, projectId],
    );
    const insert = (priceAmount: number | null, priceRule: string | null): Promise<unknown> =>
      admin.query(
        `INSERT INTO bookings (id, project_id, environment, service_id, starts_at, ends_at,
                               timezone, price_amount, currency, price_rule)
         VALUES ($1, $2, 'test', $3, '2026-09-08T07:00:00Z', '2026-09-08T08:00:00Z',
                 'Europe/Rome', $4, 'EUR', $5::jsonb)`,
        [uuidv7(), projectId, serviceId, priceAmount, priceRule],
      );

    const failure = await expectPgError(insert(null, '{"index": 0, "label": "Weekend"}'));
    expect(failure.code).toBe('23514');
    expect(failure.message).toContain('bookings_price_rule_needs_price');

    // The two readings that are true stay legal: priced by a rule, and priced flat with no rule.
    await insert(3500, '{"index": 0, "label": "Weekend"}');
    await insert(null, null);
  });

  it('installs btree_gist', async () => {
    const { rows } = await admin.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const urls = testUrls();
    const result = await migrate({ adminUrl: urls.admin, appRole: urls.appRole });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * Migration 0001 writes pg_authid, which is global to the cluster. Two setups migrating two
   * different databases at the same time, what turbo does with the test task of two packages,
   * used to kill one of them with `tuple concurrently updated`.
   */
  /**
   * The rollout that has to keep working: the worker boots before the
   * migration job, pg-boss creates its own `pgboss` schema and queues jobs, and *then* 0010
   * runs. It must find the schema, leave it alone, and not block behind the worker.
   *
   * A throwaway database, migrated up to 0009 only, is the faithful way to test it: the state
   * "0010 not yet applied, pgboss already populated" cannot exist on the shared test database.
   */
  it('leaves an already populated pgboss schema alone when 0010 is applied', async () => {
    const urls = testUrls();
    const name = probeDb('pgboss_rollout');
    const maintenance = new Client({ connectionString: withDatabaseName(urls.admin, 'postgres') });
    await maintenance.connect();
    const target = withDatabaseName(urls.admin, name);
    const partial = await mkdtemp(join(tmpdir(), 'bookrail-migrations-'));
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
      await maintenance.query(`CREATE DATABASE ${name}`);

      // Everything **before** 0010, so that the database is in the state a deployment is in the
      // instant before that migration runs. Not "everything except 0010": later migrations
      // reference the table 0010 creates, so applying them first would fail for a reason that
      // has nothing to do with what this test is about.
      const files = await loadMigrations();
      for (const file of files.filter((f) => f.name < '0010')) {
        await writeFile(join(partial, file.name), file.sql, 'utf8');
      }
      await migrate({ adminUrl: target, appRole: urls.appRole, migrationsDir: partial });

      // The worker got there first.
      const db = new Client({ connectionString: target });
      await db.connect();
      try {
        await db.query('CREATE SCHEMA pgboss');
        await db.query('CREATE TABLE pgboss.job (id text primary key)');
        await db.query(`INSERT INTO pgboss.job (id) VALUES ('queued-before-the-migration')`);
      } finally {
        await db.end();
      }

      const result = await migrate({ adminUrl: target, appRole: urls.appRole });
      expect(result.applied[0]).toBe('0010_idempotency_keys.sql');

      const check = new Client({ connectionString: target });
      await check.connect();
      try {
        const jobs = await check.query<{ id: string }>('SELECT id FROM pgboss.job');
        expect(jobs.rows.map((r) => r.id)).toEqual(['queued-before-the-migration']);
        const table = await check.query(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'idempotency_keys'`,
        );
        expect(table.rowCount).toBe(1);
      } finally {
        await check.end();
      }
    } finally {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      await maintenance.end();
    }
  }, 120_000);

  /** The queue follows the reset, because that is where throwing it away belongs. */
  it('drops the pgboss schema on a schema reset', async () => {
    const urls = testUrls();
    const name = probeDb('pgboss_reset');
    const maintenance = new Client({ connectionString: withDatabaseName(urls.admin, 'postgres') });
    await maintenance.connect();
    const target = withDatabaseName(urls.admin, name);
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
      await maintenance.query(`CREATE DATABASE ${name}`);
      await migrate({ adminUrl: target, appRole: urls.appRole });

      const db = new Client({ connectionString: target });
      await db.connect();
      try {
        await db.query('CREATE TABLE pgboss.job (id text primary key)');
        await db.query(`INSERT INTO pgboss.job (id) VALUES ('stale')`);
      } finally {
        await db.end();
      }

      await resetSchema({ adminUrl: target, appRole: urls.appRole });

      const check = new Client({ connectionString: target });
      await check.connect();
      try {
        const leftovers = await check.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss'`,
        );
        expect(leftovers.rowCount).toBe(0);
      } finally {
        await check.end();
      }
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      await maintenance.end();
    }
  }, 120_000);

  it('survives two concurrent migrations of two different databases', async () => {
    const urls = testUrls();
    const names = [probeDb('concurrent_a'), probeDb('concurrent_b')];
    const maintenance = new Client({
      connectionString: withDatabaseName(urls.admin, 'postgres'),
    });
    await maintenance.connect();
    try {
      for (const name of names) {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
        await maintenance.query(`CREATE DATABASE ${name}`);
      }

      const outcomes = await Promise.allSettled(
        names.map((name) =>
          migrate({
            adminUrl: withDatabaseName(urls.admin, name),
            appRole: urls.appRole,
          }),
        ),
      );

      const failures = outcomes.filter((o) => o.status === 'rejected');
      expect(
        failures.map((f) => (f as PromiseRejectedResult).reason?.message ?? String(f)),
      ).toEqual([]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('fulfilled');
        if (outcome.status === 'fulfilled') {
          expect(outcome.value.applied.length + outcome.value.alreadyApplied.length).toBe(
            (await loadMigrations()).length,
          );
        }
      }
    } finally {
      for (const name of names) {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      }
      await maintenance.end();
    }
  }, 90_000);

  it('assigns the application role password when APP_DB_PASSWORD is set', async () => {
    const urls = testUrls();
    const name = probeDb('password');
    const maintenance = new Client({
      connectionString: withDatabaseName(urls.admin, 'postgres'),
    });
    await maintenance.connect();
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
      await maintenance.query(`CREATE DATABASE ${name}`);

      await migrate({
        adminUrl: withDatabaseName(urls.admin, name),
        appRole: urls.appRole,
        appPassword: "probe'password", // an apostrophe: the quoting must be done by Postgres
      });

      const { rows } = await maintenance.query<{ has_password: boolean }>(
        `SELECT rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname = $1`,
        [urls.appRole],
      );
      expect(rows[0]?.has_password, 'the CI cannot connect without a password').toBe(true);
    } finally {
      // Put the role back to password-less, which is what the local Postgres expects.
      await maintenance.query(`ALTER ROLE ${urls.appRole} PASSWORD NULL`).catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      await maintenance.end();
    }
  }, 60_000);
  describe('the migration ledger', () => {
    /**
     * The product was renamed in September 2026 and the ledger carried the old name. It cannot
     * be renamed by a migration, because it is the table that says which migrations are
     * applied: a runner that created an empty new one would replay 0001 against a full
     * database. The rename is an explicit command and nothing else does it,
     * so what is tested here is the whole triangle: `status` looks and does not touch,
     * `migrate` refuses, `adopt` renames once and is a no-op the second time.
     *
     * The fixture uses a third name on purpose: what is tested is "the ledger this database
     * has", not one particular former brand.
     */
    it('is left alone by db:status, refuses db:migrate, and is adopted once by db:adopt', async () => {
      const urls = testUrls();
      const name = probeDb('legacy_ledger');
      const maintenance = new Client({
        connectionString: withDatabaseName(urls.admin, 'postgres'),
      });
      await maintenance.connect();
      try {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
        await maintenance.query(`CREATE DATABASE ${name}`);
        const target = withDatabaseName(urls.admin, name);

        await migrate({ adminUrl: target, appRole: urls.appRole, jobsRole: urls.jobsRole });

        const probe = new Client({ connectionString: target });
        await probe.connect();
        try {
          const applied = await probe.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM _bookrail_migrations',
          );
          const before = Number(applied.rows[0]!.n);
          expect(before).toBeGreaterThan(0);

          // Put the ledger back under a former name, index included, as an old database has it.
          await probe.query('ALTER TABLE _bookrail_migrations RENAME TO _legacy_migrations');
          await probe.query(
            'ALTER INDEX _bookrail_migrations_pkey RENAME TO _legacy_migrations_pkey',
          );

          const ledgerNames = async (): Promise<string[]> => {
            const { rows } = await probe.query<{ relname: string }>(
              `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r'
                  AND c.relname ~ '^_[a-z0-9]+_migrations$'
                ORDER BY c.relname`,
            );
            return rows.map((r) => r.relname);
          };

          // 1. A read stays a read. It says what it found and renames nothing.
          const report = await migrationReport({ adminUrl: target, appRole: urls.appRole });
          expect(report.ledger).toEqual({ kind: 'legacy', table: '_legacy_migrations' });
          expect(report.statuses.every((s) => !s.applied)).toBe(true);
          expect(await ledgerNames()).toEqual(['_legacy_migrations']);

          // 2. A migration refuses rather than starting an empty ledger on a full database.
          await expect(
            migrate({ adminUrl: target, appRole: urls.appRole, jobsRole: urls.jobsRole }),
          ).rejects.toThrow(/db:adopt/);
          expect(await ledgerNames()).toEqual(['_legacy_migrations']);

          // 3. The dry run says what it would do and changes nothing.
          const planned = await adoptLedger({ adminUrl: target, dryRun: true });
          expect(planned).toMatchObject({
            action: 'renamed',
            from: '_legacy_migrations',
            to: '_bookrail_migrations',
            dryRun: true,
          });
          expect(await ledgerNames()).toEqual(['_legacy_migrations']);

          // 4. The real thing, once.
          const adopted = await adoptLedger({ adminUrl: target });
          expect(adopted).toMatchObject({ action: 'renamed', from: '_legacy_migrations' });
          expect(await ledgerNames()).toEqual(['_bookrail_migrations']);

          const index = await probe.query<{ relname: string }>(
            `SELECT i.relname FROM pg_index x
               JOIN pg_class i ON i.oid = x.indexrelid
              WHERE x.indrelid = 'public._bookrail_migrations'::regclass AND x.indisprimary`,
          );
          expect(index.rows[0]?.relname).toBe('_bookrail_migrations_pkey');

          // 5. And the second time it is a no-op.
          expect(await adoptLedger({ adminUrl: target })).toMatchObject({
            action: 'already-current',
          });

          // The ledger kept every row: the migrations are still applied, not replayed.
          const second = await migrate({
            adminUrl: target,
            appRole: urls.appRole,
            jobsRole: urls.jobsRole,
          });
          expect(second.applied).toEqual([]);
          expect(second.alreadyApplied.length).toBe(before);
        } finally {
          await probe.end();
        }
      } finally {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
        await maintenance.end();
      }
    }, 120_000);

    it('reports a database with no ledger as empty, and creates nothing to say so', async () => {
      const urls = testUrls();
      const name = probeDb('empty_ledger');
      const maintenance = new Client({
        connectionString: withDatabaseName(urls.admin, 'postgres'),
      });
      await maintenance.connect();
      try {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
        await maintenance.query(`CREATE DATABASE ${name}`);
        const target = withDatabaseName(urls.admin, name);

        const report = await migrationReport({ adminUrl: target, appRole: urls.appRole });
        expect(report.ledger).toEqual({ kind: 'missing' });
        expect(report.statuses.every((s) => !s.applied)).toBe(true);
        expect(await adoptLedger({ adminUrl: target, dryRun: true })).toMatchObject({
          action: 'no-ledger',
        });

        const probe = new Client({ connectionString: target });
        await probe.connect();
        try {
          const { rows } = await probe.query(
            `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname ~ '^_[a-z0-9]+_migrations$'`,
          );
          expect(rows).toHaveLength(0);
        } finally {
          await probe.end();
        }
      } finally {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
        await maintenance.end();
      }
    }, 90_000);
  });

  /**
   * Migration 0018 took an ACCESS EXCLUSIVE lock on every table of a live job queue with no
   * timeout at all: a release could wait
   * behind the old worker's connection for as long as nobody noticed, inside a transaction
   * holding an advisory lock. Every migration now runs under `SET LOCAL lock_timeout`.
   */
  describe('the migration lock timeout', () => {
    it('gives up inside the timeout and leaves the ledger consistent', async () => {
      const urls = testUrls();
      const name = probeDb('lock_timeout');
      const maintenance = new Client({
        connectionString: withDatabaseName(urls.admin, 'postgres'),
      });
      await maintenance.connect();
      const target = withDatabaseName(urls.admin, name);
      const dir = await mkdtemp(join(tmpdir(), 'bookrail-locktimeout-'));
      let blocker: Client | undefined;
      try {
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
        await maintenance.query(`CREATE DATABASE ${name}`);

        // Two files: one that creates a table, one that needs an ACCESS EXCLUSIVE lock on it.
        await writeFile(
          join(dir, '0001_table.sql'),
          'CREATE TABLE lock_probe (id int PRIMARY KEY);\n',
          'utf8',
        );
        await writeFile(
          join(dir, '0002_alter.sql'),
          'ALTER TABLE lock_probe ADD COLUMN note text;\n',
          'utf8',
        );
        await migrate({ adminUrl: target, migrationsDir: dir, appRole: urls.appRole });

        // Something else holds the table: exactly the shape of a worker polling its queue.
        blocker = new Client({ connectionString: target });
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE');

        await writeFile(
          join(dir, '0003_blocked.sql'),
          'ALTER TABLE lock_probe ADD COLUMN blocked text;\n',
          'utf8',
        );

        const started = Date.now();
        await expect(
          migrate({
            adminUrl: target,
            migrationsDir: dir,
            appRole: urls.appRole,
            lockTimeout: '400ms',
          }),
        ).rejects.toThrow(/gave up waiting for a lock after 400ms/);
        const elapsed = Date.now() - started;
        // Once, not ten times: a lock timeout past the advisory lock is not a runner race.
        expect(elapsed).toBeLessThan(10_000);

        await blocker.query('ROLLBACK');

        // The ledger did not record the migration that failed, and the column is not there.
        const probe = new Client({ connectionString: target });
        await probe.connect();
        try {
          const { rows } = await probe.query<{ name: string }>(
            'SELECT name FROM _bookrail_migrations ORDER BY name',
          );
          expect(rows.map((r) => r.name)).toEqual(['0001_table.sql', '0002_alter.sql']);
          const { rows: columns } = await probe.query<{ attname: string }>(
            `SELECT attname FROM pg_attribute
              WHERE attrelid = 'lock_probe'::regclass AND attnum > 0 AND NOT attisdropped
              ORDER BY attnum`,
          );
          expect(columns.map((c) => c.attname)).toEqual(['id', 'note']);
        } finally {
          await probe.end();
        }

        // And with the blocker gone the very same run succeeds.
        const after = await migrate({
          adminUrl: target,
          migrationsDir: dir,
          appRole: urls.appRole,
          lockTimeout: '400ms',
        });
        expect(after.applied).toEqual(['0003_blocked.sql']);
      } finally {
        await blocker?.end().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
        await maintenance.end();
      }
    }, 120_000);

    it('refuses a lock timeout that is not a Postgres duration', async () => {
      const urls = testUrls();
      await expect(
        migrate({ adminUrl: urls.admin, appRole: urls.appRole, lockTimeout: "5s'; DROP TABLE x" }),
      ).rejects.toThrow(/Invalid lock timeout/);
    });
  });

  describe('the job queue role', () => {
    it('owns the pgboss schema, can log in, and bypasses nothing', async () => {
      const { jobsRole } = testUrls();
      const { rows } = await admin.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>('SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1', [jobsRole]);
      expect(rows[0], `${jobsRole} does not exist`).toBeDefined();
      expect(rows[0]?.rolsuper).toBe(false);
      expect(rows[0]?.rolbypassrls).toBe(false);
      expect(rows[0]?.rolcanlogin).toBe(true);

      const owner = await admin.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'`,
      );
      expect(owner.rows[0]?.owner).toBe(jobsRole);
    });

    it('is not the application role, and has no privilege on any project table', async () => {
      const { appRole, jobsRole } = testUrls();
      expect(jobsRole).not.toBe(appRole);
      for (const table of PROJECT_TABLES) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const { rows } = await admin.query<{ has: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS has',
            [jobsRole, table, privilege],
          );
          expect(rows[0]?.has, `${jobsRole} should not ${privilege} ${table}`).toBe(false);
        }
      }
    });

    it('can create in pgboss, which is what pg-boss does at start-up', async () => {
      // Both halves matter: owning the schema, and CREATE on the database, which pg-boss needs
      // for its `CREATE SCHEMA IF NOT EXISTS pgboss` on a database where it is not installed
      // (migration 0019). Postgres checks that privilege before evaluating IF NOT EXISTS.
      const urls = testUrls();
      const asJobs = new Client({
        connectionString: deriveAppUrl(urls.admin, urls.jobsRole, process.env.JOBS_DB_PASSWORD),
      });
      await asJobs.connect();
      try {
        await asJobs.query('CREATE SCHEMA IF NOT EXISTS pgboss');
        await asJobs.query('CREATE TABLE IF NOT EXISTS pgboss.probe (id int PRIMARY KEY)');
        await asJobs.query('DROP TABLE pgboss.probe');
        await expect(asJobs.query('SELECT count(*) FROM bookings')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await asJobs.end();
      }
    });
  });
});
