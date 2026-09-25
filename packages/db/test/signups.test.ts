/**
 * The sign up table, from the point of view of the role that serves HTTP.
 *
 * `signups` is the one table in this schema with row security enabled, forced, and **no policy
 * at all**. That is not an oversight: a sign up belongs to no project, because it exists
 * precisely before there is one, so there is no context to key a policy on. The consequence has
 * to be measured rather than argued, which is what the first two tests do: with rows in the
 * table the application role counts zero, and every statement it tries is refused.
 *
 * The rest of the file checks the four functions that are the only way in: who owns them, that
 * their `search_path` is fixed, and who may execute them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, expectPgError, testUrls } from './helpers.js';

const SIGNUP_FUNCTIONS = [
  'signup_start',
  'signup_confirm',
  'signup_claim',
  'signups_purge',
] as const;

/** Sixty-four hex characters, which is the shape every hash column here checks for. */
function hash(seed: string): string {
  return seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');
}

describe('the sign up table', () => {
  let admin: Client;
  let app: Client;
  let signupId: string;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    signupId = uuidv7();
    await admin.query(
      `SELECT signup_start($1, $2, $3, $4, 'cli', $5, 'Acme', 'Default',
                                           'Europe/Rome', 'EUR')`,
      [signupId, `rls-${signupId}@example.com`, hash('a'), hash('b'), hash('c')],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM signups WHERE id = $1', [signupId]);
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

  it('has row security enabled and forced, and no policy at all', async () => {
    const { rows } = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = 'signups'`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);

    const { rows: policies } = await admin.query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signups'`,
    );
    expect(policies).toEqual([]);
  });

  /**
   * With a row sitting right there, the application role cannot count it.
   *
   * The answer is a permission error rather than a count of zero, and that is the stronger of
   * the two: zero rows would mean the role may read the table and finds nothing, while this
   * means it may not read the table at all. Both are acceptable answers to the same question
   * (`infra` says so too, where the release gate asks it), and this schema gives the stricter
   * one because the table carries no grant.
   */
  it('lets the application role see nothing at all, with a row sitting right there', async () => {
    const { rows: really } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM signups WHERE id = $1',
      [signupId],
    );
    expect(really[0]?.n).toBe('1');

    const counted = await expectPgError(app.query('SELECT count(*)::text AS n FROM signups'));
    expect(counted.code).toBe('42501');
  });

  it('refuses every statement the application role could try', async () => {
    for (const statement of [
      [
        `INSERT INTO signups (id, email, token_hash, client, ip_hash, account_name, project_name,
                              default_timezone, default_currency, status, expires_at)
         VALUES ($1, 'x@example.com', $2, 'web', $3, 'A', 'B', 'UTC', 'EUR', 'pending',
                 now() + interval '1 hour')`,
        [uuidv7(), hash('d'), hash('e')],
      ],
      [`UPDATE signups SET status = 'claimed'`, []],
      ['DELETE FROM signups', []],
      ['SELECT email FROM signups', []],
    ] as const) {
      const failure = await expectPgError(app.query(statement[0], [...statement[1]]));
      expect(failure.code, statement[0].slice(0, 24)).toBe('42501');
    }
  });

  it('grants the application role nothing on the table itself', async () => {
    const { appRole } = testUrls();
    const { rows } = await admin.query<{ p: string; has: boolean }>(
      `SELECT p, has_table_privilege($1, 'signups', p) AS has
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`,
      [appRole],
    );
    for (const row of rows) {
      expect(row.has, `${appRole} should not ${row.p} signups`).toBe(false);
    }
  });

  it('gives the job role nothing either', async () => {
    const { jobsRole } = testUrls();
    const { rows } = await admin.query<{ has: boolean }>(
      `SELECT has_table_privilege($1, 'signups', 'SELECT') AS has`,
      [jobsRole],
    );
    expect(rows[0]?.has).toBe(false);
  });
});

/**
 * The ceilings of `signup_start`, under concurrency. Twenty requests for one address at the same
 * instant, from twenty callers: the count and the insert run under two advisory locks (migration
 * 0026), so exactly three get in, which is the ceiling for an address. Without the locks every
 * request reads the same count.
 */
