/**
 * Cleaning up after a webhook suite.
 *
 * The API suites share one database, and `jobs.test.ts` and `transition-jobs.test.ts` start a
 * **real** pg-boss worker in it. That worker now carries the webhook outbox and the delivery
 * sweep, both cross-project by design, so endpoints left `active` by a finished suite, pointing
 * at a `node:http` server that has since closed, become a stream of failing deliveries
 * underneath a test that is measuring something else entirely.
 *
 * The same shape of problem as the known one about `runHoldExpiry`
 * sweeping every project of the test database: a cross-project job and a shared fixture. The
 * answer is the same one: leave nothing behind.
 */
import { createDatabase, sql } from '@bookrail/db';
import type { Harness } from './harness.js';

export async function quiesceWebhooks(h: Harness): Promise<void> {
  const adminDb = createDatabase(h.pools.admin);
  await adminDb.execute(sql`UPDATE webhooks SET status = 'disabled' WHERE status <> 'disabled'`);
  await adminDb.execute(sql`
    UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL
     WHERE status = 'pending'
  `);
}
