/**
 * The two tables of migration 0023, and the one function that reaches past their policy.
 *
 * The generic loop of `rls.test.ts` already proves that both tables behave like every other
 * project table, because both are in `PROJECT_TABLES`. What is proved here is the part that is
 * specific to them: the connection of one project is invisible to another even by name, the
 * `state` is stored only as a digest, the `CHECK` that ties `livemode` to the environment is
 * the database's and not the application's, and `stripe_oauth_state_claim` answers from an
 * empty RLS context, once, and never twice.
 *
 * Everything runs as `bookrail_app`, a role without `BYPASSRLS`. If it were a superuser every
 * assertion below would pass while proving nothing, which is what the first test of
 * `rls.test.ts` exists to rule out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError } from './helpers.js';
import { createProject } from './fixtures.js';

function digest(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}

/** Inserts one API key so that an OAuth state has something to point at. */
async function seedKey(
  admin: Client,
  projectId: string,
  environment: 'test' | 'live',
): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash)
     VALUES ($1, $2, $3, 'secret', 'stripe fixture', $4, encode(sha256($5::bytea), 'hex'))`,
    [id, projectId, environment, id.slice(0, 8), Buffer.from(id, 'utf8')],
  );
  return id;
}

describe('the Stripe connection tables', () => {
  let admin: Client;
  let app: Client;
  let projectA: string;
  let projectB: string;
  let keyA: string;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    projectA = (await createProject(admin, 'Stripe A')).projectId;
    projectB = (await createProject(admin, 'Stripe B')).projectId;
    keyA = await seedKey(admin, projectA, 'test');

    for (const [projectId, account] of [
      [projectA, 'acct_ProjectA'],
      [projectB, 'acct_ProjectB'],
    ] as const) {
      await admin.query(
        `INSERT INTO payment_provider_connections
           (id, project_id, environment, provider, provider_account_id, status, connected_at,
            livemode)
         VALUES ($1, $2, 'test', 'stripe', $3, 'connected', now(), false)`,
        [uuidv7(), projectId, account],
      );
    }
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it('hides the connection of another project, even by account identifier', async () => {
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const { rows } = await app.query<{ provider_account_id: string }>(
        'SELECT provider_account_id FROM payment_provider_connections',
      );
      expect(rows.map((r) => r.provider_account_id)).toEqual(['acct_ProjectA']);

      // The index on (provider, provider_account_id) exists so that an incoming Stripe webhook,
      // which names an account and not a project, can be resolved. It must not become a way of
      // asking "does this account belong to somebody".
      const probe = await app.query(
        "SELECT 1 FROM payment_provider_connections WHERE provider_account_id = 'acct_ProjectB'",
      );
      expect(probe.rows).toHaveLength(0);
    });
  });

  it('shows zero rows from both tables with no RLS context at all', async () => {
    await admin.query(
      `INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                        expires_at)
       VALUES ($1, $2, 'test', sha256($3::bytea), $4, now() + interval '15 minutes')`,
      [uuidv7(), projectA, Buffer.from('context probe', 'utf8'), keyA],
    );
    for (const table of ['payment_provider_connections', 'stripe_oauth_states']) {
      const { rows } = await app.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(rows[0]?.count, `${table} leaked rows without an RLS context`).toBe('0');
    }
    await admin.query('DELETE FROM stripe_oauth_states WHERE project_id = $1', [projectA]);
  });

  it('refuses a connection whose livemode disagrees with its environment', async () => {
    const failure = await expectPgError(
      admin.query(
        `INSERT INTO payment_provider_connections
           (id, project_id, environment, provider, provider_account_id, status, connected_at,
            livemode)
         VALUES ($1, $2, 'live', 'stripe', 'acct_Wrong', 'connected', now(), false)`,
        [uuidv7(), projectA],
      ),
    );
    // 23514 is check_violation: the guarantee is the database's, not the application's, and it
    // holds against the admin connection that bypasses every policy.
    expect(failure.code).toBe('23514');
  });

  it('refuses a provider_account_id that is not an acct_', async () => {
    // The value becomes a `Stripe-Account` header on every later call made for this customer.
    // What it may be is pinned in the one place no writer can skip.
    for (const bad of ['not-an-account', 'acct_', 'acct_with spaces', 'ACCT_Upper']) {
      const failure = await expectPgError(
        admin.query(
          `INSERT INTO payment_provider_connections
             (id, project_id, environment, provider, provider_account_id, status, connected_at,
              livemode)
           VALUES ($1, $2, 'test', 'stripe', $3, 'connected', now(), false)`,
          [uuidv7(), projectB, bad],
        ),
      );
      expect(failure.code, bad).toBe('23514');
    }
  });

  it('refuses a second connection for the same project, environment and provider', async () => {
    const failure = await expectPgError(
      admin.query(
        `INSERT INTO payment_provider_connections
           (id, project_id, environment, provider, provider_account_id, status, connected_at,
            livemode)
         VALUES ($1, $2, 'test', 'stripe', 'acct_Second', 'connected', now(), false)`,
        [uuidv7(), projectA],
      ),
    );
    expect(failure.code).toBe('23505');
  });

  describe('stripe_oauth_state_claim', () => {
    async function insertState(
      projectId: string,
      state: string,
      options: { expired?: boolean; apiKeyId?: string } = {},
    ): Promise<void> {
      await admin.query(
        `INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                          expires_at)
         VALUES ($1, $2, 'test', $3, $4, now() + $5::interval)`,
        [
          uuidv7(),
          projectId,
          digest(state),
          options.apiKeyId ?? keyA,
          options.expired === true ? '-1 second' : '15 minutes',
        ],
      );
    }

    it('answers from an empty RLS context, which is the whole point of it', async () => {
      await insertState(projectA, 'state-empty-context');
      // No `asProject`: this is the callback, which arrives from a browser with no key, so
      // there is no project to pin the transaction to. Every ordinary read of the table from
      // here returns nothing, which the test above proves; this one still answers.
      const { rows } = await app.query<{
        project_id: string;
        environment: string;
        api_key_id: string;
      }>('SELECT project_id, environment, api_key_id FROM stripe_oauth_state_claim($1)', [
        digest('state-empty-context'),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ project_id: projectA, environment: 'test', api_key_id: keyA });
    });

    it('answers once: the second caller gets nothing', async () => {
      await insertState(projectA, 'state-once');
      const first = await app.query('SELECT * FROM stripe_oauth_state_claim($1)', [
        digest('state-once'),
      ]);
      expect(first.rows).toHaveLength(1);
      const second = await app.query('SELECT * FROM stripe_oauth_state_claim($1)', [
        digest('state-once'),
      ]);
      expect(second.rows).toHaveLength(0);
    });

    it('answers nothing for an expired state, and deletes it all the same', async () => {
      await insertState(projectA, 'state-expired', { expired: true });
      const { rows } = await app.query('SELECT * FROM stripe_oauth_state_claim($1)', [
        digest('state-expired'),
      ]);
      expect(rows).toHaveLength(0);
      const left = await admin.query('SELECT 1 FROM stripe_oauth_states WHERE state_hash = $1', [
        digest('state-expired'),
      ]);
      expect(left.rows).toHaveLength(0);
    });

    it('answers nothing when the key that asked has been revoked, and consumes the row', async () => {
      const revoked = await seedKey(admin, projectA, 'test');
      await insertState(projectA, 'state-revoked', { apiKeyId: revoked });
      await admin.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [revoked]);

      const { rows } = await app.query('SELECT * FROM stripe_oauth_state_claim($1)', [
        digest('state-revoked'),
      ]);
      expect(rows).toHaveLength(0);
      // Consumed anyway: a link whose credential has been taken away is not a link to retry.
      const left = await admin.query('SELECT 1 FROM stripe_oauth_states WHERE state_hash = $1', [
        digest('state-revoked'),
      ]);
      expect(left.rows).toHaveLength(0);
    });

    it('answers nothing for a state that never existed', async () => {
      const { rows } = await app.query('SELECT * FROM stripe_oauth_state_claim($1)', [
        digest('never issued'),
      ]);
      expect(rows).toHaveLength(0);
    });

    it.each(['stripe_oauth_state_claim', 'stripe_oauth_states_purge'])(
      '%s is SECURITY DEFINER, pins its search_path, and is executable by the app role alone',
      async (name) => {
        // Both of them, not just the claim. The purge is a definer function too, and it deletes
        // rows of **every** project: the grant is the only thing that scopes it, exactly as for
        // the claim, and `check-db.mjs` asks the same question of both at release time.
        const { rows } = await admin.query<{
          prosecdef: boolean;
          proconfig: string[] | null;
          acl: string[] | null;
          owner: string;
        }>(
          `SELECT p.prosecdef, p.proconfig, p.proacl::text[] AS acl,
                  pg_get_userbyid(p.proowner) AS owner
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = $1`,
          [name],
        );
        expect(rows).toHaveLength(1);
        const fn = rows[0]!;
        expect(fn.prosecdef).toBe(true);
        expect(fn.proconfig ?? []).toContain('search_path=public, pg_temp');
        // An ACL entry is `grantee=PRIVS/grantor`, and an empty grantee is PUBLIC. The set is
        // asserted, not two questions about it: a grant to a third named role (the job role,
        // say) would pass "not PUBLIC" and "granted to the app role" and still be wrong.
        const grantees = (fn.acl ?? []).map((entry) => entry.split('=')[0]);
        expect(grantees.length).toBeGreaterThan(0);
        for (const who of grantees) {
          expect([fn.owner, process.env.APP_DB_ROLE ?? 'bookrail_app']).toContain(who);
        }
      },
    );
  });

  describe('stripe_oauth_states_purge', () => {
    it('deletes the expired states and leaves the live ones', async () => {
      const alive = uuidv7();
      await admin.query(
        `INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                          expires_at)
         VALUES ($1, $2, 'test', sha256($3::bytea), $4, now() + interval '15 minutes'),
                ($5, $2, 'test', sha256($6::bytea), $4, now() - interval '1 hour')`,
        [
          alive,
          projectA,
          Buffer.from('purge alive', 'utf8'),
          keyA,
          uuidv7(),
          Buffer.from('purge dead', 'utf8'),
        ],
      );
      const { rows } = await app.query<{ deleted: number }>(
        'SELECT stripe_oauth_states_purge() AS deleted',
      );
      expect(rows[0]!.deleted).toBeGreaterThanOrEqual(1);
      const left = await admin.query<{ id: string }>(
        'SELECT id FROM stripe_oauth_states WHERE project_id = $1',
        [projectA],
      );
      expect(left.rows.map((r) => r.id)).toEqual([alive]);
    });
  });
});
