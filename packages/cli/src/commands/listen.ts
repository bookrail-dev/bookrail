/**
 * `bookrail webhooks listen`: watch the events go out, on this machine.
 *
 * ## Two modes, and why there are two
 *
 * Either a local tunnel or a poll of `GET /v1/events` would do. Both are here, because they
 * answer different questions and neither can answer the other's.
 *
 * **Tunnel mode (`--url <public url>`).** Registers a *temporary* endpoint pointing at the URL
 * the caller says reaches this machine (an ngrok/cloudflared address in real life, `127.0.0.1`
 * in the test suite), listens on `--port`, and prints every delivery as it lands. This is the
 * only mode that exercises the thing a developer actually needs to get right: the delivery
 * headers, the `Bookrail-Signature`, the raw body their verifier will see, and their own
 * handler when `--forward` is given. The endpoint is deleted on the way out, so an aborted
 * session does not leave the project delivering to a tunnel that closed.
 *
 * **Poll mode (no `--url`).** Follows the event log instead. Nothing is registered, no
 * signature is exercised, and the events are the same objects a delivery would have carried: a
 * delivery body is byte for byte what `GET /v1/events/{id}` returns, which is what makes the
 * substitution honest. It is the mode that works with no public address at all, and the output
 * says plainly which of the two ran.
 *
 * There is no third mode where Bookrail opens the tunnel: that needs a service that does not
 * exist yet, and inventing a hostname the CLI cannot actually route would be worse than
 * saying so.
 *
 * ## The signature check is not reimplemented here any more
 *
 * It used to be: forty lines of `node:crypto` copied from `@bookrail/shared`, because the CLI
 * publishes on its own and pulling in the server's package to check thirty-two bytes would have
 * undone that. The copy is gone. `@bookrail/webhook-signature` has no runtime
 * dependencies of its own, so it costs the CLI a third dependency and nothing else, and there
 * is now exactly one verifier in the repository, the same one the API's delivery worker signs
 * with and the same one a customer installs. What stays here is the *verdict*: a reason string
 * for the human output, which is a presentation concern and not a second opinion about whether
 * a signature is valid.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  parseSignatureHeader,
  verifySignature,
} from '@bookrail/webhook-signature';
import type { Context } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { truncate, type CommandResult } from '../output.js';
import { clientFor, commaList, integer, sleep } from './helpers.js';
import { eventList, type EventListOptions } from './events.js';
import type { WebhookBody } from './webhooks.js';

/** The timestamp is signed with the payload, and a delivery outside ±5 minutes is refused. */
export const SIGNATURE_TOLERANCE_SECONDS = DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
export const DEFAULT_LISTEN_PORT = 4100;

export interface SignatureVerdict {
  valid: boolean;
  reason: string;
}

/**
 * {@link verifySignature} plus the sentence that goes on the terminal.
 *
 * The verdict is `verifySignature`'s and nothing else's: this function never decides that a
 * signature is valid. It re-reads the header only to say *why* a rejection happened, because
 * "signature does not match the secret" and "the delivery is four hours old" send a developer
 * to two different places, and a bare `false` sends them to neither.
 */
export function signatureVerdict(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureVerdict {
  if (header === undefined || header === '') return { valid: false, reason: 'no signature header' };
  if (secret === '') return { valid: false, reason: 'no secret' };
  if (verifySignature(rawBody, header, secret, SIGNATURE_TOLERANCE_SECONDS, nowSeconds)) {
    return { valid: true, reason: 'ok' };
  }
  const parsed = parseSignatureHeader(header);
  if (parsed === null) return { valid: false, reason: 'malformed header' };
  const drift = nowSeconds - parsed.timestamp;
  if (Math.abs(drift) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: `timestamp is ${String(drift)}s away` };
  }
  return { valid: false, reason: 'signature does not match the secret' };
}

export interface ReceivedDelivery {
  received_at: string;
  event_id: string | null;
  event_type: string | null;
  webhook_id: string | null;
  delivery_id: string | null;
  signature: string;
  signature_valid: boolean;
  forwarded_status: number | null;
  forward_error: string | null;
}

export interface ListenOptions extends EventListOptions {
  url?: string;
  port?: string;
  forward?: string;
  events?: string[];
  keep?: boolean;
}