describe('the ceilings of a sign up, under concurrency', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await adminClient();
  });

  afterAll(async () => {
    await admin.end();
  });

  it('lets exactly three of twenty simultaneous requests for one address through', async () => {
    const email = `race-${uuidv7()}@example.com`;
    const clients = await Promise.all(Array.from({ length: 20 }, () => appClient()));
    try {
      const outcomes = await Promise.allSettled(
        clients.map((client, index) =>
          client.query(
            `SELECT * FROM signup_start($1, $2, $3, NULL, 'web', $4, 'Race', 'Default',
                                         'UTC', 'EUR')`,
            [uuidv7(), email, hash(`${uuidv7()}${String(index)}`), hash(uuidv7())],
          ),
        ),
      );
      const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === 'P0429',
      );
      expect(accepted).toHaveLength(3);
      expect(refused).toHaveLength(17);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM signups WHERE email = $1',
      [email],
    );
    expect(rows[0]?.n).toBe('3');
  });

  /**
   * The same property with the interleaving forced rather than hoped for: the third request is
   * inserted and left uncommitted, and a fourth starts meanwhile. With the locks the fourth waits
   * for the third (the test sees it waiting on an advisory lock), then counts three and is refused.
   * Without them it counts two, because the third is not committed, and gets in: four rows.
   */
  it('makes a request wait for one in flight for the same address, then refuses it', async () => {
    const email = `race-held-${uuidv7()}@example.com`;
    const start = (client: Client): Promise<unknown> =>
      client.query(
        `SELECT * FROM signup_start($1, $2, $3, NULL, 'web', $4, 'Race', 'Default', 'UTC', 'EUR')`,
        [uuidv7(), email, hash(uuidv7()), hash(uuidv7())],
      );
    const [first, second, third, fourth] = await Promise.all(
      Array.from({ length: 4 }, () => appClient()),
    );
    try {
      await start(first!);
      await start(second!);
      await third!.query('BEGIN');
      await start(third!);
      const pid = (await fourth!.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      let settled = false;
      const outcome = start(fourth!).then(
        () => 'accepted',
        (error: { code?: string }) => error.code ?? 'error',
      );
      void outcome.then(() => {
        settled = true;
      });
      // Either the fourth is seen waiting on a lock, or it has already finished without waiting.
      for (;;) {
        const { rows } = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks WHERE pid = $1 AND NOT granted`,
          [pid],
        );
        if (rows[0]?.n !== '0' || settled) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await third!.query('COMMIT');
      expect(await outcome).toBe('P0429');
    } finally {
      await Promise.all([first, second, third, fourth].map((client) => client!.end()));
    }
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM signups WHERE email = $1',
      [email],
    );
    expect(rows[0]?.n).toBe('3');
  });
});

describe('the four functions that are the only way in', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await adminClient();
  });

  afterAll(async () => {
    await admin.end();
  });

  it('are SECURITY DEFINER, owned by the migration role, with a fixed search path', async () => {
    const { rows } = await admin.query<{
      name: string;
      owner: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)
        ORDER BY p.proname`,
      [[...SIGNUP_FUNCTIONS]],
    );
    // `signup_confirm` twice: the two-key one of migration 0026, and the one-key one of 0021 that
    // 0026 keeps for the previous release until a later migration removes it. `signup_start`
    // twice as well: the one that carries the acceptance of the terms (migration 0027), and the
    // one of 0026 kept for the same reason.
    expect(rows.map((row) => row.name).sort()).toEqual(
      [...SIGNUP_FUNCTIONS, 'signup_confirm', 'signup_start'].sort(),
    );

    const { rows: who } = await admin.query<{ role: string }>('SELECT current_user AS role');
    for (const row of rows) {
      expect(row.prosecdef, `${row.name} is not SECURITY DEFINER`).toBe(true);
      expect(row.owner, `${row.name} is owned by somebody else`).toBe(who[0]?.role);
      // The exact value, not merely that one is set: a function pinned to a schema somebody
      // else can write to would pass a test that only asked whether a `search_path` exists.
      expect(row.proconfig ?? [], `${row.name} does not pin its search_path`).toContain(
        'search_path=public, pg_temp',
      );
    }
  });

  it('may be executed by the application role and by nobody else', async () => {
    const { appRole, jobsRole } = testUrls();
    const { rows } = await admin.query<{ signature: string; acl: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS signature, p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [[...SIGNUP_FUNCTIONS]],
    );
    expect(rows).toHaveLength(SIGNUP_FUNCTIONS.length + 2);
    for (const row of rows) {
      const acl = (row.acl ?? []).join(',');
      expect(acl, `${row.signature} is executable by PUBLIC`).not.toMatch(/(^|,)=X/);
      expect(acl, `${row.signature} is not granted to ${appRole}`).toContain(`${appRole}=X`);
      expect(acl, `${row.signature} is granted to ${jobsRole}`).not.toContain(`${jobsRole}=X`);
    }
  });
});
