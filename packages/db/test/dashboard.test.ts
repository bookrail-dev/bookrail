/**
 * The dashboard tables and the eight functions around them (migration 0026), from the point of
 * view of the application role.
 *
 * Five things are measured here. The two tables are closed: forced row security, no policy, no
 * grant. The ceilings on link requests count every request, for an address with an account and
 * for one without, so the sixth answer is the same for both. A link becomes a session once, and
 * a session lives twelve hours that no argument can lengthen or bring back. The usage the
 * overview reports is the usage the free plan's gate reads, computed on the same data. And the
 * key functions act only for the account of the session they are given.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError, testUrls } from './helpers.js';
import { seedProjectData } from './fixtures.js';

const DASHBOARD_FUNCTIONS = [
  'dashboard_account_overview',
  'dashboard_key_create',
  'dashboard_key_revoke',
  'dashboard_login_confirm',
  'dashboard_login_start',
  'dashboard_purge',
  'dashboard_session_resolve',
  'dashboard_session_revoke',
] as const;

const DASHBOARD_TABLES = ['dashboard_logins', 'dashboard_sessions'] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `dash-${String(counter)}-${String(process.pid)}-${uuidv7().slice(-6)}@example.com`;
}

function freshIp(): string {
  return sha256(`ip-${uuidv7()}`);
}

interface SelfServeAccount {
  accountId: string;
  projectId: string;
  email: string;
}

/** An account as the sign up creates it: self service, with an owner address and a project. */
async function selfServeAccount(admin: Client, name: string): Promise<SelfServeAccount> {
  const accountId = uuidv7();
  const projectId = uuidv7();
  const email = freshEmail();
  await admin.query(
    `INSERT INTO accounts (id, name, origin, owner_email) VALUES ($1, $2, 'self_serve', $3)`,
    [accountId, name, email],
  );
  await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, $3)`, [
    projectId,
    accountId,
    name,
  ]);
  return { accountId, projectId, email };
}

/** A live session for that account, through the two functions the API calls. */
async function login(app: Client, email: string): Promise<{ session: string; id: string }> {
  const link = token('bls');
  const session = token('bds');
  const started = await app.query<{ send_email: boolean }>(
    'SELECT * FROM dashboard_login_start($1, $2, $3)',
    [email, sha256(link), freshIp()],
  );
  expect(started.rows[0]?.send_email).toBe(true);
  const { rows } = await app.query<{ session_id: string }>(
    'SELECT * FROM dashboard_login_confirm($1, $2)',
    [sha256(link), sha256(session)],
  );
  return { session, id: rows[0]!.session_id };
}

describe('the dashboard tables', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    // A row in each, so that "sees nothing" is measured against something that is there.
    const account = await selfServeAccount(admin, 'Closed tables');
    await login(app, account.email);
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('have row security enabled and forced, and no policy at all', async () => {
    for (const table of DASHBOARD_TABLES) {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = $1`,
        [table],
      );
      expect(rows[0]?.relrowsecurity, table).toBe(true);
      expect(rows[0]?.relforcerowsecurity, table).toBe(true);
      const { rows: policies } = await admin.query(
        `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      expect(policies, table).toEqual([]);
    }
  });

  it('refuse every statement of the application role, with rows sitting right there', async () => {
    for (const table of DASHBOARD_TABLES) {
      const { rows: really } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table}`,
      );
      expect(Number(really[0]?.n), table).toBeGreaterThan(0);
      for (const statement of [
        `SELECT token_hash FROM ${table}`,
        `UPDATE ${table} SET created_at = now()`,
        `DELETE FROM ${table}`,
      ]) {
        const failure = await expectPgError(app.query(statement));
        expect(failure.code, statement).toBe('42501');
      }
    }
  });

  it('grant nothing to the application role or to the job role', async () => {
    const { appRole, jobsRole } = testUrls();
    for (const table of DASHBOARD_TABLES) {
      for (const role of [appRole, jobsRole]) {
        const { rows } = await admin.query<{ p: string; has: boolean }>(
          `SELECT p, has_table_privilege($1, $2, p) AS has
             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`,
          [role, table],
        );
        for (const row of rows) expect(row.has, `${role} ${row.p} ${table}`).toBe(false);
      }
    }
  });
});