export async function webhooksListen(ctx: Context, options: ListenOptions): Promise<CommandResult> {
  if (options.url === undefined || options.url.trim() === '') {
    return pollInstead(ctx, options);
  }
  return tunnel(ctx, options, options.url.trim());
}

/**
 * No public address: follow the log instead, and say so.
 *
 * The delegation is literal (the same loop, the same cursor, the same bounds) because a
 * second implementation of "follow the events" is a second implementation of the cursor
 * guarantee, and that is precisely the thing that must exist once.
 */
async function pollInstead(ctx: Context, options: ListenOptions): Promise<CommandResult> {
  if (!ctx.presenter.json) {
    ctx.presenter.print(
      [
        `${ctx.presenter.badge()} no --url given, so nothing was registered: following the event log instead.`,
        'The objects below are exactly what a delivery would have carried, byte for byte, but no',
        'endpoint was called and no signature was produced. To exercise a real delivery, expose a',
        'local port (ngrok, cloudflared, ...) and re-run with `--url <public url> --port <port>`.',
      ].join('\n'),
    );
  }
  // `--events` names event types in both modes: there it is a subscription, here it is a
  // filter, and an agent should not have to learn two flags for one idea.
  const result = await eventList(ctx, {
    ...options,
    ...(options.type === undefined && options.events !== undefined ? { type: options.events } : {}),
    follow: true,
  });
  const data = result.data as Record<string, unknown>;
  return {
    ...result,
    data: { ...data, mode: 'poll', webhook_id: null, url: null },
    nextSteps: [
      'This mode registers nothing and verifies no signature.',
      'Run `bookrail webhooks listen --url <public url> --port 4100` to receive real deliveries.',
      ...(result.nextSteps ?? []),
    ],
  };
}

