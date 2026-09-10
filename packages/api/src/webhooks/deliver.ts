/**
 * One attempt at one delivery: the signed `POST`, and the four ways it can go wrong.
 *
 * ## Why `node:http` and not `fetch`
 *
 * The obvious choice is Node 20's native `fetch`, and its reason (no new dependency) is
 * honoured here in full: nothing is added to `package.json`. But `fetch` resolves the
 * hostname itself, **again**, after `ssrf.ts` has approved the addresses, and that second
 * resolution is precisely the DNS rebinding window the SSRF work exists to close. `node:http`
 * and `node:https` take a `lookup`, so the socket connects to an address that was already
 * vetted and to no other. Two more things fall out of it for free: redirects are never followed
 * (Node's HTTP client does not follow them at all, so the "no redirects" promise is a
 * property of the client rather than a flag somebody can flip), and the timeout can cover the
 * whole exchange rather than only the headers.
 *
 * ## What counts as success
 *
 * Any `2xx`. A `3xx` is a failure: an endpoint that redirects its webhook is an endpoint that
 * has moved, and following it would deliver a signed payload to a host the customer never
 * registered. Everything else (`4xx`, `5xx`, a refused connection, a TLS error, a timeout, an
 * address that is off the public internet) is a failure with a reason, and the reason is what
 * goes in `webhook_deliveries.error`.
 *
 * ## What is read back
 *
 * At most {@link MAX_RESPONSE_BYTES} of the response body, then the socket is destroyed. The
 * body is stored so that a customer can see what their own endpoint said; an endpoint that
 * answers with a megabyte of HTML must not be able to fill our database with it.
 */
import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { buildSignatureHeader, CURRENT_API_VERSION, type Environment } from '@bookrail/shared';
import {
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  WEBHOOK_ID_HEADER,
} from '@bookrail/shared';
import { assertWebhookUrl, resolveWebhookTarget, SsrfError, type SsrfOptions } from './ssrf.js';

/** The published delivery timeout: ten seconds, end to end. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of the receiver's answer is kept. Enough to read an error, not enough to hurt. */
export const MAX_RESPONSE_BYTES = 2048;

/** Sent on every delivery, so a receiver can identify us in its own logs. */
export const USER_AGENT = `Bookrail-Webhooks/1.0 (+https://bookrail.dev/docs/webhooks; ${CURRENT_API_VERSION})`;

export interface DeliveryRequest {
  readonly url: string;
  readonly environment: Environment;
  readonly secret: string;
  /** The exact bytes to send and to sign. */
  readonly body: string;
  readonly eventId: string;
  readonly webhookId: string;
  readonly deliveryId: string;
  readonly timeoutMs?: number;
  readonly timestampSeconds?: number;
}

export interface DeliveryAttempt {
  readonly ok: boolean;
  readonly status: number | null;
  readonly responseBody: string | null;
  readonly error: string | null;
  readonly durationMs: number;
}

/** Errors are stored, so they are trimmed to something a column and a human can both hold. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export async function deliver(
  input: DeliveryRequest,
  options: SsrfOptions = {},
): Promise<DeliveryAttempt> {
  const startedAt = Date.now();
  const failure = (error: string): DeliveryAttempt => ({
    ok: false,
    status: null,
    responseBody: null,
    error: truncate(error, 500),
    durationMs: Date.now() - startedAt,
  });

  let url: URL;
  try {
    url = assertWebhookUrl(input.url, input.environment, options);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  let target;
  try {
    target = await resolveWebhookTarget(url, options);
  } catch (error) {
    return failure(
      error instanceof SsrfError
        ? error.message
        : `Could not resolve ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const payload = Buffer.from(input.body, 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'user-agent': USER_AGENT,
    accept: 'application/json, text/plain;q=0.5, */*;q=0.1',
    [SIGNATURE_HEADER.toLowerCase()]: buildSignatureHeader(input.body, input.secret, timestamp),
    [EVENT_ID_HEADER.toLowerCase()]: input.eventId,
    [WEBHOOK_ID_HEADER.toLowerCase()]: input.webhookId,
    [DELIVERY_ID_HEADER.toLowerCase()]: input.deliveryId,
  };

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<DeliveryAttempt>((resolve) => {
    let settled = false;
    const finish = (attempt: DeliveryAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(attempt);
    };

    let req: ClientRequest;
    // One deadline for the whole exchange (connect, TLS, headers and body) because a
    // receiver that trickles a response one byte a second is exactly as unavailable as one
    // that never answers, and a per-phase timeout would let it hold a worker for ever.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`Timed out after ${String(timeoutMs)} ms.`));
      finish(failure(`Timed out after ${String(timeoutMs)} ms.`));
    }, timeoutMs);

    // The hostname with the brackets of an IPv6 literal stripped: `node:http` wants the bare
    // address, and so does SNI.
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

    try {
      req = send(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers,
          lookup: target.lookup,
          // No connection pool: a pooled socket was opened for an address that was vetted for
          // a previous delivery, and reusing it would let a stale approval outlive its check.
          agent: false,
          // The hostname the certificate has to match. Unchanged by the custom lookup, which
          // only decides which address to connect to, and **omitted for a literal address**:
          // RFC 6066 does not allow an IP as a server name, Node warns about it (DEP0123), and
          // `url.hostname` would have carried the square brackets of an IPv6 literal, which is
          // not a valid SNI value at all.
          servername: url.protocol === 'https:' && isIP(host) === 0 ? host : undefined,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size >= MAX_RESPONSE_BYTES) return;
            size += chunk.byteLength;
            chunks.push(chunk);
            if (size >= MAX_RESPONSE_BYTES) res.destroy();
          });
          const done = (): void => {
            const status = res.statusCode ?? 0;
            const bodyText = truncate(
              Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES),
              MAX_RESPONSE_BYTES,
            );
            const ok = status >= 200 && status < 300;
            finish({
              ok,
              status,
              responseBody: bodyText === '' ? null : bodyText,
              error: ok ? null : truncate(`Endpoint answered ${String(status)}.`, 500),
              durationMs: Date.now() - startedAt,
            });
          };
          res.on('end', done);
          // `destroy()` above ends the stream with `close` and not `end`; both mean "we have
          // what we came for".
          res.on('close', done);
          res.on('error', (error: Error) => finish(failure(error.message)));
        },
      );
    } catch (error) {
      finish(failure(error instanceof Error ? error.message : String(error)));
      return;
    }

    req.on('error', (error: Error) => finish(failure(error.message)));
    req.end(payload);
  });
}