describe('the eight dashboard functions', () => {
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
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [[...DASHBOARD_FUNCTIONS]],
    );
    expect(rows.map((row) => row.name).sort()).toEqual([...DASHBOARD_FUNCTIONS].sort());
    const { rows: who } = await admin.query<{ role: string }>('SELECT current_user AS role');
    for (const row of rows) {
      expect(row.prosecdef, row.name).toBe(true);
      expect(row.owner, row.name).toBe(who[0]?.role);
      expect(row.proconfig ?? [], row.name).toContain('search_path=public, pg_temp');
    }
  });

  it('may be executed by the application role and by nobody else', async () => {
    const { appRole, jobsRole } = testUrls();
    const { rows } = await admin.query<{ signature: string; acl: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS signature, p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [[...DASHBOARD_FUNCTIONS]],
    );
    expect(rows).toHaveLength(DASHBOARD_FUNCTIONS.length);
    for (const row of rows) {
      const acl = (row.acl ?? []).join(',');
      expect(acl, `${row.signature} is executable by PUBLIC`).not.toMatch(/(^|,)=X/);
      expect(acl, row.signature).toContain(`${appRole}=X`);
      expect(acl, row.signature).not.toContain(`${jobsRole}=X`);
    }
  });

  /**
   * Two, on purpose: the one-key version of 0021 stays for the previous release, which a rollback
   * by symlink runs against this schema, until a later migration removes it. Both carry the four
   * properties and the grant.
   */
  it('leave two signup_confirm, the two-key one and the one-key one kept for a rollback', async () => {
    const { appRole } = testUrls();
    const { rows } = await admin.query<{
      signature: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      acl: string[] | null;
    }>(
      `SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
              p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'signup_confirm'
        ORDER BY 1`,
    );
    expect(rows.map((row) => row.signature)).toEqual([
      'signup_confirm(text,uuid,uuid,uuid,text,text,text,text)',
      'signup_confirm(text,uuid,uuid,uuid,text,text,text,uuid,text,text,text,text)',
    ]);
    for (const row of rows) {
      expect(row.prosecdef, row.signature).toBe(true);
      expect(row.proconfig ?? [], row.signature).toContain('search_path=public, pg_temp');
      expect((row.acl ?? []).join(','), row.signature).toContain(`${appRole}=X`);
    }
  });
});

describe('asking for a link', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  const start = (email: string, ip: string): Promise<{ rows: { send_email: boolean }[] }> =>
    app.query<{ send_email: boolean }>('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      email,
      sha256(token('bls')),
      ip,
    ]);

  it('says whether to send, and records the request either way', async () => {
    const account = await selfServeAccount(admin, 'Link');
    const stranger = freshEmail();
    expect((await start(account.email, freshIp())).rows[0]?.send_email).toBe(true);
    expect((await start(stranger, freshIp())).rows[0]?.send_email).toBe(false);

    const { rows } = await admin.query<{ email: string; has_account: boolean }>(
      `SELECT email, account_id IS NOT NULL AS has_account FROM dashboard_logins
        WHERE email = ANY($1) ORDER BY created_at`,
      [[account.email, stranger]],
    );
    expect(rows).toEqual([
      { email: account.email, has_account: true },
      { email: stranger, has_account: false },
    ]);
  });

  it('does not send for an account created by hand, which has no dashboard', async () => {
    const email = freshEmail();
    await admin.query(
      `INSERT INTO accounts (id, name, origin, owner_email) VALUES ($1, 'By hand', 'bootstrap', $2)`,
      [uuidv7(), email],
    );
    expect((await start(email, freshIp())).rows[0]?.send_email).toBe(false);
  });

  /**
   * The sixth request of an hour is refused for a customer and for a stranger alike. A ceiling
   * that counted only the rows of real accounts would let a stranger's address through for ever
   * and stop a customer's at six, which is an answer to "is this person a customer".
   */
  it('refuses the sixth request for one address, whether or not it has an account', async () => {
    const account = await selfServeAccount(admin, 'Ceiling');
    for (const email of [account.email, freshEmail()]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const accepted = await start(email, freshIp());
        expect(accepted.rows, `${email} attempt ${String(attempt)}`).toHaveLength(1);
      }
      const sixth = await expectPgError(start(email, freshIp()));
      expect(sixth.code, email).toBe('P0429');
    }
  });

  /**
   * Twenty requests for one address at the same instant, from twenty callers. The count and the
   * insert run under two advisory locks, so they are served one after the other and exactly five
   * get in. Without the locks every one of them reads the same count (the independent review saw
   * twelve pass).
   */
  it('lets exactly five of twenty simultaneous requests for one address through', async () => {
    const email = freshEmail();
    const clients = await Promise.all(Array.from({ length: 20 }, () => appClient()));
    try {
      const outcomes = await Promise.allSettled(
        clients.map((client) =>
          client.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
            email,
            sha256(token('bls')),
            freshIp(),
          ]),
        ),
      );
      const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === 'P0429',
      );
      expect(accepted).toHaveLength(5);
      expect(refused).toHaveLength(15);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM dashboard_logins WHERE email = $1',
      [email],
    );
    expect(rows[0]?.n).toBe('5');
  });

  it('refuses the twenty-first request from one caller', async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await start(freshEmail(), ip);
    }
    const refused = await expectPgError(start(freshEmail(), ip));
    expect(refused.code).toBe('P0429');
  });
});

