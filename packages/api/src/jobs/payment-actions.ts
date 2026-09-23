/**
 * The calls Bookrail owes Stripe, made outside every transaction.
 *
 * A cancellation and an automatic expiry both have a consequence at the provider: an intent
 * nobody will pay has to be cancelled, and a refund the policy promised has to be created.
 * Neither can happen inside the transaction that decided it. That transaction holds advisory
 * locks on every candidate resource of the service (`create.ts`), and a Postgres transaction
 * that waits on somebody else's network holds those locks for as long as the network takes: ten
 * seconds of Stripe being slow would be ten seconds in which nobody can book that court.
 *
 * So the decision writes an **intention** on the `payments` row, in the same transaction as the
 * state change (`pending_action`, migration 0024), and this drains it. The two halves cannot
 * come apart: a cancellation that committed always has its refund queued, and a worker that
 * dies between two calls finds the same rows on its next tick.
 *
 * ## The shape of one tick
 *
 * `pending_action_scopes` (a `SECURITY DEFINER` function, because *which* projects have work is
 * a cross project question Row Level Security makes unanswerable to the application role) gives
 * the scopes; then, per scope and inside `withProjectContext`, a `SELECT ... FOR UPDATE SKIP
 * LOCKED` of at most {@link MAX_ACTIONS_PER_SCOPE} rows, and for each one the call is made
 * **after** that transaction has closed. Two workers therefore never make the same call: the
 * loser of `SKIP LOCKED` simply does not see the row.
 *
 * ## The ladder, and the end of it
 *
 * A failure is `pending_action_attempts + 1` and a wait of `2^attempts x 10s`, capped at an
 * hour. After {@link MAX_ATTEMPTS} the row keeps its action and loses its
 * `pending_action_next_at`, which takes it out of the queue for good, and one line is logged at
 * `error`.
 *
 * **That is the whole meaning of a NULL in that column, and it is why the selection below asks
 * for `IS NOT NULL`.** Whoever queues an action writes the instant of its own transaction, so a
 * row that is waiting always carries one. If NULL also meant "due now", as it briefly did, an
 * exhausted row would be selected again on the next tick, retried, exhausted again, and logged
 * again, six times a minute for ever: a storm of calls against another company's rate limit and
 * a log nobody could read any more.
 *
 * **Nothing watches for that line**: there is no alerting in this deployment, so a refund that
 * has failed twenty times is a refund a person has to notice. That gap is recorded as known
 * debt rather than left as a surprise.
 */
import { sql, withProjectContext } from '@bookrail/db';
import { encodeId, type Environment } from '@bookrail/shared';
import type { AppDeps } from '../context.js';
import { StripeApiError, StripeUnreachableError } from '../stripe/client.js';
import { stripePlatform } from '../stripe/platform.js';

/** How many (project, environment) pairs one tick takes on. The same cap as the other sweeps. */
export const MAX_ACTION_SCOPES_PER_TICK = 200;

/** How many rows one scope's tick drains. Keeps a tick, and a backlog, bounded. */
export const MAX_ACTIONS_PER_SCOPE = 50;

/** After this many failures the row leaves the queue and waits for a person. */
export const MAX_ATTEMPTS = 20;

/** The first rung, doubled each time. `2^1 x 10s` is twenty seconds. */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(1, attempts), BACKOFF_CAP_MS);
}

export interface PaymentActionsReport {
  scopes: number;
  /** Calls that reached Stripe and were accepted, or were already in the state asked for. */
  done: number;
  /** Calls that failed and were put back on the ladder. */
  retried: number;
  /** Rows that ran out of attempts on this tick. */
  exhausted: number;
}

interface ActionRow {
  id: string;
  action: 'cancel_intent' | 'create_refund';
  attempts: number;
  type: string;
  amount: number;
  currency: string;
  providerAccountId: string;
  providerPaymentId: string | null;
  parentIntentId: string | null;
  bookingId: string | null;
  /** `unreachable` marks a row whose intent may exist although we never learned its identifier. */
  failureCode: string | null;
  /** The parent's figures, read in the same statement so the refund can be recomputed now. */
  parentAmount: number | null;
  parentAmountRefunded: number | null;
}

async function actionScopes(
  deps: Pick<AppDeps, 'db'>,
  now: number,
): Promise<{ projectId: string; environment: Environment }[]> {
  const { rows } = await deps.db.execute<{ project_id: string; environment: Environment }>(sql`
    SELECT project_id, environment
      FROM pending_action_scopes(${new Date(now).toISOString()}::timestamptz,
                                 ${MAX_ACTION_SCOPES_PER_TICK})
  `);
  return rows.map((row) => ({ projectId: row.project_id, environment: row.environment }));
}

