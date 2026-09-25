/**
 * The plan counter and the two functions around it (migration 0025), from the point of view of
 * the application role.
 *
 * Four things are measured here. `plan_usage` is an ordinary project table: another project and
 * an empty context see nothing, and the test environment cannot hold a row at all. The read
 * across projects sums the projects of one account and nothing else, and answers only for the
 * account of the request. The warning claim says "new" once and "already sent" after that. And
 * the three definer functions carry the four properties every definer function of this schema
 * carries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import {
  adminClient,
  appClient,
  asProject,
  beginAsProject,
  expectPgError,
  testUrls,
} from './helpers.js';
import { createProject, seedProjectData, type SeededProject } from './fixtures.js';

const PLAN_FUNCTIONS = [
  'auth_lookup_api_key',
  'plan_reserved_for_account',
  'plan_usage_for_account',
  'plan_usage_warning_claim',
] as const;

const MONTH = '2026-09';

describe('plan usage', () => {
  let admin: Client;
  let app: Client;
  let a: SeededProject;
  let b: SeededProject;
  /** A second project of account A: the threshold is the account's, not the project's. */
  let a2: string;

  async function count(
    projectId: string,
    month: string,
    bookings: number,
    volume: number,
    currency: string | null,
  ): Promise<string> {
    const id = uuidv7();
    await admin.query(
      `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed,
                               payment_volume, currency)
       VALUES ($1, $2, 'live', $3, $4, $5, $6)`,
      [id, projectId, month, bookings, volume, currency],
    );
    return id;
  }

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    a = await createProject(admin, 'Plan A');
    b = await createProject(admin, 'Plan B');
    a2 = uuidv7();
    await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Plan A two')`, [
      a2,
      a.accountId,
    ]);
    await count(a.projectId, MONTH, 7, 12_000, 'EUR');
    await count(a2, MONTH, 5, 3_000, 'EUR');
    await count(b.projectId, MONTH, 900, 50_000, 'EUR');
    // Another month of A, which the September sum must not include.
    await count(a.projectId, '2026-08', 400, 1, 'EUR');
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('sees nothing with no context, and nothing of another project', async () => {
    const empty = await app.query<{ n: string }>('SELECT count(*)::text AS n FROM plan_usage');
    expect(empty.rows[0]?.n).toBe('0');

    await asProject(app, { projectId: b.projectId, environment: 'live' }, async () => {
      const { rows } = await app.query<{ project_id: string }>('SELECT project_id FROM plan_usage');
      expect(rows.map((row) => row.project_id)).toEqual([b.projectId]);
      const updated = await app.query(
        `UPDATE plan_usage SET bookings_confirmed = 0 WHERE project_id = $1`,
        [a.projectId],
      );
      expect(updated.rowCount).toBe(0);
    });

    // The test environment of the same project sees no row: the counter is live only.
    await asProject(app, { projectId: a.projectId, environment: 'test' }, async () => {
      const { rows } = await app.query('SELECT id FROM plan_usage');
      expect(rows).toHaveLength(0);
    });
  });

  it('cannot hold a row of the test environment, a negative count or a bad month', async () => {
    const test = await expectPgError(
      admin.query(
        `INSERT INTO plan_usage (id, project_id, environment, month) VALUES ($1, $2, 'test', $3)`,
        [uuidv7(), a.projectId, '2026-10'],
      ),
    );
    expect(test.code).toBe('23514');
    const negative = await expectPgError(
      admin.query(
        `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
         VALUES ($1, $2, 'live', '2026-11', -1)`,
        [uuidv7(), a.projectId],
      ),
    );
    expect(negative.code).toBe('23514');
    const month = await expectPgError(
      admin.query(
        `INSERT INTO plan_usage (id, project_id, environment, month) VALUES ($1, $2, 'live', '2026-13')`,
        [uuidv7(), a.projectId],
      ),
    );
    expect(month.code).toBe('23514');
    // The volume has no lower bound: a refund of an earlier month's payment lands in this one.
    await count(a.projectId, '2026-12', 0, -2_500, 'EUR');
  });

  it('lets the application role count in its own live context, and never delete', async () => {
    await beginAsProject(app, { projectId: b.projectId, environment: 'live' });
    try {
      await app.query(
        `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
         VALUES ($1, $2, 'live', '2027-01', 1)
         ON CONFLICT (project_id, environment, month)
         DO UPDATE SET bookings_confirmed = plan_usage.bookings_confirmed + 1`,
        [uuidv7(), b.projectId],
      );
      const deleted = await expectPgError(
        app.query(`DELETE FROM plan_usage WHERE project_id = $1`, [b.projectId]),
      );
      expect(deleted.code).toBe('42501');
    } finally {
      await app.query('ROLLBACK');
    }

    // An insert that claims another project is refused by the policy's WITH CHECK.
    await beginAsProject(app, { projectId: b.projectId, environment: 'live' });
    try {
      const foreign = await expectPgError(
        app.query(
          `INSERT INTO plan_usage (id, project_id, environment, month) VALUES ($1, $2, 'live', '2027-02')`,
          [uuidv7(), a.projectId],
        ),
      );
      expect(foreign.code).toBe('42501');
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('sums every project of the account for one month, and nothing of another account', async () => {
    await asProject(app, { projectId: a.projectId, environment: 'live' }, async () => {
      const { rows } = await app.query<{
        bookings_confirmed: string;
        payment_volume: string;
        currency: string | null;
      }>('SELECT * FROM plan_usage_for_account($1, $2)', [a.accountId, MONTH]);
      expect(rows).toEqual([
        { bookings_confirmed: '12', payment_volume: '15000', currency: 'EUR' },
      ]);
    });

    // From the second project of the same account: the same one threshold.
    await asProject(app, { projectId: a2, environment: 'live' }, async () => {
      const { rows } = await app.query<{ bookings_confirmed: string }>(
        'SELECT bookings_confirmed FROM plan_usage_for_account($1, $2)',
        [a.accountId, MONTH],
      );
      expect(rows[0]?.bookings_confirmed).toBe('12');
    });

    // A test key reads the live numbers of its own account: the threshold is the account's.
    await asProject(app, { projectId: a.projectId, environment: 'test' }, async () => {
      const { rows } = await app.query<{ bookings_confirmed: string }>(
        'SELECT bookings_confirmed FROM plan_usage_for_account($1, $2)',
        [a.accountId, MONTH],
      );
      expect(rows[0]?.bookings_confirmed).toBe('12');
    });

    // A month nothing was counted in is one row of zeros, not no row.
    await asProject(app, { projectId: a.projectId, environment: 'live' }, async () => {
      const { rows } = await app.query('SELECT * FROM plan_usage_for_account($1, $2)', [
        a.accountId,
        '2030-01',
      ]);
      expect(rows).toEqual([{ bookings_confirmed: '0', payment_volume: '0', currency: null }]);
    });
  });

  it('answers zeros for an account that is not the account of the request', async () => {
    // Project A asking about account B, whose project has 900 bookings this month.
    await asProject(app, { projectId: a.projectId, environment: 'live' }, async () => {
      const { rows } = await app.query<{ bookings_confirmed: string }>(
        'SELECT bookings_confirmed FROM plan_usage_for_account($1, $2)',
        [b.accountId, MONTH],
      );
      expect(rows[0]?.bookings_confirmed).toBe('0');
    });
    // And nothing at all with no context.
    const { rows } = await app.query<{ bookings_confirmed: string }>(
      'SELECT bookings_confirmed FROM plan_usage_for_account($1, $2)',
      [b.accountId, MONTH],
    );
    expect(rows[0]?.bookings_confirmed).toBe('0');
  });

  it('says mixed when the projects of an account counted two currencies', async () => {
    const mixed = await createProject(admin, 'Plan mixed');
    const other = uuidv7();
    await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Mixed two')`, [
      other,
      mixed.accountId,
    ]);
    await count(mixed.projectId, MONTH, 0, 1_000, 'EUR');
    await count(other, MONTH, 0, 2_000, 'USD');
    await asProject(app, { projectId: mixed.projectId, environment: 'live' }, async () => {
      const { rows } = await app.query('SELECT * FROM plan_usage_for_account($1, $2)', [
        mixed.accountId,
        MONTH,
      ]);
      expect(rows).toEqual([
        { bookings_confirmed: '0', payment_volume: '3000', currency: 'mixed' },
      ]);
    });
  });

  /**
   * What the free plan's check adds to the counter: the open live `pending` bookings and the
   * amount of the open live payments of every project of the account, with no month.
   */
  it('counts what an account has accepted and not yet counted, live only, and nothing of another account', async () => {
    const acc = await createProject(admin, 'Plan reserved');
    const second = uuidv7();
    await admin.query(
      `INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Reserved two')`,
      [second, acc.accountId],
    );
    // Each seed is one `pending` booking with one open deposit of 2 500.
    const one = await seedProjectData(admin, acc.projectId, 'live');
    const two = await seedProjectData(admin, second, 'live');
    await seedProjectData(admin, acc.projectId, 'test');
    const reserved = async (account: string, projectId: string): Promise<unknown> =>
      asProject(app, { projectId, environment: 'live' }, async () => {
        const { rows } = await app.query('SELECT * FROM plan_reserved_for_account($1)', [account]);
        return rows;
      });

    expect(await reserved(acc.accountId, acc.projectId)).toEqual([
      { bookings_pending: '2', payment_volume_pending: '5000' },
    ]);
    // A confirmed booking and a succeeded payment are no longer pending: they are counted in
    // `plan_usage` instead, and appear in exactly one of the two places.
    await admin.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [one.bookings]);
    await admin.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [one.payments]);
    expect(await reserved(acc.accountId, acc.projectId)).toEqual([
      { bookings_pending: '1', payment_volume_pending: '2500' },
    ]);
    // A refund row is money going back, not money on its way in.
    await admin.query(
      `INSERT INTO payments (id, project_id, environment, booking_id, provider, provider_account_id,
                             parent_payment_id, type, amount, currency)
       VALUES ($1, $2, 'live', $3, 'stripe', $4, $5, 'refund', 900, 'EUR')`,
      [
        uuidv7(),
        acc.projectId,
        one.bookings,
        `acct_${one.payments!.replaceAll('-', '')}`,
        one.payments,
      ],
    );
    expect(await reserved(acc.accountId, acc.projectId)).toEqual([
      { bookings_pending: '1', payment_volume_pending: '2500' },
    ]);
    // The payment of a booking that has been cancelled is no longer money on its way in, even
    // while the payment row itself is still `pending` (its intent not yet cancelled at Stripe,
    // or never, when the worker runs out of attempts).
    await admin.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [two.bookings]);
    expect(await reserved(acc.accountId, acc.projectId)).toEqual([
      { bookings_pending: '0', payment_volume_pending: '0' },
    ]);
    // Asked from a project of another account, or with no context: zeros.
    expect(await reserved(acc.accountId, b.projectId)).toEqual([
      { bookings_pending: '0', payment_volume_pending: '0' },
    ]);
    const { rows } = await app.query('SELECT * FROM plan_reserved_for_account($1)', [
      acc.accountId,
    ]);
    expect(rows).toEqual([{ bookings_pending: '0', payment_volume_pending: '0' }]);
  });

  it('claims a warning once, and never for another account', async () => {
    const claim = async (account: string, threshold: number): Promise<number> =>
      asProject(app, { projectId: a.projectId, environment: 'live' }, async () => {
        const { rows } = await app.query('SELECT * FROM plan_usage_warning_claim($1, $2, $3)', [
          account,
          MONTH,
          threshold,
        ]);
        return rows.length;
      });

    expect(await claim(a.accountId, 80)).toBe(1);
    expect(await claim(a.accountId, 80)).toBe(0);
    expect(await claim(a.accountId, 100)).toBe(1);
    expect(await claim(b.accountId, 80)).toBe(0);

    const { rows } = await admin.query<{ account_id: string; threshold: number }>(
      'SELECT account_id, threshold FROM plan_usage_warnings WHERE account_id = ANY($1) ORDER BY threshold',
      [[a.accountId, b.accountId]],
    );
    expect(rows).toEqual([
      { account_id: a.accountId, threshold: 80 },
      { account_id: a.accountId, threshold: 100 },
    ]);

    // A threshold that is not one of the two is refused by the table.
    const other = await expectPgError(
      asProject(app, { projectId: a.projectId, environment: 'live' }, () =>
        app.query('SELECT * FROM plan_usage_warning_claim($1, $2, 50)', [a.accountId, MONTH]),
      ),
    );
    expect(other.code).toBe('23514');
  });

  it('keeps the warnings closed to the application role', async () => {
    await asProject(app, { projectId: a.projectId, environment: 'live' }, async () => {
      const read = await expectPgError(app.query('SELECT * FROM plan_usage_warnings'));
      expect(read.code).toBe('42501');
    });
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'plan_usage_warnings'`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await admin.query(
      `SELECT 1 FROM pg_policies WHERE tablename = 'plan_usage_warnings'`,
    );
    expect(policies.rows).toHaveLength(0);
  });

  it('refuses a plan name that does not exist', async () => {
    const refused = await expectPgError(
      admin.query(`UPDATE accounts SET plan = 'gold' WHERE id = $1`, [a.accountId]),
    );
    expect(refused.code).toBe('23514');
    await admin.query(`UPDATE accounts SET plan = 'scale' WHERE id = $1`, [a.accountId]);
    await admin.query(`UPDATE accounts SET plan = 'free' WHERE id = $1`, [a.accountId]);
  });

  it('resolves a key to its account and plan', async () => {
    const keyId = uuidv7();
    const hash = keyId.replace(/-/g, '').repeat(2);
    await admin.query(`UPDATE accounts SET plan = 'pro' WHERE id = $1`, [b.accountId]);
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash)
       VALUES ($1, $2, 'live', 'secret', 'plan', 'planplan', $3)`,
      [keyId, b.projectId, hash],
    );
    const { rows } = await app.query<{ id: string; account_id: string; plan: string }>(
      'SELECT id, account_id, plan FROM auth_lookup_api_key($1, $2)',
      [hash, 'planplan'],
    );
    expect(rows).toEqual([{ id: keyId, account_id: b.accountId, plan: 'pro' }]);
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
      [[...PLAN_FUNCTIONS]],
    );
    // One of each: the old `auth_lookup_api_key` is gone, not kept beside the new one.
    expect(rows.map((row) => row.name)).toEqual([...PLAN_FUNCTIONS]);
    const { rows: who } = await admin.query<{ role: string }>('SELECT current_user AS role');
    for (const row of rows) {
      expect(row.prosecdef, `${row.name} is not SECURITY DEFINER`).toBe(true);
      expect(row.owner, `${row.name} is owned by somebody else`).toBe(who[0]?.role);
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
      [[...PLAN_FUNCTIONS]],
    );
    expect(rows).toHaveLength(PLAN_FUNCTIONS.length);
    for (const row of rows) {
      const acl = (row.acl ?? []).join(',');
      expect(acl, `${row.signature} is executable by PUBLIC`).not.toMatch(/(^|,)=X/);
      expect(acl, `${row.signature} is not granted to ${appRole}`).toContain(`${appRole}=X`);
      expect(acl, `${row.signature} is granted to ${jobsRole}`).not.toContain(`${jobsRole}=X`);
    }
  });
});
