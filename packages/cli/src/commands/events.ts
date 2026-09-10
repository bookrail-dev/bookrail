/**
 * `bookrail events list [--follow]` and `bookrail events get`: the project's event log.
 *
 * ## How `--follow` follows
 *
 * The log's order is `(txid, seq)` and a page returns only rows whose writing transaction has
 * certainly finished (`packages/api/src/routes/events.ts`). That is what makes the cursor safe:
 * a consumer that has read up to a position can never later be handed a row it stepped over.
 * The *public* handle on that position is still an event id (`starting_after=evt_...`, which
 * the route resolves to its `(txid, seq)`), so following is a loop over `starting_after`, not
 * over timestamps, and it inherits the guarantee rather than approximating it.
 *
 * The one place a timestamp is used is the **start**: "from now on" has no event id, so the
 * first request of a `--follow` with no `--starting-after` carries `from = now` and the cursor
 * takes over as soon as the first event arrives. The gap that leaves is real and small: an
 * event whose `occurred_at` is a moment before the command started but whose transaction
 * commits after it will be filtered out by `from`. Pass `--from` explicitly, or
 * `--starting-after`, when that matters. Replaying is always safe, since the ordering is
 * total.
 *
 * A page that comes back full is followed immediately instead of after `--interval`: a burst
 * must not take `pages × interval` seconds to drain.
 *
 * ## Why a bound is required with `--json`
 *
 * `--json` promises one envelope, `{ ok, environment, data, ... }`, and a follow that never
 * ends would print it never. So `--follow --json` requires `--max` or `--duration` and says so;
 * without `--json` the events stream as they arrive and Ctrl-C ends it, which is what a human
 * follow is for.
 */
import type { ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import { clientFor, commaList, integer, optionalInstant, sleep } from './helpers.js';

export interface EventBody {
  id: string;
  object: string;
  type: string;
  occurred_at: string;
  api_version: string;
  seq: number;
  /** `via` is present only when the writer sent `Bookrail-Actor`. */
  actor: { type: string; id: string | null; via?: string } | null;
  data: { object: Record<string, unknown> | null; previous: Record<string, unknown> | null };
  environment: string;
  created_at: string;
}

export interface EventListOptions {
  type?: string[];
  objectId?: string;
  from?: string;
  to?: string;
  limit?: string;
  startingAfter?: string;
  all?: boolean;
  follow?: boolean;
  interval?: string;
  duration?: string;
  max?: string;
}

export const DEFAULT_FOLLOW_INTERVAL_SECONDS = 2;

function eventRows(events: EventBody[]): string[][] {
  return events.map((event) => [
    event.id,
    event.type,
    event.occurred_at,
    text(event.actor?.type),
    truncate(text(event.data.object?.id ?? ''), 26),
  ]);
}

function eventLine(event: EventBody): string {
  const subject = text(event.data.object?.id ?? '');
  return `${event.occurred_at}  ${event.type.padEnd(22)} ${subject}`;
}

/**
 * The filters the API takes.
 *
 * `type` is repeatable server-side (`?type[]=a&type[]=b`), so every value the
 * caller gave goes into the request. The CLI used to ask for everything and filter the
 * pages locally when there was more than one type. Correct, but it moved rows across the
 * network only to throw them away, and with `--follow` it did so for ever.
 */
function buildQuery(options: EventListOptions): EventQuery {
  const types = commaList(options.type);
  return {
    ...(types !== undefined && types.length > 0 ? { type: types } : {}),
    ...(options.objectId === undefined ? {} : { object_id: options.objectId }),
    ...(options.from === undefined ? {} : { from: optionalInstant(options.from, 'from') }),
    ...(options.to === undefined ? {} : { to: optionalInstant(options.to, 'to') }),
  };
}

type EventQuery = Record<string, string | readonly string[] | undefined>;

export async function eventList(ctx: Context, options: EventListOptions): Promise<CommandResult> {
  const query = buildQuery(options);
  const client = await clientFor(ctx);

  if (options.follow === true) {
    return followEvents(ctx, options, query);
  }

  let rows: EventBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<EventBody>('/v1/events', { query });
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<EventBody>>('/v1/events', {
      query: { ...query, limit, starting_after: options.startingAfter },
    });
    hasMore = response.data.has_more;
    rows = response.data.data;
  }

  const cursor = hasMore ? (rows.at(-1)?.id ?? null) : null;
  return {
    data: { object: 'list', data: rows, has_more: hasMore, next_cursor: cursor },
    human:
      rows.length === 0
        ? `${ctx.presenter.badge()} no events match.`
        : [
            `${ctx.presenter.badge()} ${rows.length} event(s)`,
            '',
            renderTable(['id', 'type', 'occurred at', 'actor', 'subject'], eventRows(rows)),
          ].join('\n'),
    nextSteps:
      cursor === null
        ? ['Follow the log: `bookrail events list --follow`.']
        : [`Next page: \`bookrail events list --starting-after ${cursor} --json\`.`],
  };
}