/**
 * The rows this tick will act on, claimed and released.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two workers safe, and the transaction is closed before
 * a single call is made: holding a row lock across an HTTP request to another company would be
 * the same mistake, one table down, that this whole job exists to avoid.
 *
 * A refund carries the intent of its **parent**, because that is what Stripe is asked to refund:
 * the child row's own `provider_payment_id` is the `re_...` it will be given, and it is empty
 * until the call succeeds.
 */
async function claimActions(
  deps: Pick<AppDeps, 'db'>,
  scope: { projectId: string; environment: Environment },
  now: number,
): Promise<ActionRow[]> {
  return withProjectContext(deps.db, scope, async (tx) => {
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      SELECT p.id, p.pending_action, p.pending_action_attempts, p.type, p.amount, p.currency,
             p.provider_account_id, p.provider_payment_id, p.booking_id, p.failure_code,
             parent.provider_payment_id AS parent_intent_id,
             parent.amount AS parent_amount,
             parent.amount_refunded AS parent_amount_refunded
        FROM payments p
        LEFT JOIN payments parent ON parent.id = p.parent_payment_id
       WHERE p.pending_action IS NOT NULL
         AND p.pending_action_next_at IS NOT NULL
         AND p.pending_action_next_at <= ${new Date(now).toISOString()}::timestamptz
       ORDER BY p.pending_action_next_at, p.created_at, p.id
       LIMIT ${MAX_ACTIONS_PER_SCOPE}
         FOR UPDATE OF p SKIP LOCKED
    `);
    return rows.map((row) => ({
      id: row.id as string,
      action: row.pending_action as 'cancel_intent' | 'create_refund',
      attempts: Number(row.pending_action_attempts),
      type: row.type as string,
      amount: Number(row.amount),
      currency: row.currency as string,
      providerAccountId: row.provider_account_id as string,
      providerPaymentId: (row.provider_payment_id as string | null) ?? null,
      parentIntentId: (row.parent_intent_id as string | null) ?? null,
      bookingId: (row.booking_id as string | null) ?? null,
      failureCode: (row.failure_code as string | null) ?? null,
      parentAmount: row.parent_amount === null ? null : Number(row.parent_amount),
      parentAmountRefunded:
        row.parent_amount_refunded === null ? null : Number(row.parent_amount_refunded),
    }));
  });
}

/**
 * Clears the action: the call is made, or there was nothing left to do.
 *
 * `set` carries the columns that change with it. Two of them are not text, and a bound
 * parameter has to say so or Postgres refuses the assignment, so the cast belongs to the column
 * rather than to the caller: `amount` is an integer and `metadata` is `jsonb`.
 */
async function clearAction(
  deps: Pick<AppDeps, 'db'>,
  scope: { projectId: string; environment: Environment },
  id: string,
  set: Record<string, string | null>,
  now: number,
): Promise<void> {
  const assignments = Object.entries(set).map(([column, value]) => {
    if (column === 'amount') return sql`${sql.identifier(column)} = ${value}::integer`;
    if (column === 'metadata') return sql`${sql.identifier(column)} = ${value}::jsonb`;
    return sql`${sql.identifier(column)} = ${value}`;
  });
  await withProjectContext(deps.db, scope, (tx) =>
    tx.execute(sql`
      UPDATE payments
         SET pending_action = NULL, pending_action_next_at = NULL, pending_action_error = NULL,
             updated_at = ${new Date(now).toISOString()}::timestamptz
             ${assignments.length === 0 ? sql`` : sql`, ${sql.join(assignments, sql`, `)}`}
       WHERE id = ${id}
    `),
  );
}

/** Puts the row back on the ladder, or takes it off the queue for good. */
async function failAction(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  scope: { projectId: string; environment: Environment },
  row: ActionRow,
  reason: string,
  now: number,
): Promise<'retried' | 'exhausted'> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const nextAt = exhausted ? null : new Date(now + backoffMs(attempts)).toISOString();
  await withProjectContext(deps.db, scope, (tx) =>
    tx.execute(sql`
      UPDATE payments
         SET pending_action_attempts = ${attempts},
             pending_action_next_at = ${nextAt}::timestamptz,
             pending_action_error = ${reason.slice(0, 200)},
             updated_at = ${new Date(now).toISOString()}::timestamptz
       WHERE id = ${row.id}
    `),
  );
  if (exhausted) {
    // The one line in this file at `error`, and the one case nothing else will ever pick up:
    // the row still says what it owes, and no tick will select it again.
    deps.logger.error('payment_action_exhausted', {
      project_id: encodeId('project', scope.projectId),
      environment: scope.environment,
      payment_id: encodeId('payment', row.id),
      action: row.action,
      attempts,
      error_code: reason,
    });
  }
  return exhausted ? 'exhausted' : 'retried';
}

/**
 * One tick: every scope with work, and every row of each, up to the caps.
 *
 * Nothing here throws on a failure of one payment. The sweep is idempotent (a row whose call
 * succeeded no longer has an action), so the right answer to one project's problem is a log
 * line and the next project, not a tick that abandons the estate.
 */
export async function runPaymentActions(
  deps: Pick<AppDeps, 'db' | 'logger' | 'stripe'>,
  options: { now?: number } = {},
): Promise<PaymentActionsReport> {
  const now = options.now ?? Date.now();
  const report: PaymentActionsReport = { scopes: 0, done: 0, retried: 0, exhausted: 0 };

  for (const scope of await actionScopes(deps, now)) {
    report.scopes += 1;
    let client;
    try {
      client = stripePlatform(deps.stripe, scope.environment).client;
    } catch {
      // The deployment is not a platform in this environment any more: the keys were taken off
      // between the queueing and now. Nothing can be called, and nothing is written: the rows
      // stay queued and a deployment that puts its keys back drains them.
      deps.logger.warn('payment_actions_not_configured', {
        project_id: encodeId('project', scope.projectId),
        environment: scope.environment,
      });
      continue;
    }

    let rows: ActionRow[];
    try {
      rows = await claimActions(deps, scope, now);
    } catch (error) {
      deps.logger.warn('payment_actions_scan_failed', {
        project_id: encodeId('project', scope.projectId),
        environment: scope.environment,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const row of rows) {
      try {
        if (row.action === 'cancel_intent') {
          let intentId = row.providerPaymentId;
          if (intentId === null && row.failureCode === 'unreachable') {
            // The creation timed out, so we never learned whether an intent exists. Replaying
            // the creation under the **same** `Idempotency-Key` is the question "which world is
            // this": Stripe answers with the intent the lost call made, or makes one now. Either
            // way the identifier comes back and the cancellation below closes it. An intent
            // created here is never payable, because no `client_secret` leaves this process.
            const replayed = await client.createPaymentIntent({
              stripeAccount: row.providerAccountId,
              idempotencyKey: encodeId('payment', row.id),
              amount: row.amount,
              currency: row.currency,
              metadata: { bookrail_payment_id: encodeId('payment', row.id) },
            });
            intentId = replayed.id;
            deps.logger.warn('payment_action_intent_recovered', {
              project_id: encodeId('project', scope.projectId),
              environment: scope.environment,
              payment_id: encodeId('payment', row.id),
            });
          }
          if (intentId === null) {
            // Nothing was ever created, so there is nothing to cancel. The row is closed here
            // rather than queued for ever against a call with no subject.
            await clearAction(deps, scope, row.id, { status: 'cancelled' }, now);
            report.done += 1;
            continue;
          }
          await client.cancelPaymentIntent({
            stripeAccount: row.providerAccountId,
            id: intentId,
          });
          await clearAction(
            deps,
            scope,
            row.id,
            { status: 'cancelled', provider_payment_id: intentId },
            now,
          );
          report.done += 1;
          continue;
        }

        // create_refund
        const intent = row.parentIntentId;
        if (intent === null) {
          // A refund of a payment that never reached Stripe. There is nothing to give back,
          // because nothing was taken.
          await clearAction(deps, scope, row.id, { status: 'cancelled' }, now);
          report.done += 1;
          continue;
        }
        // The amount is recomputed **here**, against what the parent says right now, and not
        // taken as written at the time of the cancellation. Between the two instants the
        // customer may have refunded part of the charge from their own Stripe dashboard: the
        // receiver raises the parent's `amount_refunded` and deliberately leaves this row
        // alone, so an amount frozen earlier would now exceed what the charge still has, Stripe
        // would refuse it, and the residue actually owed would never go back. Same arithmetic
        // as the queueing, applied at the moment of the call.
        const refundable =
          row.parentAmount === null || row.parentAmountRefunded === null
            ? row.amount
            : row.parentAmount - row.parentAmountRefunded;
        const amount = Math.min(row.amount, refundable);
        if (amount <= 0) {
          // Somebody else gave back everything this row was for. Nothing to ask, and the row
          // says why rather than disappearing into `cancelled` without a reason.
          await clearAction(
            deps,
            scope,
            row.id,
            {
              status: 'cancelled',
              metadata: JSON.stringify({ origin: 'policy', reason: 'already_refunded' }),
            },
            now,
          );
          report.done += 1;
          continue;
        }
        const refund = await client.createRefund({
          stripeAccount: row.providerAccountId,
          idempotencyKey: encodeId('payment', row.id),
          paymentIntent: intent,
          amount,
          metadata: { bookrail_payment_id: encodeId('payment', row.id) },
        });
        // The status stays `pending`: what makes a refund succeeded here is `charge.refunded`,
        // verified, like every other change to a money column. What this call earns the row is
        // its identifier, and its `amount` if the recomputation above lowered it, so that the
        // row says what was actually asked for and `charge.refunded` can still match it.
        await clearAction(
          deps,
          scope,
          row.id,
          {
            provider_payment_id: refund.id === '' ? null : refund.id,
            ...(amount === row.amount ? {} : { amount: String(amount) }),
          },
          now,
        );
        report.done += 1;
      } catch (error) {
        if (!(error instanceof StripeApiError) && !(error instanceof StripeUnreachableError)) {
          throw error;
        }
        const settled = await settleStripeFailure(deps, scope, row, error, now);
        if (settled === 'done') report.done += 1;
        else if (settled === 'exhausted') report.exhausted += 1;
        else report.retried += 1;
      }
    }
  }
  return report;
}

/**
 * What a refusal from Stripe means for this row.
 *
 * Two refusals are not failures at all, and telling them apart is the whole of this function:
 *
 *  * an intent Stripe already considers `canceled` is the state that was asked for, so the row
 *    is closed as done;
 *  * an intent that has already **succeeded** cannot be cancelled, and that is not an error
 *    either: it means the customer paid in the window between the cancellation and this call.
 *    The row is left alone, with no action and no ladder, because
 *    `payment_intent.succeeded` is already on its way and the receiver will queue the full
 *    refund that the situation actually calls for. Logged at `warn`, because it is a race that
 *    resolved itself and somebody reading the log should be able to see that it happened.
 *
 * **How the two are told apart.** Stripe attaches the PaymentIntent to an error about one, so
 * the answer is `error.paymentIntentStatus`, a documented enum. The earlier form of this
 * function read the English of `error.message` instead, which works until Stripe rewrites a
 * sentence it never promised to keep. The prose is still consulted, but only as a fallback for
 * the case where the object is absent, and the order matters there: the real message for an
 * intent that has succeeded also contains the word "cancel".
 *
 * Everything else goes on the ladder.
 */
async function settleStripeFailure(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  scope: { projectId: string; environment: Environment },
  row: ActionRow,
  error: StripeApiError | StripeUnreachableError,
  now: number,
): Promise<'done' | 'left' | 'retried' | 'exhausted'> {
  const code = error instanceof StripeApiError ? (error.code ?? error.type) : error.reason;
  if (row.action === 'cancel_intent' && error instanceof StripeApiError) {
    const message = error.message.toLowerCase();
    const intentStatus = error.paymentIntentStatus;
    // The documented enum when Stripe sent the object, the prose only when it did not.
    const alreadySucceeded =
      intentStatus === undefined ? message.includes('succeeded') : intentStatus === 'succeeded';
    const alreadyCancelled =
      intentStatus === undefined ? message.includes('cancel') : intentStatus === 'canceled';
    if (code === 'payment_intent_unexpected_state' && alreadySucceeded) {
      deps.logger.warn('payment_action_intent_already_succeeded', {
        project_id: encodeId('project', scope.projectId),
        environment: scope.environment,
        payment_id: encodeId('payment', row.id),
      });
      await withProjectContext(deps.db, scope, (tx) =>
        tx.execute(sql`
          UPDATE payments
             SET pending_action = NULL, pending_action_next_at = NULL,
                 pending_action_error = NULL,
                 updated_at = ${new Date(now).toISOString()}::timestamptz
           WHERE id = ${row.id}
        `),
      );
      return 'left';
    }
    if (code === 'payment_intent_unexpected_state' && alreadyCancelled) {
      await clearAction(deps, scope, row.id, { status: 'cancelled' }, now);
      return 'done';
    }
  }
  return failAction(deps, scope, row, code, now);
}
