import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { LIVE_ONLY_TABLES, PROJECT_TABLES } from '../src/schema/index.js';
import { adminClient, appClient, asProject, expectPgError } from './helpers.js';
import { createProject, seedProjectData, type SeededRows } from './fixtures.js';

/**
 * The ids a scope should see in a table: the one seeded row, or none at all for a live-only
 * table in the test environment, where a row cannot exist.
 */
function expectedRows(rows: SeededRows, table: string): string[] {
  const id = rows[table];
  if (id === undefined) {
    expect((LIVE_ONLY_TABLES as readonly string[]).includes(table), `${table} was not seeded`).toBe(
      true,
    );
    return [];
  }
  return [id];
}

/**
 * The point of these tests is that they run as `bookrail_app`, a role without BYPASSRLS.
 * If the role were a superuser every assertion below would pass while proving nothing, so the
 * first test asserts the role's attributes before anything else.
 */
/** Definer functions that only their owner may execute (migration 0027). */
const OWNER_ONLY_DEFINERS = new Set(['billing_write_plan_changed']);

describe('row level security', () => {
  let admin: Client;
  let app: Client;
  let projectA: string;
  let projectB: string;
  let accountA: string;
  let accountB: string;
  let rowsATest: SeededRows;
  let rowsALive: SeededRows;
  let rowsBTest: SeededRows;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();

    const seededA = await createProject(admin, 'Project A');
    const seededB = await createProject(admin, 'Project B');
    projectA = seededA.projectId;
    projectB = seededB.projectId;
    accountA = seededA.accountId;
    accountB = seededB.accountId;

    rowsATest = await seedProjectData(admin, projectA, 'test');
    rowsALive = await seedProjectData(admin, projectA, 'live');
    rowsBTest = await seedProjectData(admin, projectB, 'test');
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('runs as a role that cannot bypass RLS', async () => {
    const { rows } = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('sees nothing at all when no context is set', async () => {
    for (const table of PROJECT_TABLES) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*)::text FROM ${table}`);
      expect(rows[0]?.count, `${table} leaked rows without an RLS context`).toBe('0');
    }
  });

  it('sees only its own project and environment, table by table', async () => {
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      for (const table of PROJECT_TABLES) {
        const { rows } = await app.query<{ id: string }>(`SELECT id FROM ${table}`);
        expect(
          rows.map((r) => r.id),
          `${table} visibility`,
        ).toEqual(expectedRows(rowsATest, table));
      }
    });
  });

  it('isolates the two environments of the same project', async () => {
    await asProject(app, { projectId: projectA, environment: 'live' }, async () => {
      for (const table of PROJECT_TABLES) {
        const { rows } = await app.query<{ id: string }>(`SELECT id FROM ${table}`);
        expect(
          rows.map((r) => r.id),
          `${table} environment isolation`,
        ).toEqual(expectedRows(rowsALive, table));
      }
    });
  });

  it('cannot update or delete rows of another project', async () => {
    // events is append-only: UPDATE and DELETE are revoked outright, covered by events.test.ts.
    // The live-only tables have no row in project B's test environment to aim at; that a
    // project cannot reach another project's plan counter is `plan-usage.test.ts`.
    const mutable = PROJECT_TABLES.filter((t) => t !== 'events' && rowsBTest[t] !== undefined);
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      for (const table of mutable) {
        const foreignId = rowsBTest[table];
        // `SET project_id = project_id` rather than `SET updated_at = now()`: every project
        // table has a `project_id` and not all of them have an `updated_at`
        // (`stripe_oauth_states` is written once and deleted, never updated). The statement
        // changes nothing, which is the point: what is being measured is whether the row was
        // reachable at all, and `rowCount` answers that whatever the assignment was.
        const updated = await app.query(
          `UPDATE ${table} SET project_id = project_id WHERE id = $1 RETURNING id`,
          [foreignId],
        );
        expect(updated.rowCount, `${table}: updated a row of another project`).toBe(0);
      }
    });

    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      // Delete in reverse dependency order so that a successful (i.e. failing) test is not
      // masked by a foreign key error.
      for (const table of [...mutable].reverse()) {
        const foreignId = rowsBTest[table];
        const deleted = await app.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [
          foreignId,
        ]);
        expect(deleted.rowCount, `${table}: deleted a row of another project`).toBe(0);
      }
    });

    // The foreign rows are all still there.
    for (const table of PROJECT_TABLES.filter((t) => rowsBTest[t] !== undefined)) {
      const { rows } = await admin.query(`SELECT id FROM ${table} WHERE id = $1`, [
        rowsBTest[table],
      ]);
      expect(rows, `${table}: row of project B disappeared`).toHaveLength(1);
    }
  });

  it('refuses an insert that claims another project (WITH CHECK)', async () => {
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectA],
    );
    const failure = await expectPgError(
      app.query(
        `INSERT INTO locations (id, project_id, environment, name, timezone)
         VALUES ($1, $2, 'test', 'Sneaky', 'UTC')`,
        [uuidv7(), projectB],
      ),
    );
    expect(failure.code).toBe('42501');
    expect(failure.message).toMatch(/row-level security/i);
    await app.query('ROLLBACK');
  });

  it('refuses an insert that claims the other environment (WITH CHECK)', async () => {
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', 'test', true)`,
      [projectA],
    );
    const failure = await expectPgError(
      app.query(
        `INSERT INTO locations (id, project_id, environment, name, timezone)
         VALUES ($1, $2, 'live', 'Wrong env', 'UTC')`,
        [uuidv7(), projectA],
      ),
    );
    expect(failure.code).toBe('42501');
    await app.query('ROLLBACK');
  });

  it('cannot read another project through a join it controls', async () => {
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*)::text FROM bookings b JOIN customers c ON c.id = b.customer_id`,
      );
      expect(rows[0]?.count).toBe('1');
      const foreign = await app.query(`SELECT id FROM bookings WHERE id = $1`, [
        rowsBTest.bookings,
      ]);
      expect(foreign.rowCount).toBe(0);
    });
  });

  it('resets the context when the transaction ends', async () => {
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const { rows } = await app.query<{ v: string | null }>(
        `SELECT current_setting('app.project_id', true) AS v`,
      );
      expect(rows[0]?.v).toBe(projectA);
    });
    const { rows } = await app.query<{ v: string | null }>(
      `SELECT current_setting('app.project_id', true) AS v`,
    );
    expect(rows[0]?.v ?? '').toBe('');
  });

  /**
   * Migration 0013 replaced the `api_keys_auth_lookup` policy (which granted the whole table
   * to an empty context) with `auth_lookup_api_key`, a `SECURITY DEFINER` function that returns
   * one row or none. The failure mode of an empty context on `api_keys` is now "sees nothing",
   * like on every other table, which is the whole point of the change.
   */
  it('shows no api_keys at all to an empty context, and only its own inside one', async () => {
    const keyA = uuidv7();
    const keyB = uuidv7();
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, prefix, key_hash)
       VALUES ($1, $2, 'test', 'aaaaaaaa', repeat('a', 64)),
              ($3, $4, 'test', 'bbbbbbbb', repeat('b', 64))`,
      [keyA, projectA, keyB, projectB],
    );

    const anonymous = await app.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE id IN ($1, $2) ORDER BY id`,
      [keyA, keyB],
    );
    expect(anonymous.rows).toHaveLength(0);

    // With a project selected, only that project's keys remain visible.
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const scoped = await app.query<{ id: string }>(
        `SELECT id FROM api_keys WHERE id IN ($1, $2)`,
        [keyA, keyB],
      );
      expect(scoped.rows.map((r) => r.id)).toEqual([keyA]);

      const updated = await app.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [
        keyB,
      ]);
      expect(updated.rowCount).toBe(0);
    });
  });

  it('resolves exactly one api key through auth_lookup_api_key, and nothing else', async () => {
    const keyA = uuidv7();
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, prefix, key_hash, scopes, tenant_id)
       VALUES ($1, $2, 'test', 'cccccccc', repeat('c', 64), '{read}'::text[], 'tenant-7')`,
      [keyA, projectA],
    );

    const found = await app.query<{
      id: string;
      project_id: string;
      environment: string;
      scopes: string[];
      tenant_id: string | null;
      revoked_at: string | null;
    }>(`SELECT * FROM auth_lookup_api_key($1, $2)`, ['c'.repeat(64), 'cccccccc']);
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.id).toBe(keyA);
    expect(found.rows[0]?.project_id).toBe(projectA);
    expect(found.rows[0]?.scopes).toEqual(['read']);
    expect(found.rows[0]?.tenant_id).toBe('tenant-7');
    expect(found.rows[0]?.revoked_at).toBeNull();

    // An unknown hash is zero rows, not an error and not somebody else's key.
    const missing = await app.query(`SELECT * FROM auth_lookup_api_key($1, $2)`, [
      'd'.repeat(64),
      'dddddddd',
    ]);
    expect(missing.rowCount).toBe(0);

    // The right hash under the wrong prefix resolves to nothing either.
    const mismatched = await app.query(`SELECT * FROM auth_lookup_api_key($1, $2)`, [
      'c'.repeat(64),
      'eeeeeeee',
    ]);
    expect(mismatched.rowCount).toBe(0);
  });

  /**
   * Every `SECURITY DEFINER` function in the schema runs with the privileges of the role that
   * created it, so the properties below are the whole of its safety and none of them is visible
   * from the call site: a fixed `search_path` (a caller cannot shadow a table or an operator and
   * have it run elevated), `EXECUTE` taken away from `PUBLIC`, and `EXECUTE` given to the
   * application role, or, for the two functions nobody may call by hand, to nobody at all.
   *
   * The test enumerates `pg_proc` rather than a list of names on purpose: a definer function
   * added by a later migration without its grants is exactly the mistake worth catching, and a
   * hand-written list would not catch it.
   */
  it('pins the search_path and the grants of every SECURITY DEFINER function', async () => {
    const { rows } = await admin.query<{
      name: string;
      kind: string;
      config: string[] | null;
      acl: string | null;
      owner: string;
    }>(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
             CASE WHEN p.prorettype = 'trigger'::regtype THEN 'trigger' ELSE 'callable' END AS kind,
             p.proconfig AS config,
             array_to_string(p.proacl, ',') AS acl,
             pg_get_userbyid(p.proowner) AS owner
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
       ORDER BY 1
    `);
    // Migrations 0013, 0014, 0015 and 0016. If this is ever zero the query is wrong, not the
    // schema.
    expect(rows.length).toBeGreaterThanOrEqual(9);

    const appRole = process.env.APP_DB_ROLE ?? 'bookrail_app';
    for (const row of rows) {
      expect(row.config, `${row.name} has no search_path pinned`).toContain(
        'search_path=public, pg_temp',
      );
      // A null ACL means the default, which is EXECUTE to PUBLIC: for a definer function that
      // is the one thing it must never be.
      expect(row.acl, `${row.name} still carries the default ACL`).not.toBeNull();
      expect(row.acl, `${row.name} is executable by PUBLIC`).not.toMatch(/(^|,)=X/);
      expect(row.owner, `${row.name} is not owned by the migration role`).not.toBe(appRole);

      if (row.kind === 'trigger' || OWNER_ONLY_DEFINERS.has(row.name.split('(')[0] ?? '')) {
        // A trigger function is called by its trigger and by nothing else (Postgres refuses a
        // direct call outright), so granting it would say something untrue about who may run
        // it. The writer of the `plan.changed` events (migration 0027) is called by the other
        // definer functions and by the owner connection of `bookrail-plan`, never by the
        // application role: it writes into the log of every project of an account.
        expect(row.acl, `${row.name} is granted to ${appRole}`).not.toContain(`${appRole}=X`);
      } else {
        expect(row.acl, `${row.name} is not executable by ${appRole}`).toContain(`${appRole}=X`);
      }
    }
  });

  /**
   * The hole migration 0016 closed, kept closed by a test.
   *
   * `occupancies_over_capacity` measures a resource against its capacity, and migration 0014 both
   * elevated it and granted it to the application role. The elevation was right (under Row Level
   * Security the `&&` of the join is not leakproof, so the policy predicate runs first and the
   * GiST index leaves the plan), but the grant meant a request could pass the id of somebody
   * else's resource and get back a resource id, a peak and a capacity. The elevation now lives in
   * the trigger function, whose arguments are `NEW.resource_id` and nothing else.
   */
  it('does not let the application role measure a resource of its own choosing', async () => {
    await expect(
      app.query(
        `SELECT * FROM occupancies_over_capacity(ARRAY[$1::uuid],
                                                 ARRAY['[2031-01-01,2031-01-02)'::tstzrange])`,
        [projectB],
      ),
    ).rejects.toThrow(/permission denied for function occupancies_over_capacity/);

    // The two definer functions the worker really does call stay callable.
    await expect(app.query(`SELECT * FROM capacity_violations(10)`)).resolves.toBeDefined();
    await expect(app.query(`SELECT capacity_scan_size()`)).resolves.toBeDefined();
  });

  /**
   * Every table a request can reach carries Row Level Security. Until migration 0013
   * `accounts` and `projects` were the exception to that rule.
   */
  it('shows the application role only its own project and account', async () => {
    const empty = await app.query<{ id: string }>(`SELECT id FROM projects`);
    expect(empty.rows).toHaveLength(0);
    const emptyAccounts = await app.query<{ id: string }>(`SELECT id FROM accounts`);
    expect(emptyAccounts.rows).toHaveLength(0);

    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const projectRows = await app.query<{ id: string }>(`SELECT id FROM projects`);
      expect(projectRows.rows.map((r) => r.id)).toEqual([projectA]);

      const accountRows = await app.query<{ id: string }>(`SELECT id FROM accounts`);
      expect(accountRows.rows.map((r) => r.id)).toEqual([accountA]);
    });

    await asProject(app, { projectId: projectB, environment: 'test' }, async () => {
      const projectRows = await app.query<{ id: string }>(`SELECT id FROM projects`);
      expect(projectRows.rows.map((r) => r.id)).toEqual([projectB]);

      const accountRows = await app.query<{ id: string }>(`SELECT id FROM accounts`);
      expect(accountRows.rows.map((r) => r.id)).toEqual([accountB]);
    });
  });
});
