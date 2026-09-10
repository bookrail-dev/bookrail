/**
 * `GET /v1/events` and `GET /v1/events/{id}`.
 *
 * The event log is the only read-only resource in the API that nothing writes through HTTP:
 * every row here was written by the transaction that made the change it describes, in the
 * same transaction, and the application role has no `UPDATE` or `DELETE` on the table
 * (migration 0007). So this file has no write path, and there is no way to add one by
 * accident: the database would refuse it.
 *
 * ## The cursor, and the one guarantee it has to keep
 *
 * A log is only useful if a consumer that has read up to a cursor can be sure it will never
 * later find a row it stepped over. `seq` alone does not give that. It is a `bigserial`, so
 * the number is handed out at the `INSERT` and not at the `COMMIT`: two transactions that
 * insert an event each and commit in the opposite order leave a hole below a cursor that has
 * already passed it, and the row surfaces a moment later where nobody will look again.
 * With one request at a time it is invisible; with an API and a worker writing at once (the
 * only shape production has) it is a lost event.
 *
 * So the cursor is `(txid, seq)` and the query carries a **horizon**:
 *
 *  - `txid` (migration 0011) is `pg_current_xact_id()` at the moment of the `INSERT`. It is
 *    handed out in transaction order and never reused, so `(txid, seq)` is a total order
 *    fixed when the row is written, which never rearranges itself afterwards;
 *  - a page returns only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`. Every
 *    transaction below that bound has **finished** (that is what a snapshot's xmin means),
 *    so its rows are visible now or never. Every transaction at or above it is still in
 *    flight, and when it commits its rows carry a higher `txid` and therefore sort *after*
 *    everything already returned.
 *
 * The cost is a latency equal to the longest **write** transaction currently open anywhere in
 * the database: an event written now is not readable until every transaction that started
 * before it has ended. Read-only transactions are never assigned a transaction id and do not
 * hold the horizon back. It is a documented property of the list, and it is the price of the
 * guarantee: the alternative was to keep the promise only in the comment.
 *
 * `seq` stays the tie-break inside one transaction, so the two events of a reschedule come out
 * in the order they were written. It is a **global** sequence, not per project, so a project's
 * values have arbitrary gaps: it is a position, not a count, and is documented as one.
 *
 * The public cursor is still an event id (`starting_after=evt_…`), like every other list, and
 * this route resolves it to its `(txid, seq)`. An id the project cannot see resolves to
 * nothing and yields an empty page, which is the same answer Row Level Security gives
 * everywhere else.
 */
import { Hono } from 'hono';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { events } from '@bookrail/db';
import { errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  inProject,
  listEnvelope,
  paginate,
  parseListParams,
  parseQuery,
  pathId,
  repeatedQuery,
} from '../http.js';
import { eventListQuerySchema } from '../schemas/index.js';
import { serializeEvent } from '../serialize.js';

/**
 * Rows whose writing transaction had certainly finished before this statement began.
 *
 * Written as a fragment rather than inlined at the call site because it is the whole
 * guarantee of the cursor, and a `WHERE` clause that loses one condition in a refactor is how
 * a guarantee quietly stops being one.
 */
const SETTLED = sql`${events.txid}::xid8 < pg_snapshot_xmin(pg_current_snapshot())`;

export function eventsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'event');
    // `type` is the one repeatable filter here, and `c.req.query()` would flatten it to the
    // first value, so the record the schema sees is built by hand for that key only.
    const types = repeatedQuery(c, 'type');
    const filters = parseQuery(c, eventListQuerySchema, {
      ...c.req.query(),
      ...(types.length > 0 ? { type: types } : { type: undefined }),
    });

    const payload = await inProject(c, deps, async (tx) => {
      let after: { txid: string; seq: string } | null = null;
      if (startingAfter !== null) {
        const { rows } = await tx.execute<{ txid: string; seq: string }>(sql`
          SELECT txid::text AS txid, seq::text AS seq FROM events WHERE id = ${startingAfter}
        `);
        // An event of another project, or one that never existed, is invisible through RLS.
        // Answering an empty page rather than a 404 keeps the cursor from confirming whether
        // an identifier exists, which is what every other list here does too.
        const row = rows[0];
        if (row === undefined) return listEnvelope([], false);
        after = row;
      }

      const rows = await tx
        .select()
        .from(events)
        .where(
          and(
            SETTLED,
            after === null
              ? undefined
              : sql`(${events.txid}::xid8, ${events.seq}) > (${after.txid}::xid8, ${after.seq}::bigint)`,
            // One type or several: `?type=booking.created`, or `?type[]=` repeated. An `IN`
            // of one is the same plan as an equality, so there is no branch here.
            filters.type ? inArray(events.type, filters.type) : undefined,
            // `data->>'id'` is the prefixed identifier of the object the event is about, and
            // migration 0011 indexes exactly this expression, with `(txid, seq)` after it:
            // without the index the filter would be a sequential scan of the project's whole
            // history, and without the tail the ordering would be a sort.
            filters.object_id ? sql`${events.data} ->> 'id' = ${filters.object_id}` : undefined,
            filters.from ? gte(events.occurredAt, filters.from) : undefined,
            filters.to ? lt(events.occurredAt, filters.to) : undefined,
          ),
        )
        .orderBy(sql`${events.txid}::xid8, ${events.seq}`)
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(page.map(serializeEvent), hasMore);
    });

    return c.json(payload);
  });

  /**
   * One event by id.
   *
   * Deliberately **not** behind the horizon: the caller already has the identifier, so there
   * is no cursor to step over and nothing to protect. A page is a promise about what comes
   * next; a lookup is a question about one row.
   */
  routes.get('/:id', async (c) => {
    const id = pathId(c, 'event', 'event');
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(events).where(eq(events.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : serializeEvent(row);
    });
    if (!payload) throw errors.notFound('event', c.req.param('id') ?? '');
    return c.json(payload);
  });

  return routes;
}
