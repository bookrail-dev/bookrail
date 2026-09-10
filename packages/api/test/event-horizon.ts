/**
 * Waiting for the event log to settle: the precondition of every test that reads through the
 * horizon.
 *
 * `GET /v1/events` and the webhook outbox both refuse to look at an event whose transaction id
 * is at or above `pg_snapshot_xmin(pg_current_snapshot())`. That bound is what makes their
 * cursor hole free: `seq` is handed out at the INSERT and not at the COMMIT, so two
 * transactions that write an event each and commit in the opposite order leave a hole below a
 * cursor that has already passed it. Reading only what is below the horizon means every row
 * still in flight will commit with a higher transaction id and therefore sort after everything
 * already read. The documented price is a latency equal to the longest write transaction open
 * anywhere in the database: an event becomes listable, and becomes a delivery, only once every
 * write transaction that started before it has finished.
 *
 * "Anywhere" is the part a test forgets. `pg_snapshot_xmin` is a property of the **cluster**,
 * not of the database: a write transaction open in another test database of the same Postgres,
 * in another package's suite running at the same time, or in an autovacuum worker updating a
 * catalog, holds the horizon back for everybody. So "the booking was written a moment ago,
 * therefore its event is in the list" is not something the product promises, and a test that
 * assumed it was green on an idle machine and red on a busy one, which is the shape of a
 * suite that passes here and fails on a two core runner.
 *
 * This waits for the condition rather than assuming it. It reads the highest transaction id in
 * the log now, and then polls the horizon until it is past that id, at which point one outbox
 * tick converts every one of those events and one list request returns every one of them. It
 * is not a retry of an assertion and not a sleep long enough to usually work: the assertions
 * that follow are unchanged and are still made exactly once, and if the horizon never moves
 * the wait fails with what it was waiting for instead of leaving a mystery.
 */
import { createDatabase, sql } from '@bookrail/db';
import type { Harness } from './harness.js';

/**
 * How long to wait for the horizon before calling it a failure rather than slowness.
 *
 * Deliberately below the 30 s `testTimeout` of this package: a wait that outlived the test it
 * runs inside would be killed by vitest with "test timed out", and the message below, which
 * names the horizon and the transaction it is waiting for, would never be printed. Ten seconds
 * of headroom is enough for the rest of a test to finish reporting.
 */
const SETTLE_TIMEOUT_MS = 20_000;

/** How often to ask. Short enough not to add latency, long enough not to spin on the cluster. */
const SETTLE_POLL_MS = 10;

/**
 * Blocks until every event already committed is below the outbox and event list horizon.
 *
 * Uses the privileged pool on purpose: the question is about the whole log, and the horizon a
 * later tick will use is cross project. That pool is the `DATABASE_URL` superuser both here and
 * on the runner, which is what lets it read every project's rows: Row Level Security is forced
 * on `events` and carries no policy for any role but the application one, so a less privileged
 * connection would see an empty table and this would wait for nothing. The same assumption is
 * already made by `webhook-fixtures.ts` and by the append only check of the delivery suite, and
 * it fails loudly there. Reading the maximum once, before the loop, is what makes this
 * terminate: events written by somebody else after that point are not what the caller is
 * waiting for, and waiting for them too would be waiting for a moving target.
 */
export async function settleEventLog(h: Harness): Promise<void> {
  const admin = createDatabase(h.pools.admin);
  const { rows } = await admin.execute<{ txid: string | null }>(
    sql`SELECT max(txid)::text AS txid FROM events`,
  );
  const target = rows[0]?.txid;
  if (target === undefined || target === null) return;

  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const { rows: seen } = await admin.execute<{ horizon: string }>(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    );
    const horizon = seen[0]?.horizon ?? '0';
    if (BigInt(horizon) > BigInt(target)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `The event log did not settle in ${String(SETTLE_TIMEOUT_MS)} ms: the horizon is ` +
          `${horizon} and the newest event was written by transaction ${target}. Some write ` +
          'transaction has been open in this Postgres cluster for the whole wait, so the ' +
          'outbox and the event list cannot see the tail of the log yet.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}
