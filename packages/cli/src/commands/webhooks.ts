/**
 * `bookrail webhooks list|get|create|update|delete|test|deliveries|retry`. The streaming
 * `listen` lives in `listen.ts`.
 *
 * The one thing this file has to get right is the **secret**. `POST /v1/webhooks` returns it
 * once and no other endpoint ever will (not even an idempotency replay), so `create` prints it
 * with the warning attached, and nothing else in the CLI ever stores it, logs it, or offers to
 * show it again. That is why `create` is the only command here whose `next_steps` are about
 * what to do in the next thirty seconds.
 */
import type { ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { CliError } from '../errors.js';
import { clientFor, commaList, confirm, integer, jsonObject } from './helpers.js';

export interface WebhookBody {
  id: string;
  object: string;
  url: string;
  events: string[];
  status: string;
  description: string | null;
  metadata: Record<string, unknown>;
  environment: string;
  created_at: string;
  updated_at: string;
}

/** Only ever the response of `POST /v1/webhooks`. */
interface CreatedWebhookBody extends WebhookBody {
  secret: string;
}

interface DeliveryBody {
  id: string;
  object: string;
  webhook_id: string;
  event_id: string;
  event_type?: string | null;
  status: string;
  attempt: number;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

function webhookTable(rows: WebhookBody[]): string {
  return renderTable(
    ['id', 'status', 'url', 'events'],
    rows.map((row) => [
      row.id,
      row.status,
      truncate(row.url, 48),
      truncate(row.events.join(','), 40),
    ]),
  );
}

export interface WebhookListOptions {
  limit?: string;
  startingAfter?: string;
  all?: boolean;
}

export async function webhookList(
  ctx: Context,
  options: WebhookListOptions,
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  let rows: WebhookBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<WebhookBody>('/v1/webhooks');
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<WebhookBody>>('/v1/webhooks', {
      query: { limit, starting_after: options.startingAfter },
    });
    rows = response.data.data;
    hasMore = response.data.has_more;
  }
  const cursor = hasMore ? (rows.at(-1)?.id ?? null) : null;
  return {
    data: { object: 'list', data: rows, has_more: hasMore, next_cursor: cursor },
    human:
      rows.length === 0
        ? `${ctx.presenter.badge()} no webhook endpoints. Create one with \`bookrail webhooks create --url https://...\`.`
        : `${ctx.presenter.badge()} ${rows.length} endpoint(s)\n\n${webhookTable(rows)}`,
    nextSteps:
      cursor === null
        ? []
        : [`Next page: \`bookrail webhooks list --starting-after ${cursor} --json\`.`],
  };
}

export async function webhookGet(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.get<WebhookBody>(`/v1/webhooks/${encodeURIComponent(id)}`)).data;
  return {
    data,
    human: `${ctx.presenter.badge()} ${data.id}\n\n${webhookTable([data])}`,
    nextSteps: [
      `Send it a synthetic delivery: \`bookrail webhooks test ${data.id} --json\`.`,
      `Read its log: \`bookrail webhooks deliveries ${data.id} --json\`.`,
    ],
  };
}

export interface WebhookCreateOptions {
  url?: string;
  events?: string[];
  description?: string;
  metadata?: string;
}

export async function webhookCreate(
  ctx: Context,
  options: WebhookCreateOptions,
): Promise<CommandResult> {
  const url = options.url?.trim();
  if (url === undefined || url === '') {
    throw new CliError('missing_input', '--url is required: where the deliveries should go.', {
      param: 'url',
      fix: 'Pass `--url https://example.com/hooks/bookrail`. On live only https is accepted; on test http is allowed on ports 80, 443 and 8080-8099.',
    });
  }
  const body: Record<string, unknown> = { url };
  const events = commaList(options.events);
  if (events !== undefined) body.events = events;
  if (options.description !== undefined) body.description = options.description;
  const metadata = jsonObject(options.metadata, 'metadata');
  if (metadata !== undefined) body.metadata = metadata;

  const client = await clientFor(ctx);
  const data = (await client.post<CreatedWebhookBody>('/v1/webhooks', body)).data;

  return {
    data,
    human: [
      `${ctx.presenter.badge()} created ${data.id} -> ${data.url}`,
      `subscribed to: ${data.events.join(', ')}`,
      '',
      `signing secret: ${data.secret}`,
      '',
      'This is the only time the secret is shown. It is stored encrypted and no endpoint will',
      'ever return it again. If you lose it, the only remedy is to create another endpoint.',
      'Put it in your receiver now (BOOKRAIL_WEBHOOK_SECRET) and verify every delivery against it.',
    ].join('\n'),
    nextSteps: [
      'Store the secret now: it is not recoverable.',
      `Prove the endpoint answers: \`bookrail webhooks test ${data.id} --json\`.`,
      'Verify `Bookrail-Signature: t=<unix>,v1=<hex>` as HMAC-SHA256 over `"<t>.<raw body>"`, with a ±300 s tolerance.',
    ],
  };
}

export interface WebhookUpdateOptions {
  url?: string;
  events?: string[];
  status?: string;
  description?: string;
  metadata?: string;
}

