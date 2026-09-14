/**
 * The three reads of the daily usage digest (migration 0022), from the point of view of the
 * role that runs the worker.
 *
 * The whole design rests on one asymmetry, and it is the asymmetry these tests measure: the
 * application role, with an empty context, can read **nothing** out of `accounts`, `api_keys`
 * and `signups`, and can still get exactly the rows the digest prints out of
 * `usage_digest_signups`, `usage_digest_keys` and `usage_digest_accounts`. If the first half
 * ever stopped being true the second half would be pointless, so both are asserted here, in
 * that order, against the same rows.
 *
 * The rest of the file is the same four properties every `SECURITY DEFINER` function in this
 * schema carries: owner, `search_path`, `EXECUTE` revoked from `PUBLIC`, `EXECUTE` granted to
 * the application role and to nobody else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, testUrls } from './helpers.js';

const DIGEST_FUNCTIONS = [
  'usage_digest_signups',
  'usage_digest_keys',
  'usage_digest_accounts',
] as const;

/**
 * Sixty-four hex characters derived from an identifier.
 *
 * Derived and not a constant: `key_hash` is UNIQUE and this database is shared with every other
 * suite of this package, so a fixed `repeat('b', 64)` collides with the one `rls.test.ts`
 * writes. A uuid is thirty-two hex digits once its dashes are gone, which makes the value both
 * the right shape and unique to the row it belongs to.
 */
function hashFor(id: string): string {
  return id.replace(/-/g, '').repeat(3).slice(0, 64);
}

/** The same, backwards, for the second hash column of a row. */
function otherHashFor(id: string): string {
  return [...hashFor(id)].reverse().join('');
}

interface SignupSeed {
  id: string;
  email: string;
  status: string;
  client: string;
}