describe('from a link to a session', () => {
  let admin: Client;
  let app: Client;
  let account: SelfServeAccount;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    account = await selfServeAccount(admin, 'Session');
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  async function link(email: string): Promise<string> {
    const value = token('bls');
    await app.query('SELECT * FROM dashboard_login_start($1, $2, $3)', [
      email,
      sha256(value),
      freshIp(),
    ]);
    return value;
  }

  const confirm = (
    linkToken: string,
    sessionToken: string,
    now?: string,
  ): Promise<{ rows: { session_id: string; account_id: string; expires_at: Date }[] }> =>
    app.query<{ session_id: string; account_id: string; expires_at: Date }>(
      now === undefined
        ? 'SELECT * FROM dashboard_login_confirm($1, $2)'
        : 'SELECT * FROM dashboard_login_confirm($1, $2, $3::timestamptz)',
      now === undefined
        ? [sha256(linkToken), sha256(sessionToken)]
        : [sha256(linkToken), sha256(sessionToken), now],
    );

  const resolve = (sessionToken: string, now?: string): Promise<{ rows: unknown[] }> =>
    app.query(
      now === undefined
        ? 'SELECT * FROM dashboard_session_resolve($1)'
        : 'SELECT * FROM dashboard_session_resolve($1, $2::timestamptz)',
      now === undefined ? [sha256(sessionToken)] : [sha256(sessionToken), now],
    );

  it('makes one session of twelve hours out of a link, once', async () => {
    const value = await link(account.email);
    const session = token('bds');
    const { rows } = await confirm(value, session);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBe(account.accountId);
    const { rows: stored } = await admin.query<{ hours: string }>(
      `SELECT extract(epoch FROM expires_at - created_at)::int / 3600 AS hours
         FROM dashboard_sessions WHERE id = $1`,
      [rows[0]?.session_id],
    );
    expect(Number(stored[0]?.hours)).toBe(12);

    const again = await expectPgError(confirm(value, token('bds')));
    expect(again.code).toBe('P0409');
    expect(await resolve(session)).toMatchObject({ rows: [{ account_id: account.accountId }] });
  });

  it('knows nothing of a link that was never sent, or never existed', async () => {
    const strangers = await link(freshEmail());
    expect((await expectPgError(confirm(strangers, token('bds')))).code).toBe('P0404');
    expect((await expectPgError(confirm(token('bls'), token('bds')))).code).toBe('P0404');
  });

  it('refuses an expired link, and no argument can make it young again', async () => {
    const value = await link(account.email);
    // Sixteen minutes on, by moving the clock forward.
    const later = new Date(Date.now() + 16 * 60_000).toISOString();
    expect((await expectPgError(confirm(value, token('bds'), later))).code).toBe('P0410');

    // A link that really expired, and a clock moved backward: still expired.
    const old = await link(account.email);
    await admin.query(
      `UPDATE dashboard_logins SET created_at = now() - interval '20 minutes',
                                   expires_at = now() - interval '5 minutes'
        WHERE token_hash = $1`,
      [sha256(old)],
    );
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await expectPgError(confirm(old, token('bds'), earlier))).code).toBe('P0410');
  });

  it('ends a session after twelve hours, on revocation, and never brings it back', async () => {
    const { session } = await login(app, account.email);
    expect((await resolve(session)).rows).toHaveLength(1);
    const thirteenHours = new Date(Date.now() + 13 * 3_600_000).toISOString();
    expect((await resolve(session, thirteenHours)).rows).toHaveLength(0);

    const { rows: revoked } = await app.query<{ n: number }>(
      'SELECT dashboard_session_revoke($1) AS n',
      [sha256(session)],
    );
    expect(revoked[0]?.n).toBe(1);
    expect((await resolve(session)).rows).toHaveLength(0);
    const { rows: twice } = await app.query<{ n: number }>(
      'SELECT dashboard_session_revoke($1) AS n',
      [sha256(session)],
    );
    expect(twice[0]?.n).toBe(0);

    // A session that has really expired stays expired with a clock moved backward.
    const { session: aged } = await login(app, account.email);
    await admin.query(
      `UPDATE dashboard_sessions SET created_at = now() - interval '13 hours',
                                     expires_at = now() - interval '1 hour'
        WHERE token_hash = $1`,
      [sha256(aged)],
    );
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
    expect((await resolve(aged, yesterday)).rows).toHaveLength(0);
  });
});

