/**
 * `bookrail resources blocks <id>`: what is closed on a resource, and when.
 *
 * The read that makes `unblock` usable. A block is created by `POST /v1/resources/{id}/block`
 * and removed by its `blk_…`, which the creation returns once: before this endpoint existed,
 * losing that identifier meant the block could not be removed at all. So this command is not a
 * convenience: it is the other half of an operation that was only half reachable.
 *
 * The default window is "not finished yet", the same default the API applies: somebody looking
 * at a resource's blocks is almost always looking for the one to lift, and that one is in the
 * future. `--from` / `--to` name a window explicitly and turn the default off.
 */
import type { ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { clientFor, integer, optionalInstant } from './helpers.js';

export interface ResourceBlockBody {
  id: string;
  object: string;
  resource_id: string;
  from: string;
  to: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  environment: string;
  created_at: string;
  updated_at: string;
}

export interface BlockListOptions {
  from?: string;
  to?: string;
  limit?: string;
  startingAfter?: string;
  all?: boolean;
}

export async function resourceBlocks(
  ctx: Context,
  id: string,
  options: BlockListOptions,
): Promise<CommandResult> {
  const query = {
    ...(options.from === undefined ? {} : { from: optionalInstant(options.from, 'from') }),
    ...(options.to === undefined ? {} : { to: optionalInstant(options.to, 'to') }),
  };
  const client = await clientFor(ctx);
  const path = `/v1/resources/${encodeURIComponent(id)}/blocks`;

  let rows: ResourceBlockBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<ResourceBlockBody>(path, { query });
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<ResourceBlockBody>>(path, {
      query: { ...query, limit, starting_after: options.startingAfter },
    });
    rows = response.data.data;
    hasMore = response.data.has_more;
  }

  const cursor = hasMore ? (rows.at(-1)?.id ?? null) : null;
  return {
    data: { object: 'list', data: rows, has_more: hasMore, next_cursor: cursor },
    human:
      rows.length === 0
        ? `${ctx.presenter.badge()} no blocks on ${id}${options.from === undefined && options.to === undefined ? ' that have not already ended' : ''}.`
        : [
            `${ctx.presenter.badge()} ${String(rows.length)} block(s) on ${id}`,
            '',
            renderTable(
              // UTC only, unlike every other table here: a `resource_block` carries no
              // `timezone` field, and guessing one from the resource would be a second answer
              // to a question the object does not answer.
              ['id', 'from (UTC)', 'to (UTC)', 'reason'],
              rows.map((row) => [row.id, row.from, row.to, truncate(text(row.reason), 40)]),
            ),
          ].join('\n'),
    nextSteps:
      rows.length === 0
        ? ['Add one: `bookrail resources blocks` reads what `POST /v1/resources/{id}/block` wrote.']
        : [
            `Lift one: the API call is \`POST /v1/resources/${id}/unblock\` with { "block_id": "${rows[0]?.id ?? 'blk_...'}" }.`,
            ...(cursor === null
              ? []
              : [`Next page: \`bookrail resources blocks ${id} --starting-after ${cursor}\`.`]),
          ],
  };
}
