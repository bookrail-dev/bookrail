/**
 * `bookrail-plan`, the command that moves an account between plans.
 *
 * The command line is tested directly, because it is where an operator's typo would otherwise
 * become the wrong plan on the wrong account. The change is tested by running the real entry
 * point as a child process against the test database, which is also what proves that importing
 * the module changes nothing and that running it does.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resolveDatabaseUrls } from '@bookrail/db';
import { encodeId, uuidv7 } from '@bookrail/shared';
import { parsePlanArgs } from '../src/plan-main.js';
import { TEST_DB_NAME } from './db-name.js';

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL('../src/plan-main.ts', import.meta.url));

async function plan(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  return run(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: urls.admin,
      DATABASE_ADMIN_URL: urls.admin,
      NODE_ENV: 'production',
    },
  });
}

describe('parsePlanArgs', () => {
  const id = '0190f2a1-7c3e-7d4b-8a9f-0123456789ab';

  it('takes an account, written either way, a plan, and --force', () => {
    expect(parsePlanArgs([id, 'pro'])).toEqual({ accountId: id, plan: 'pro', force: false });
    expect(parsePlanArgs([encodeId('account', id), 'Scale'])).toEqual({
      accountId: id,
      plan: 'scale',
      force: false,
    });
    expect(parsePlanArgs([id, 'enterprise', '--force'])).toEqual({
      accountId: id,
      plan: 'enterprise',
      force: true,
    });
  });

  it('refuses anything that is not exactly an account and a known plan', () => {
    expect(() => parsePlanArgs([])).toThrow(/Usage/);
    expect(() => parsePlanArgs([id])).toThrow(/Usage/);
    expect(() => parsePlanArgs([id, 'pro', 'now'])).toThrow(/Usage/);
    expect(() => parsePlanArgs([id, 'pro', '--force', '--force'])).toThrow(/Usage/);
    expect(() => parsePlanArgs([id, 'gold'])).toThrow(/not a plan/);
    expect(() => parsePlanArgs(['proj_0190f2a17c3e7d4b8a9f0123456789ab', 'pro'])).toThrow(
      /not an account id/,
    );
  });
});

describe('the bookrail-plan command', () => {
  let client: Client;
  const accountId = uuidv7();

  beforeAll(async () => {
    client = new Client({
      connectionString: resolveDatabaseUrls({ databaseName: TEST_DB_NAME }).admin,
    });
    await client.connect();
    await client.query(
      `INSERT INTO accounts (id, name, api_version) VALUES ($1, 'Plan probe', '2026-09-01')`,
      [accountId],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it('changes the plan and prints one line saying from what to what', async () => {
    const { stdout } = await plan([encodeId('account', accountId), 'pro']);
    const line = JSON.parse(stdout) as Record<string, string>;
    expect(line).toMatchObject({
      msg: 'plan_changed',
      account_id: encodeId('account', accountId),
      account_name: 'Plan probe',
      from: 'free',
      to: 'pro',
    });
    const { rows } = await client.query<{ plan: string }>(
      'SELECT plan FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0]?.plan).toBe('pro');

    // The same plan again is said, not hidden.
    const again = JSON.parse((await plan([accountId, 'pro'])).stdout) as Record<string, string>;
    expect(again.msg).toBe('plan_unchanged');
  }, 60_000);

  it('writes plan.changed, reason admin, in the live log of every project of the account', async () => {
    const account = uuidv7();
    const projects = [uuidv7(), uuidv7()];
    await client.query(
      `INSERT INTO accounts (id, name, api_version) VALUES ($1, 'Plan events', '2026-09-01')`,
      [account],
    );
    for (const project of projects) {
      await client.query(`INSERT INTO projects (id, account_id, name) VALUES ($1, $2, 'P')`, [
        project,
        account,
      ]);
    }
    await plan([account, 'enterprise']);
    for (const project of projects) {
      const { rows } = await client.query<{
        environment: string;
        data: Record<string, unknown>;
        actor: unknown;
      }>(
        `SELECT environment, data, actor FROM events WHERE project_id = $1 AND type = 'plan.changed'`,
        [project],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        environment: 'live',
        data: {
          object: 'plan_change',
          account_id: encodeId('account', account),
          from: 'free',
          to: 'enterprise',
          reason: 'admin',
        },
        actor: { type: 'system', id: null },
      });
    }
    // Unchanged writes nothing.
    await plan([account, 'enterprise']);
    const { rows } = await client.query(
      `SELECT 1 FROM events WHERE project_id = $1 AND type = 'plan.changed'`,
      [projects[0]],
    );
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('refuses an account with a live subscription, and changes it anyway with --force', async () => {
    const account = uuidv7();
    await client.query(
      `INSERT INTO accounts (id, name, api_version, plan, stripe_customer_id)
       VALUES ($1, 'Subscribed', '2026-09-01', 'pro', $2)`,
      [account, `cus_Plan${account.replace(/-/g, '')}`],
    );
    await client.query(
      `INSERT INTO billing_subscriptions (account_id, stripe_subscription_id, plan, status)
       VALUES ($1, $2, 'pro', 'active')`,
      [account, `sub_Plan${account.replace(/-/g, '')}`],
    );
    const refused = await plan([account, 'scale']).catch(
      (error: unknown) => error as { code: number; stderr: string },
    );
    expect((refused as { code: number }).code).toBe(1);
    expect((refused as { stderr: string }).stderr).toContain('active Stripe subscription');
    expect((refused as { stderr: string }).stderr).toContain('--force');
    const unchanged = await client.query<{ plan: string }>(
      'SELECT plan FROM accounts WHERE id = $1',
      [account],
    );
    expect(unchanged.rows[0]?.plan).toBe('pro');

    const forced = JSON.parse((await plan([account, 'scale', '--force'])).stdout) as Record<
      string,
      string
    >;
    expect(forced).toMatchObject({
      msg: 'plan_changed',
      from: 'pro',
      to: 'scale',
      forced_over_subscription: `sub_Plan${account.replace(/-/g, '')}`,
    });
  }, 60_000);

  it('fails with a message, and changes nothing, for an account that does not exist', async () => {
    const missing = uuidv7();
    const failure = await plan([missing, 'scale']).catch(
      (error: unknown) => error as { code: number; stderr: string },
    );
    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stderr: string }).stderr).toContain(
      `No account ${encodeId('account', missing)}`,
    );
    expect((failure as { stderr: string }).stderr).not.toContain('    at ');
  }, 60_000);
});
