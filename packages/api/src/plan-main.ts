/* eslint-disable no-console */
/**
 * `bookrail-plan`: changes the plan of one account, from a shell on the machine that owns the
 * database.
 *
 *   bookrail-plan acct_0190f... enterprise
 *   bookrail-plan 0190f...-...  free
 *   bookrail-plan acct_0190f... pro --force
 *
 * Since plans are bought through Stripe Billing, the plan of an account with a subscription is
 * the plan of its subscription, and it changes when a signed Stripe event says so. This command is
 * what is left for everything else: the Enterprise plan, which is a contract and never goes
 * through a checkout, and the corrections an operator has to make by hand. On an account with a
 * live subscription it **refuses**, unless `--force` is given, because the next event of the
 * subscription would write the plan of the subscription back and silently undo the change; the
 * refusal says so, and says that the subscription is changed in the Stripe dashboard.
 *
 * Like a change made by an event, a change made here writes one `plan.changed` event (reason
 * `admin`) in the live log of every project of the account, in the same transaction.
 *
 * The connection string is read from the environment (`DATABASE_URL`, or `DATABASE_ADMIN_URL`),
 * like `bookrail-bootstrap`: a deployment supplies it on standard input from the same root only
 * file its migrations use. Nothing is passed on the command line except the account, the plan
 * and the flag.
 *
 * The change applies to the next request: the plan is read by the key lookup on every request and
 * by the booking transaction inside the transaction that decides, so there is no cache to empty
 * and no process to restart.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase, createPool, resolveDatabaseUrls, sql, type Database } from '@bookrail/db';
import { PLAN_IDS, decodeId, encodeId, isPlanId, type PlanId } from '@bookrail/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ParsedPlanArgs {
  /** Bare UUID of the account. */
  accountId: string;
  plan: PlanId;
  /** Change the plan even though the account has a live subscription. */
  force: boolean;
}

/**
 * `<account> <plan> [--force]`, nothing else. The account may be written as the API writes it
 * (`acct_` and thirty-two hex digits) or as the database stores it (a UUID), because an operator
 * has whichever of the two the place they found it printed.
 */
export function parsePlanArgs(argv: readonly string[]): ParsedPlanArgs {
  const usage = `Usage: bookrail-plan <account id> <${PLAN_IDS.join('|')}> [--force]`;
  const force = argv.includes('--force');
  const positional = argv.filter((arg) => arg !== '--force');
  if (positional.length !== 2 || argv.length - positional.length > 1) throw new Error(usage);
  const [rawAccount, rawPlan] = positional as [string, string];
  const account = rawAccount.trim().toLowerCase();
  const accountId = UUID_RE.test(account) ? account : decodeId('account', account);
  if (accountId === null) {
    throw new Error(
      `"${rawAccount}" is not an account id: expected acct_ and 32 hex digits, or a UUID.\n${usage}`,
    );
  }
  const plan = rawPlan.trim().toLowerCase();
  if (!isPlanId(plan)) {
    throw new Error(
      `"${rawPlan}" is not a plan: expected one of ${PLAN_IDS.join(', ')}.\n${usage}`,
    );
  }
  return { accountId, plan, force };
}

export interface PlanChange {
  msg: 'plan_changed' | 'plan_unchanged';
  account_id: string;
  account_name: string;
  from: PlanId;
  to: PlanId;
  at: string;
  /** Present when the change was forced over a live subscription. */
  forced_over_subscription?: string;
}

/**
 * The update, in one transaction: the account row locked `FOR UPDATE` (so two operators changing
 * the same account at once produce two lines that agree about the order), the subscription read
 * under the same lock, the plan written, and the `plan.changed` events written by the same
 * function the Billing events use.
 */
export async function changePlan(db: Database, args: ParsedPlanArgs): Promise<PlanChange> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ name: string; plan: string; at: string }>(sql`
      SELECT name, plan, now()::text AS at FROM accounts WHERE id = ${args.accountId} FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`No account ${encodeId('account', args.accountId)}.`);
    }
    // A live subscription is what `billing_subscription_is_live` says it is: the one definition,
    // which the receiver, the dashboard and the jobs ask too. Its next event would write the
    // plan back.
    const { rows: subscriptions } = await tx.execute<{
      stripe_subscription_id: string;
      status: string;
      plan: string;
      live: boolean;
    }>(sql`
      SELECT stripe_subscription_id, status, plan, billing_subscription_is_live(status) AS live
        FROM billing_subscriptions
       WHERE account_id = ${args.accountId}
    `);
    const subscription = subscriptions[0];
    const live = subscription !== undefined && subscription.live;
    if (live && !args.force) {
      throw new Error(
        `Account ${encodeId('account', args.accountId)} has a ${subscription.status} Stripe subscription ` +
          `(${subscription.stripe_subscription_id}, plan ${subscription.plan}). Its plan follows the ` +
          'subscription, and the next event of it would write that plan back over this change. Change ' +
          'the subscription in the Stripe dashboard instead, or run again with --force to change the ' +
          'plan anyway, knowing it lasts until the next event.',
      );
    }
    const from = isPlanId(row.plan) ? row.plan : 'free';
    const at = new Date(row.at).toISOString();
    if (from !== args.plan) {
      await tx.execute(sql`
        UPDATE accounts SET plan = ${args.plan}, updated_at = now() WHERE id = ${args.accountId}
      `);
      await tx.execute(sql`
        SELECT billing_write_plan_changed(${args.accountId}::uuid, ${from}, ${args.plan}, 'admin',
                                          ${at}::timestamptz, '{"type": "system", "id": null}'::jsonb)
      `);
    }
    return {
      msg: from === args.plan ? 'plan_unchanged' : 'plan_changed',
      account_id: encodeId('account', args.accountId),
      account_name: row.name,
      from,
      to: args.plan,
      at,
      ...(live && subscription !== undefined
        ? { forced_over_subscription: subscription.stripe_subscription_id }
        : {}),
    };
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parsePlanArgs(argv);
  const urls = resolveDatabaseUrls();
  const pool = createPool({ connectionString: urls.admin, max: 1 });
  try {
    console.log(JSON.stringify(await changePlan(createDatabase(pool), args)));
  } finally {
    await pool.end();
  }
}

/** Only when this file is what was executed; see the same guard in `bootstrap-main.ts`. */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