/**
 * The polling loop. Returns everything it saw, and, when the output is human, prints each
 * event the moment it arrives, which is the whole point of a follow.
 */
async function followEvents(
  ctx: Context,
  options: EventListOptions,
  query: EventQuery,
): Promise<CommandResult> {
  const interval =
    (integer(options.interval, 'interval', { min: 1, max: 3600 }) ??
      DEFAULT_FOLLOW_INTERVAL_SECONDS) * 1000;
  const max = integer(options.max, 'max', { min: 1, max: 100000 });
  const duration = integer(options.duration, 'duration', { min: 1, max: 86400 });

  if (ctx.options.json && max === undefined && duration === undefined) {
    throw new CliError(
      'missing_input',
      '`--follow --json` needs a bound: one JSON envelope cannot be printed by a loop that never ends.',
      {
        param: 'follow',
        fix: 'Add `--max <events>` or `--duration <seconds>`, or drop `--json` to stream the events as lines.',
        exitCode: EXIT.user,
      },
    );
  }

  const client = await clientFor(ctx);
  const controller = new AbortController();
  const detach = ctx.io.onInterrupt?.(() => controller.abort());
  const deadline = duration === undefined ? null : Date.now() + duration * 1000;
  // "From now on", unless the caller named a starting point. See the header comment for the
  // gap this leaves and why an explicit `--from` closes it.
  const startQuery = {
    ...query,
    ...(options.startingAfter === undefined && query.from === undefined
      ? { from: new Date().toISOString() }
      : {}),
  };

  let cursor = options.startingAfter;
  const collected: EventBody[] = [];
  if (!ctx.presenter.json) {
    ctx.presenter.print(
      `${ctx.presenter.badge()} following the event log every ${String(interval / 1000)}s. Ctrl-C to stop.`,
    );
  }

  try {
    while (!controller.signal.aborted) {
      // Drain: a full page means there is more waiting, and waiting `interval` between pages
      // would make a burst take minutes to catch up.
      let drained = false;
      while (!drained && !controller.signal.aborted) {
        const response = await client.get<ListEnvelope<EventBody>>('/v1/events', {
          query: { ...startQuery, limit: 100, starting_after: cursor },
        });
        const page = response.data.data;
        const last = page.at(-1);
        if (last !== undefined) cursor = last.id;
        for (const event of page) {
          collected.push(event);
          if (!ctx.presenter.json) ctx.presenter.print(eventLine(event));
          if (max !== undefined && collected.length >= max)
            return followResult(ctx, collected, cursor, 'max');
        }
        drained = !response.data.has_more;
      }

      if (deadline !== null && Date.now() >= deadline) {
        return followResult(ctx, collected, cursor, 'duration');
      }
      const wait =
        deadline === null ? interval : Math.max(0, Math.min(interval, deadline - Date.now()));
      await sleep(wait, controller.signal);
      if (deadline !== null && Date.now() >= deadline) {
        return followResult(ctx, collected, cursor, 'duration');
      }
    }
    return followResult(ctx, collected, cursor, 'interrupted');
  } finally {
    detach?.();
  }
}

function followResult(
  ctx: Context,
  events: EventBody[],
  cursor: string | undefined,
  stoppedBy: 'max' | 'duration' | 'interrupted',
): CommandResult {
  return {
    data: {
      object: 'list',
      data: events,
      has_more: false,
      next_cursor: cursor ?? null,
      followed: true,
      stopped_by: stoppedBy,
    },
    // The events were already streamed line by line above; repeating them here would print
    // every one twice.
    human: `${ctx.presenter.badge()} stopped (${stoppedBy}) after ${String(events.length)} event(s).`,
    nextSteps:
      cursor === undefined
        ? []
        : [`Resume exactly here: \`bookrail events list --follow --starting-after ${cursor}\`.`],
  };
}

export async function eventGet(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.get<EventBody>(`/v1/events/${encodeURIComponent(id)}`)).data;
  return {
    data,
    human: [
      `${ctx.presenter.badge()} ${data.id} ${data.type} at ${data.occurred_at}`,
      '',
      renderTable(
        ['field', 'value'],
        [
          ['subject', text(data.data.object?.id ?? '')],
          ['actor', `${text(data.actor?.type)} ${text(data.actor?.id)}`.trim()],
          ['api version', data.api_version],
          ['seq', String(data.seq)],
          ['previous', truncate(text(data.data.previous), 70)],
        ],
      ),
    ].join('\n'),
    nextSteps: ['The body of a webhook delivery is exactly this object, byte for byte.'],
  };
}