export async function webhookUpdate(
  ctx: Context,
  id: string,
  options: WebhookUpdateOptions,
): Promise<CommandResult> {
  const body: Record<string, unknown> = {};
  if (options.url !== undefined) body.url = options.url;
  const events = commaList(options.events);
  if (events !== undefined) body.events = events;
  if (options.status !== undefined) body.status = options.status;
  if (options.description !== undefined) body.description = options.description;
  const metadata = jsonObject(options.metadata, 'metadata');
  if (metadata !== undefined) body.metadata = metadata;

  if (Object.keys(body).length === 0) {
    throw new CliError('missing_input', 'Nothing to update.', {
      fix: 'Pass at least one of `--url`, `--events`, `--status active|disabled`, `--description`, `--metadata`.',
    });
  }

  const client = await clientFor(ctx);
  const data = (await client.patch<WebhookBody>(`/v1/webhooks/${encodeURIComponent(id)}`, body))
    .data;
  return {
    data,
    human: `${ctx.presenter.badge()} updated ${data.id}\n\n${webhookTable([data])}`,
    nextSteps: [
      '`disabled` stops all traffic, including `test` and `retry`; re-enabling does not redeliver what happened meanwhile.',
    ],
  };
}

export async function webhookDelete(
  ctx: Context,
  id: string,
  options: { yes?: boolean },
): Promise<CommandResult> {
  await confirm(
    ctx,
    `Delete webhook ${id} and its whole delivery log?`,
    options,
    `Run \`bookrail webhooks delete ${id} --yes\`. To stop the traffic and keep the history, run \`bookrail webhooks update ${id} --status disabled\` instead.`,
  );
  const client = await clientFor(ctx);
  const data = (
    await client.delete<{ id: string; deleted: boolean }>(`/v1/webhooks/${encodeURIComponent(id)}`)
  ).data;
  return {
    data,
    human: `${ctx.presenter.badge()} deleted ${data.id}; its deliveries went with it (ON DELETE CASCADE).`,
    nextSteps: [],
  };
}

export async function webhookTest(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.post<DeliveryBody>(`/v1/webhooks/${encodeURIComponent(id)}/test`, {}))
    .data;
  return {
    data,
    human: [
      `${ctx.presenter.badge()} ${data.status} · HTTP ${text(data.response_status)} in ${text(data.duration_ms)} ms`,
      renderTable(
        ['field', 'value'],
        [
          ['delivery', data.id],
          ['event', `${data.event_id} (${text(data.event_type)})`],
          ['error', truncate(data.error ?? '', 70)],
        ],
      ),
    ].join('\n'),
    // The delivery ran; whether the endpoint answered 2xx is data, not an exit code. An agent
    // branches on `data.status`, exactly as it branches on `has_changes` for `diff`.
    nextSteps:
      data.status === 'succeeded'
        ? ['The endpoint answered 2xx. Nothing else to do.']
        : [
            'A test delivery is never retried: fix the endpoint and run the command again.',
            `The event is in the log: \`bookrail events get ${data.event_id} --json\`.`,
          ],
  };
}

export interface DeliveryListOptions {
  status?: string;
  event?: string;
  limit?: string;
  startingAfter?: string;
  all?: boolean;
}

export async function webhookDeliveries(
  ctx: Context,
  id: string,
  options: DeliveryListOptions,
): Promise<CommandResult> {
  const path = `/v1/webhooks/${encodeURIComponent(id)}/deliveries`;
  const query: Record<string, string | undefined> = {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.event === undefined ? {} : { event_id: options.event }),
  };
  const client = await clientFor(ctx);

  let rows: DeliveryBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<DeliveryBody>(path, { query });
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<DeliveryBody>>(path, {
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
        ? `${ctx.presenter.badge()} no deliveries for ${id}.`
        : [
            `${ctx.presenter.badge()} ${rows.length} delivery attempt(s), newest first`,
            '',
            renderTable(
              ['id', 'status', 'try', 'http', 'ms', 'event', 'next attempt'],
              rows.map((row) => [
                row.id,
                row.status,
                String(row.attempt),
                text(row.response_status),
                text(row.duration_ms),
                truncate(`${row.event_id} ${text(row.event_type)}`, 40),
                text(row.next_attempt_at),
              ]),
            ),
          ].join('\n'),
    nextSteps: [
      ...(cursor === null
        ? []
        : [`Next page: \`bookrail webhooks deliveries ${id} --starting-after ${cursor} --json\`.`]),
      ...(rows.some((row) => row.status === 'failed')
        ? [`Replay one: \`bookrail webhooks retry ${id} <whd_...> --json\`.`]
        : []),
    ],
  };
}

export async function webhookRetry(
  ctx: Context,
  id: string,
  deliveryId: string,
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (
    await client.post<DeliveryBody>(
      `/v1/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      {},
    )
  ).data;
  return {
    data,
    human: `${ctx.presenter.badge()} queued ${data.id} again: attempt counter back to ${String(data.attempt)}, next attempt ${text(data.next_attempt_at)}.`,
    nextSteps: [
      `Watch it: \`bookrail webhooks deliveries ${id} --json\`.`,
      'A replay gets a whole new retry ladder; deliveries older than 30 days are refused.',
    ],
  };
}