describe('the overview', () => {
  let admin: Client;
  let app: Client;
  let mine: SelfServeAccount;
  let theirs: SelfServeAccount;
  let second: string;
  const MONTH = '2026-09';

  async function count(projectId: string, month: string, bookings: number, volume: number) {
    await admin.query(
      `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed,
                               payment_volume, currency)
       VALUES ($1, $2, 'live', $3, $4, $5, 'EUR')`,
      [uuidv7(), projectId, month, bookings, volume],
    );
  }

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    mine = await selfServeAccount(admin, 'Mine');
    theirs = await selfServeAccount(admin, 'Theirs');
    second = uuidv7();
    await admin.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'Mine two')`, [
      second,
      mine.accountId,
    ]);
    // The same kinds of rows in both accounts, in both environments, and in two months, so that
    // a sum that forgot one of its filters would come out different. Each live seed brings a
    // counter row for September (3 bookings, 4 500), a pending booking with an open payment of
    // 2 500, and a key named `fixture`.
    const seeded = await seedProjectData(admin, mine.projectId, 'live');
    await seedProjectData(admin, second, 'live');
    await seedProjectData(admin, mine.projectId, 'test');
    await seedProjectData(admin, theirs.projectId, 'live');
    await count(mine.projectId, '2026-08', 400, 1);

    // One row for each filter that separates what is pending from what is not, each with a value
    // that would change a number if its filter were missing from either copy of the arithmetic:
    //   a confirmed and a cancelled booking (the `pending` filter on bookings),
    //   a succeeded payment on a pending booking (the `pending` filter on payments),
    //   a pending refund on a pending booking (the `refund` filter),
    //   a pending payment on the cancelled booking (the `pending` filter on the booking of a payment).
    const copyBooking = async (status: string): Promise<string> => {
      const id = uuidv7();
      await admin.query(
        `INSERT INTO bookings (id, project_id, environment, service_id, customer_id, starts_at,
                               ends_at, timezone, status)
         SELECT $1, project_id, environment, service_id, customer_id,
                starts_at + interval '2 days', ends_at + interval '2 days', timezone, $3
           FROM bookings WHERE id = $2`,
        [id, seeded.bookings, status],
      );
      return id;
    };
    await copyBooking('confirmed');
    const cancelled = await copyBooking('cancelled');
    const payment = async (
      bookingId: string,
      amount: number,
      options: { status?: string; refundOf?: string } = {},
    ): Promise<string> => {
      const id = uuidv7();
      await admin.query(
        `INSERT INTO payments (id, project_id, environment, booking_id, provider, provider_account_id,
                               parent_payment_id, type, amount, currency)
         VALUES ($1, $2, 'live', $3, 'stripe', $4, $5, $6, $7, 'EUR')`,
        [
          id,
          mine.projectId,
          bookingId,
          `acct_${id.replaceAll('-', '')}`,
          options.refundOf ?? null,
          options.refundOf === undefined ? 'deposit' : 'refund',
          amount,
        ],
      );
      if (options.status !== undefined) {
        await admin.query('UPDATE payments SET status = $2 WHERE id = $1', [id, options.status]);
      }
      return id;
    };
    const succeeded = await payment(seeded.bookings!, 7000, { status: 'succeeded' });
    await payment(seeded.bookings!, 900, { refundOf: succeeded });
    await payment(cancelled, 3000);
    await admin.query(
      `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash)
       VALUES ($1, $2, 'live', 'secret', 'live secret key', 'abcd1234', $3),
              ($4, $5, 'live', 'secret', 'theirs', 'zzzz9999', $6)`,
      [uuidv7(), mine.projectId, sha256(uuidv7()), uuidv7(), theirs.projectId, sha256(uuidv7())],
    );
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  /**
   * The two roads to the same numbers, on the same data.
   *
   * The overview computes the usage without the guard of `plan_usage_for_account` and
   * `plan_reserved_for_account`, because it has a session and not a project in context. This is
   * what keeps the two copies of the arithmetic equal: the gate of the free plan reads the
   * functions of 0025, the dashboard shows the overview, and a customer must see the numbers
   * the gate decides with.
   */
  it('reports the usage the free plan gate reads, on the same data', async () => {
    const { session } = await login(app, mine.email);
    const { rows: overview } = await app.query<Record<string, unknown>>(
      'SELECT * FROM dashboard_account_overview($1, $2)',
      [sha256(session), MONTH],
    );
    const gate = await asProject(app, { projectId: mine.projectId, environment: 'live' }, () =>
      app.query<Record<string, unknown>>(
        `SELECT u.bookings_confirmed, u.payment_volume, u.currency,
                r.bookings_pending, r.payment_volume_pending
           FROM plan_usage_for_account($1, $2) u, plan_reserved_for_account($1) r`,
        [mine.accountId, MONTH],
      ),
    );
    const row = overview[0]!;
    const expected = gate.rows[0]!;
    expect({
      bookings_confirmed: row.bookings_confirmed,
      payment_volume: row.payment_volume,
      currency: row.currency,
      bookings_pending: row.bookings_pending,
      payment_volume_pending: row.payment_volume_pending,
    }).toEqual(expected);
    // And the numbers are the ones seeded, not merely equal to each other: 3 + 3 confirmed in
    // September, one pending booking and one open payment of 2 500 per live project. Without the
    // filter on bookings `bookings_pending` would be 4; without the one on payment status the
    // open volume would be 12 000, without the refund one 5 900, and without the one on the
    // booking of a payment 8 000.
    expect(expected).toEqual({
      bookings_confirmed: '6',
      payment_volume: '9000',
      currency: 'EUR',
      bookings_pending: '2',
      payment_volume_pending: '5000',
    });
  });

  it('lists every project and every key of the account, and never a key hash', async () => {
    const { session } = await login(app, mine.email);
    const { rows } = await app.query<{
      account_id: string;
      plan: string;
      owner_email: string;
      projects: { id: string; api_keys: Record<string, unknown>[] }[];
    }>('SELECT * FROM dashboard_account_overview($1, $2)', [sha256(session), MONTH]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.account_id).toBe(mine.accountId);
    expect(row.plan).toBe('free');
    expect(row.owner_email).toBe(mine.email);
    expect(row.projects.map((project) => project.id).sort()).toEqual(
      [mine.projectId, second].sort(),
    );
    const keys = row.projects.flatMap((project) => project.api_keys);
    // The three fixture keys of the seeds and the one inserted above; none of the other account.
    expect(keys).toHaveLength(4);
    expect(keys.map((key) => key.prefix)).toContain('abcd1234');
    expect(keys.map((key) => key.prefix)).not.toContain('zzzz9999');
    expect(Object.keys(keys[0]!).sort()).toEqual(
      [
        'created_at',
        'environment',
        'id',
        'kind',
        'last_used_at',
        'name',
        'prefix',
        'revoked_at',
        'tenant_id',
      ].sort(),
    );
    const { rows: hashes } = await admin.query<{ key_hash: string }>(
      `SELECT key_hash FROM api_keys WHERE project_id = ANY($1)`,
      [[mine.projectId, second]],
    );
    expect(hashes).toHaveLength(4);
    for (const { key_hash } of hashes) expect(JSON.stringify(rows)).not.toContain(key_hash);
  });

  it('answers nothing for a session that is not live', async () => {
    const { session } = await login(app, mine.email);
    const later = new Date(Date.now() + 13 * 3_600_000).toISOString();
    const { rows: expired } = await app.query(
      'SELECT * FROM dashboard_account_overview($1, $2, $3::timestamptz)',
      [sha256(session), MONTH, later],
    );
    expect(expired).toEqual([]);
    const { rows: unknown } = await app.query('SELECT * FROM dashboard_account_overview($1, $2)', [
      sha256(token('bds')),
      MONTH,
    ]);
    expect(unknown).toEqual([]);
  });
});

describe('creating and revoking keys', () => {
  let admin: Client;
  let app: Client;
  let mine: SelfServeAccount;
  let theirs: SelfServeAccount;
  let session: string;
  let theirSession: string;

  const create = (
    client: Client,
    sessionToken: string,
    projectId: string,
    environment: 'test' | 'live',
  ): Promise<{ rows: { id: string; kind: string; environment: string }[] }> => {
    const secret = token(`sk_${environment}`);
    return client.query<{ id: string; kind: string; environment: string }>(
      'SELECT * FROM dashboard_key_create($1, $2, $3, $4, $5, $6, $7)',
      [
        sha256(sessionToken),
        projectId,
        environment,
        uuidv7(),
        secret.slice(8, 16),
        sha256(secret),
        `${environment} key`,
      ],
    );
  };

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    mine = await selfServeAccount(admin, 'Keys mine');
    theirs = await selfServeAccount(admin, 'Keys theirs');
    session = (await login(app, mine.email)).session;
    theirSession = (await login(app, theirs.email)).session;
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('creates a secret key with no scopes and no tenant, up to five active ones', async () => {
    const created = await create(app, session, mine.projectId, 'live');
    expect(created.rows[0]).toMatchObject({ kind: 'secret', environment: 'live' });
    const { rows } = await admin.query<{ scopes: string[]; tenant_id: string | null }>(
      'SELECT scopes, tenant_id FROM api_keys WHERE id = $1',
      [created.rows[0]?.id],
    );
    expect(rows[0]).toEqual({ scopes: [], tenant_id: null });

    for (let n = 2; n <= 5; n += 1) await create(app, session, mine.projectId, 'live');
    const sixth = await expectPgError(create(app, session, mine.projectId, 'live'));
    expect(sixth.code).toBe('P0409');
    // The other environment has its own five.
    expect((await create(app, session, mine.projectId, 'test')).rows).toHaveLength(1);

    // A revoked key frees its place.
    const { rows: live } = await admin.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE project_id = $1 AND environment = 'live' LIMIT 1`,
      [mine.projectId],
    );
    await app.query('SELECT * FROM dashboard_key_revoke($1, $2)', [sha256(session), live[0]?.id]);
    expect((await create(app, session, mine.projectId, 'live')).rows).toHaveLength(1);
  });

  /**
   * Ten creations at once for a project with room for two. The project row is locked before the
   * count, so the ten are serialised and exactly two get in.
   */
  it('lets exactly as many through as there is room for, under concurrency', async () => {
    const project = await selfServeAccount(admin, 'Race');
    const raceSession = (await login(app, project.email)).session;
    for (let n = 0; n < 3; n += 1) await create(app, raceSession, project.projectId, 'live');

    const clients = await Promise.all(Array.from({ length: 10 }, () => appClient()));
    try {
      const outcomes = await Promise.allSettled(
        clients.map((client) => create(client, raceSession, project.projectId, 'live')),
      );
      const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === 'P0409',
      );
      expect(accepted).toHaveLength(2);
      expect(refused).toHaveLength(8);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_keys
        WHERE project_id = $1 AND environment = 'live' AND revoked_at IS NULL`,
      [project.projectId],
    );
    expect(rows[0]?.n).toBe('5');
  });

  /**
   * Twenty creations a day per account, revoked keys included: creating and revoking in a loop
   * stays under five active keys and would otherwise grow the table without end.
   */
  it('refuses the twenty-first key created for an account in a day, revoked ones included', async () => {
    const churn = await selfServeAccount(admin, 'Churn');
    const churnSession = (await login(app, churn.email)).session;
    for (let n = 0; n < 20; n += 1) {
      const id = (await create(app, churnSession, churn.projectId, 'test')).rows[0]!.id;
      await app.query('SELECT * FROM dashboard_key_revoke($1, $2)', [sha256(churnSession), id]);
    }
    const refused = await expectPgError(create(app, churnSession, churn.projectId, 'test'));
    expect(refused.code).toBe('P0429');
    // A day later the window has moved on.
    await admin.query(
      `UPDATE api_keys SET created_at = now() - interval '25 hours' WHERE project_id = $1`,
      [churn.projectId],
    );
    expect((await create(app, churnSession, churn.projectId, 'test')).rows).toHaveLength(1);
  });

  it('acts only for the account of the session', async () => {
    const intrusion = await expectPgError(create(app, session, theirs.projectId, 'live'));
    expect(intrusion.code).toBe('P0404');

    const theirKey = (await create(app, theirSession, theirs.projectId, 'test')).rows[0]!.id;
    const revoke = await expectPgError(
      app.query('SELECT * FROM dashboard_key_revoke($1, $2)', [sha256(session), theirKey]),
    );
    expect(revoke.code).toBe('P0404');
    const { rows } = await admin.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      [theirKey],
    );
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it('refuses a session that is not live', async () => {
    const later = new Date(Date.now() + 13 * 3_600_000).toISOString();
    const secret = token('sk_live');
    const expired = await expectPgError(
      app.query('SELECT * FROM dashboard_key_create($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)', [
        sha256(session),
        mine.projectId,
        'live',
        uuidv7(),
        secret.slice(8, 16),
        sha256(secret),
        'late',
        later,
      ]),
    );
    expect(expired.code).toBe('P0401');
    const unknown = await expectPgError(create(app, token('bds'), mine.projectId, 'test'));
    expect(unknown.code).toBe('P0401');
  });

  it('returns a revoked key as it is when it is revoked again', async () => {
    const id = (await create(app, theirSession, theirs.projectId, 'test')).rows[0]!.id;
    const first = await app.query<{ revoked_at: Date }>(
      'SELECT * FROM dashboard_key_revoke($1, $2)',
      [sha256(theirSession), id],
    );
    const second = await app.query<{ revoked_at: Date }>(
      'SELECT * FROM dashboard_key_revoke($1, $2)',
      [sha256(theirSession), id],
    );
    expect(first.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(second.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
  });
});

describe('the hourly sweep', () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  /**
   * The purge takes no instant, so the rows are aged instead: one request for a link from two
   * hours ago and one from now, a session that ended nine days ago, one revoked eight days ago,
   * and one that is live.
   */
  it('deletes link requests past the hour and sessions dead for a week, and nothing else', async () => {
    const account = await selfServeAccount(admin, 'Sweep');
    const { id: live } = await login(app, account.email);
    const { id: ended } = await login(app, account.email);
    const { id: revoked } = await login(app, account.email);
    await admin.query(
      `UPDATE dashboard_sessions SET created_at = now() - interval '9 days',
                                     expires_at = now() - interval '8 days' WHERE id = $1`,
      [ended],
    );
    await admin.query(
      `UPDATE dashboard_sessions SET revoked_at = now() - interval '8 days' WHERE id = $1`,
      [revoked],
    );
    const { rows: requests } = await admin.query<{ id: string }>(
      `SELECT id FROM dashboard_logins WHERE email = $1 ORDER BY created_at`,
      [account.email],
    );
    expect(requests).toHaveLength(3);
    await admin.query(
      `UPDATE dashboard_logins SET created_at = now() - interval '2 hours',
                                   expires_at = now() - interval '105 minutes'
        WHERE id = ANY($1::uuid[])`,
      [requests.slice(0, 2).map((row) => row.id)],
    );

    const { rows } = await app.query<{ touched: number }>('SELECT dashboard_purge() AS touched');
    // At least the four aged rows; other files of this suite may have left aged rows too.
    expect(rows[0]!.touched).toBeGreaterThanOrEqual(4);
    const { rows: logins } = await admin.query<{ id: string }>(
      `SELECT id FROM dashboard_logins WHERE email = $1`,
      [account.email],
    );
    expect(logins.map((row) => row.id)).toEqual([requests[2]!.id]);
    const { rows: sessions } = await admin.query<{ id: string }>(
      `SELECT id FROM dashboard_sessions WHERE account_id = $1`,
      [account.accountId],
    );
    expect(sessions.map((row) => row.id)).toEqual([live]);
  });

  it('takes no instant: it cannot be told to delete what is still counted', async () => {
    const { rows } = await admin.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'dashboard_purge'`,
    );
    expect(rows).toEqual([{ args: '' }]);
  });
});
