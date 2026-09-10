import { bigint, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projectScopeColumns, timestampColumns } from './columns.js';

/**
 * How far the webhook outbox has read the event log of one project and environment.
 *
 * The pair `(lastTxid, lastSeq)` is a position in the total order `(txid, seq)` of `events`,
 * never a count. `seq` alone cannot be a cursor: it is handed out at the `INSERT`, so two
 * transactions committing in the opposite order leave a hole a `seq` cursor steps over and
 * never returns to, which is why the column comes in a pair and why the job only ever reads
 * rows below `pg_snapshot_xmin(pg_current_snapshot())`. Migration 0012 has the argument in
 * full.
 *
 * `lastTxid` is `xid8` in the database and `text` here, like `events.txid`: Drizzle has no
 * such type, and the column is only ever compared in SQL where the ordering is the transaction
 * ordering rather than a lexicographic accident.
 */
export const outboxCursor = pgTable(
  'outbox_cursor',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    lastTxid: text('last_txid').notNull(),
    lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull(),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex('outbox_cursor_scope_uniq').on(t.projectId, t.environment)],
);