describe('the usage digest functions', () => {
  let admin: Client;
  let app: Client;

  const accountId = uuidv7();
  const projectId = uuidv7();
  const keyId = uuidv7();
  const ownerEmail = `digest-owner-${accountId}@example.com`;
  const accountName = `Digest account ${accountId.slice(-6)}`;
  const projectName = `Digest project ${projectId.slice(-6)}`;
  const claimed: SignupSeed = {
    id: uuidv7(),
    email: `digest-claimed-${accountId}@example.com`,
    status: 'claimed',
    client: 'web',
  };
  const taken: SignupSeed = {
    id: uuidv7(),
    email: `digest-taken-${accountId}@example.com`,
    status: 'email_taken',
    client: 'cli',
  };

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();

    await admin.query(
      `INSERT INTO accounts (id, name, api_version, origin, owner_email)
       VALUES ($1, $2, '2026-09-01', 'self_serve', $3)`,
      [accountId, accountName, ownerEmail],
    );
    await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)`, [
      projectId,
      accountId,
      projectName,
    ]);
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash,
                             last_used_at)
       VALUES ($1, $2, 'test', 'secret', 'digest key', $3, $4, now() - interval '2 hours')`,
      [keyId, projectId, keyId.slice(-8), hashFor(keyId)],
    );
    for (const seed of [claimed, taken]) {
      await admin.query(
        `INSERT INTO signups (id, email, token_hash, poll_token_hash, client, ip_hash,
                              account_name, project_name, default_timezone, default_currency,
                              status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Europe/Rome', 'EUR', $9,
                 now() - interval '1 hour', now() + interval '1 hour')`,
        [
          seed.id,
          seed.email,
          hashFor(seed.id),
          seed.client === 'cli' ? otherHashFor(seed.id) : null,
          seed.client,
          hashFor(accountId),
          accountName,
          projectName,
          seed.status,
        ],
      );
    }
  });

  afterAll(async () => {
    await admin.query('DELETE FROM signups WHERE id = ANY($1)', [[claimed.id, taken.id]]);
    await admin.query('DELETE FROM api_keys WHERE id = $1', [keyId]);
    await admin.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await admin.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    await app.end();
    await admin.end();
  });

  it('runs the checks below as a role that cannot bypass row security', async () => {
    const { rows } = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  /**
   * The rows are there, and the application role cannot see one of them.
   *
   * `accounts`, `projects` and `api_keys` answer with zero rows (a policy keyed on
   * `app.project_id`, migration 0013); `signups` answers with a permission error, because it
   * carries no grant at all (migration 0021). Both are acceptable, and both are the failure
   * mode this design needs: never the whole table.
   */
  it('reads nothing at all directly, with the rows sitting right there', async () => {
    const { rows: really } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_keys WHERE id = $1`,
      [keyId],
    );
    expect(really[0]?.n).toBe('1');

    for (const table of ['accounts', 'api_keys']) {
      const { rows } = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(rows[0]?.n, `${table} leaked rows without a project context`).toBe('0');
    }

    let signupsAnswer: string | null = null;
    try {
      const { rows } = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM signups');
      signupsAnswer = rows[0]?.n ?? null;
    } catch (error) {
      expect((error as { code?: string }).code).toBe('42501');
      signupsAnswer = 'refused';
    }
    expect(signupsAnswer === 'refused' || signupsAnswer === '0').toBe(true);
  });

  it('gives the application role the sign ups, with the address only for a claimed one', async () => {
    const { rows } = await app.query<{
      created_at: Date;
      client: string;
      status: string;
      email: string | null;
      account_name: string;
      project_name: string;
    }>(`SELECT * FROM usage_digest_signups(now() - interval '24 hours') ORDER BY status`);

    const mine = rows.filter((row) => row.account_name === accountName);
    expect(mine.map((row) => row.status)).toEqual(['claimed', 'email_taken']);
    expect(mine[0]?.email).toBe(claimed.email);
    expect(mine[0]?.client).toBe('web');
    // The one that did not conclude: counted, dated, named by its status, and anonymous.
    expect(mine[1]?.email).toBeNull();
    expect(mine[1]?.client).toBe('cli');
    expect(mine[1]?.project_name).toBe(projectName);
  });

  it('leaves out a sign up older than the window', async () => {
    const { rows } = await app.query<{ account_name: string }>(
      `SELECT * FROM usage_digest_signups(now() + interval '1 minute')`,
    );
    expect(rows.filter((row) => row.account_name === accountName)).toEqual([]);
  });

  it('gives the application role the keys that were used, and no hash with them', async () => {
    const { rows } = await app.query<{
      account_name: string;
      account_origin: string;
      project_id: string;
      project_name: string;
      environment: string;
      kind: string;
      last_used_at: Date;
      created_at: Date;
    }>(`SELECT * FROM usage_digest_keys(now() - interval '7 days')`);

    const mine = rows.filter((row) => row.project_id === projectId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.account_name).toBe(accountName);
    expect(mine[0]?.account_origin).toBe('self_serve');
    expect(mine[0]?.environment).toBe('test');
    expect(mine[0]?.kind).toBe('secret');
    // The shape of the answer is the guarantee: there is no column here that could carry a
    // secret out, whatever the caller asks for. `owner_email` was in this list until the
    // independent review pointed out that the digest never printed it: a definer that hands out
    // an address nobody reads is privilege spent for nothing.
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual([
      'account_name',
      'account_origin',
      'created_at',
      'environment',
      'kind',
      'last_used_at',
      'project_id',
      'project_name',
    ]);
  });

  it('leaves out a revoked key and a key nobody used', async () => {
    const unused = uuidv7();
    const revoked = uuidv7();
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, kind, prefix, key_hash, last_used_at,
                             revoked_at)
       VALUES ($1, $2, 'test', 'secret', $3, $4, NULL, NULL),
              ($5, $2, 'live', 'secret', $6, $7, now(), now())`,
      [
        unused,
        projectId,
        unused.slice(-8),
        hashFor(unused),
        revoked,
        revoked.slice(-8),
        hashFor(revoked),
      ],
    );
    try {
      const { rows } = await app.query<{ project_id: string }>(
        `SELECT * FROM usage_digest_keys(now() - interval '7 days')`,
      );
      expect(rows.filter((row) => row.project_id === projectId)).toHaveLength(1);
    } finally {
      await admin.query('DELETE FROM api_keys WHERE id = ANY($1)', [[unused, revoked]]);
    }
  });

  it('gives the application role the new accounts, with how many projects each has', async () => {
    const { rows } = await app.query<{
      name: string;
      origin: string;
      owner_email: string | null;
      created_at: Date;
      projects: number;
    }>(`SELECT * FROM usage_digest_accounts(now() - interval '24 hours')`);

    const mine = rows.filter((row) => row.name === accountName);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.origin).toBe('self_serve');
    expect(mine[0]?.owner_email).toBe(ownerEmail);
    expect(Number(mine[0]?.projects)).toBe(1);
  });

  /**
   * The floor on `p_since`.
   *
   * The window ("the last 24 hours", "the last 7 days") is a convention of the caller, and the
   * caller is the role the process exposed to the internet talks to the database with. Without a
   * floor, `usage_digest_accounts('-infinity')` handed that role the whole address book: the
   * shape of the result is no defence, because the shape is exactly what a digest prints. The
   * clamp lives in the function, so no caller can widen it.
   */
  it('never looks further back than 31 days, whatever the caller asks for', async () => {
    const ancient = uuidv7();
    const ancientSignup = uuidv7();
    await admin.query(
      `INSERT INTO accounts (id, name, api_version, origin, owner_email, created_at)
       VALUES ($1, $2, '2026-09-01', 'self_serve', $3, now() - interval '200 days')`,
      [ancient, `Ancient ${ancient.slice(-6)}`, `ancient-${ancient}@example.com`],
    );
    await admin.query(
      `INSERT INTO signups (id, email, token_hash, client, ip_hash, account_name, project_name,
                            default_timezone, default_currency, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'web', $4, 'Ancient', 'Ancient', 'Europe/Rome', 'EUR', 'claimed',
               now() - interval '200 days', now() - interval '199 days')`,
      [
        ancientSignup,
        `ancient-signup-${ancientSignup}@example.com`,
        hashFor(ancientSignup),
        hashFor(ancient),
      ],
    );
    try {
      // Both rows really are in the tables.
      const { rows: reallyThere } = await admin.query<{ n: string }>(
        `SELECT (SELECT count(*)::text FROM accounts WHERE id = $1) || '/' ||
                (SELECT count(*)::text FROM signups WHERE id = $2) AS n`,
        [ancient, ancientSignup],
      );
      expect(reallyThere[0]?.n).toBe('1/1');

      // And neither is reachable through the functions, even asking for all of history.
      const accounts = await app.query<{ name: string }>(
        `SELECT * FROM usage_digest_accounts('-infinity')`,
      );
      expect(accounts.rows.some((row) => row.name.startsWith('Ancient '))).toBe(false);
      const signups = await app.query<{ account_name: string }>(
        `SELECT * FROM usage_digest_signups('-infinity')`,
      );
      expect(signups.rows.some((row) => row.account_name === 'Ancient')).toBe(false);

      // The rows inside the month are still there, so the floor clamps and does not empty.
      expect(accounts.rows.some((row) => row.name === accountName)).toBe(true);
    } finally {
      await admin.query('DELETE FROM signups WHERE id = $1', [ancientSignup]);
      await admin.query('DELETE FROM accounts WHERE id = $1', [ancient]);
    }
  });

  it('clamps the key window too', async () => {
    const old = uuidv7();
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, kind, prefix, key_hash, last_used_at)
       VALUES ($1, $2, 'live', 'secret', $3, $4, now() - interval '90 days')`,
      [old, projectId, old.slice(-8), hashFor(old)],
    );
    try {
      const { rows } = await app.query<{ environment: string; project_id: string }>(
        `SELECT * FROM usage_digest_keys('-infinity')`,
      );
      const mine = rows.filter((row) => row.project_id === projectId);
      expect(mine.map((row) => row.environment)).toEqual(['test']);
    } finally {
      await admin.query('DELETE FROM api_keys WHERE id = $1', [old]);
    }
  });

  it('are SECURITY DEFINER, owned by the migration role, with a fixed search path', async () => {
    const { rows } = await admin.query<{
      name: string;
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      provolatile: string;
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              p.provolatile
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)
        ORDER BY p.proname`,
      [[...DIGEST_FUNCTIONS]],
    );
    expect(rows.map((row) => row.name).sort()).toEqual([...DIGEST_FUNCTIONS].sort());

    const { rows: who } = await admin.query<{ role: string }>('SELECT current_user AS role');
    for (const row of rows) {
      expect(row.prosecdef, `${row.name} is not SECURITY DEFINER`).toBe(true);
      expect(row.owner, `${row.name} is owned by somebody else`).toBe(who[0]?.role);
      expect(row.proconfig ?? [], `${row.name} does not pin its search_path`).toContain(
        'search_path=public, pg_temp',
      );
      // `s` for STABLE: the digest reads, and a function that could write would be a wider
      // thing to reason about than the one this is.
      expect(row.provolatile, `${row.name} is not STABLE`).toBe('s');
    }
  });

  it('may be executed by the application role and by nobody else', async () => {
    const { appRole, jobsRole } = testUrls();
    const { rows } = await admin.query<{ signature: string; acl: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS signature, p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [[...DIGEST_FUNCTIONS]],
    );
    expect(rows).toHaveLength(DIGEST_FUNCTIONS.length);
    for (const row of rows) {
      const acl = (row.acl ?? []).join(',');
      expect(acl, `${row.signature} is executable by PUBLIC`).not.toMatch(/(^|,)=X/);
      expect(acl, `${row.signature} is not granted to ${appRole}`).toContain(`${appRole}=X`);
      expect(acl, `${row.signature} is granted to ${jobsRole}`).not.toContain(`${jobsRole}=X`);
    }
  });
});