async function tunnel(
  ctx: Context,
  options: ListenOptions,
  publicUrl: string,
): Promise<CommandResult> {
  const port = integer(options.port, 'port', { min: 0, max: 65535 }) ?? DEFAULT_LISTEN_PORT;
  const max = integer(options.max, 'max', { min: 1, max: 100000 });
  const duration = integer(options.duration, 'duration', { min: 1, max: 86400 });

  if (ctx.options.json && max === undefined && duration === undefined) {
    throw new CliError(
      'missing_input',
      '`webhooks listen --json` needs a bound: one JSON envelope cannot be printed by a loop that never ends.',
      {
        param: 'json',
        fix: 'Add `--max <deliveries>` or `--duration <seconds>`, or drop `--json` to stream the deliveries as lines.',
        exitCode: EXIT.user,
      },
    );
  }

  const client = await clientFor(ctx);
  const received: ReceivedDelivery[] = [];
  const controller = new AbortController();
  const detach = ctx.io.onInterrupt?.(() => controller.abort());

  // Filled in once the endpoint exists; the handler cannot run before that, because the
  // server only starts receiving after the registration below.
  const secretHolder: { secret: string } = { secret: '' };
  const server = createServer((request, response) => {
    void handle(ctx, request, response, options, received, secretHolder, () => {
      if (max !== undefined && received.length >= max) controller.abort();
    });
  });

  let endpoint: (WebhookBody & { secret: string }) | null = null;
  try {
    await listen(server, port);
    const bound = server.address() as AddressInfo;
    const localUrl = `http://127.0.0.1:${String(bound.port)}`;

    const body: Record<string, unknown> = {
      url: publicUrl,
      description: 'Temporary endpoint of `bookrail webhooks listen`.',
      metadata: { created_by: 'bookrail-cli-listen' },
    };
    const events = commaList(options.events);
    if (events !== undefined) body.events = events;
    endpoint = (await client.post<WebhookBody & { secret: string }>('/v1/webhooks', body)).data;
    secretHolder.secret = endpoint.secret;

    if (!ctx.presenter.json) {
      ctx.presenter.print(
        [
          `${ctx.presenter.badge()} listening on ${localUrl}`,
          `registered ${endpoint.id} -> ${endpoint.url} for ${endpoint.events.join(', ')}`,
          options.forward === undefined
            ? 'not forwarding; pass --forward http://localhost:3000/api/bookrail to relay each delivery'
            : `forwarding every delivery to ${options.forward}`,
          options.keep === true
            ? 'the endpoint will be KEPT when this command exits (--keep)'
            : 'the endpoint will be deleted when this command exits',
          'Ctrl-C to stop.',
        ].join('\n'),
      );
    }

    await waitForStop(controller.signal, duration);
  } finally {
    detach?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Deleting the temporary endpoint is not optional bookkeeping: a project left pointing at
    // a tunnel that has closed marks the endpoint `failing` after eight attempts and drops
    // every event that arrives meanwhile into a dead queue.
    if (endpoint !== null && options.keep !== true) {
      try {
        await client.delete(`/v1/webhooks/${endpoint.id}`);
      } catch (error) {
        ctx.presenter.warn(
          `Could not delete the temporary endpoint ${endpoint.id}: ${error instanceof Error ? error.message : String(error)}. Remove it with \`bookrail webhooks delete ${endpoint.id} --yes\`.`,
        );
      }
    }
  }

  const bad = received.filter((delivery) => !delivery.signature_valid).length;
  return {
    data: {
      mode: 'tunnel',
      webhook_id: endpoint?.id ?? null,
      url: publicUrl,
      forward: options.forward ?? null,
      deleted: endpoint !== null && options.keep !== true,
      received,
      counts: { total: received.length, invalid_signature: bad },
    },
    human: `${ctx.presenter.badge()} received ${String(received.length)} delivery(ies)${bad === 0 ? '' : `, ${String(bad)} with a signature that did not verify`}.`,
    nextSteps:
      received.length === 0
        ? [
            'Nothing arrived. Check that the --url really reaches this machine, then create a booking, or run `bookrail webhooks test <id>`.',
          ]
        : bad === 0
          ? ['Every delivery verified against the endpoint secret.']
          : [
              'At least one signature did not verify: the raw body must be signed as it arrived, before any re-serialisation.',
            ],
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function waitForStop(signal: AbortSignal, duration: number | undefined): Promise<void> {
  if (duration === undefined) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return;
  }
  await sleep(duration * 1000, signal);
}

async function handle(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: ListenOptions,
  received: ReceivedDelivery[],
  secret: { secret: string },
  onReceived: () => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  // The bytes as they arrived: signing is over the raw body, not over a re-encoding of it.
  const raw = Buffer.concat(chunks).toString('utf8');
  const header = request.headers['bookrail-signature'];
  const signature = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  const verdict = signatureVerdict(raw, signature === '' ? undefined : signature, secret.secret);

  let type: string | null = null;
  try {
    type = (JSON.parse(raw) as { type?: string }).type ?? null;
  } catch {
    type = null;
  }

  const entry: ReceivedDelivery = {
    received_at: new Date().toISOString(),
    event_id: headerOf(request, 'bookrail-event-id'),
    event_type: type,
    webhook_id: headerOf(request, 'bookrail-webhook-id'),
    delivery_id: headerOf(request, 'bookrail-delivery-id'),
    signature,
    signature_valid: verdict.valid,
    forwarded_status: null,
    forward_error: null,
  };

  if (options.forward !== undefined && options.forward !== '') {
    try {
      const forwarded = await fetch(options.forward, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'bookrail-signature': signature,
          ...(entry.event_id === null ? {} : { 'bookrail-event-id': entry.event_id }),
          ...(entry.webhook_id === null ? {} : { 'bookrail-webhook-id': entry.webhook_id }),
          ...(entry.delivery_id === null ? {} : { 'bookrail-delivery-id': entry.delivery_id }),
        },
        body: raw,
      });
      entry.forwarded_status = forwarded.status;
    } catch (error) {
      entry.forward_error = error instanceof Error ? error.message : String(error);
    }
  }

  received.push(entry);
  if (!ctx.presenter.json) {
    ctx.presenter.print(
      [
        entry.received_at,
        (entry.event_type ?? '?').padEnd(22),
        entry.event_id ?? '?',
        verdict.valid ? 'signature ok' : `signature FAILED (${verdict.reason})`,
        entry.forwarded_status === null
          ? entry.forward_error === null
            ? ''
            : `forward failed: ${truncate(entry.forward_error, 60)}`
          : `forwarded -> ${String(entry.forwarded_status)}`,
      ]
        .filter((part) => part !== '')
        .join('  '),
    );
  }

  // Always 2xx: the point of the command is to receive, and answering an error would make the
  // server retry a delivery the developer has already seen.
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"received":true}');
  onReceived();
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
