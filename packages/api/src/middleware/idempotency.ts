/**
 * `Idempotency-Key`, an optional header of 1 to 255 characters, on every POST of `/v1`.
 *
 * The promise is narrow and absolute: **the same key, within 24 hours, produces the same
 * response and no second effect.** What makes it hard is not the storage, it is the twenty
 * requests that carry one key and arrive in the same millisecond: a retry loop in an SDK, a
 * user double-tapping, a queue redelivering. A read-then-write ("do I know this key? no →
 * book") answers *no* twenty times and books twenty times, and it does so only under load,
 * which is exactly when nobody is watching.
 *
 * So there is no read-then-write here. The key is **claimed with an INSERT** whose uniqueness
 * the database enforces (`idempotency_keys (project_id, environment, key)`, migration 0010):
 * one request wins the insert and runs, the other nineteen lose it and are told which of the
 * three things happened:
 *
 *  - the stored `request_hash` differs → `400 idempotency_key_reused`. The same key was used
 *    for a different request, which is a bug in the caller, and serving the first response
 *    would hide it;
 *  - the winner has not answered yet → `409 idempotency_key_in_progress`. Retry;
 *  - the winner answered → **that answer**, verbatim, with `Idempotent-Replayed: true`.
 *
 * Two details that are easy to get wrong and are decided here:
 *
 * **Errors are replayed too.** A 409 `slot_unavailable` is a real answer about a real world;
 * replaying it as a 201 on the retry would invent a booking. The one exception is 5xx, which
 * is not stored at all: the row is released instead, because a server fault is precisely the
 * case a client should be free to retry.
 *
 * **What is stored is not always what was sent.** A route may set `idempotencyResponseBody` to
 * say "remember *this* instead of my response body". One endpoint needs it: `POST /v1/webhooks`
 * returns a signing secret once, and a secret that is remembered for 24 hours and returned again
 * on every replay is not shown once, it is stored. Every
 * other route leaves it unset and its response is cloned as before.
 *
 * **A crashed process must not wedge a key for 24 hours.** A claim carries `locked_at`, and a
 * claim older than {@link LEASE_SECONDS} may be taken over. The takeover is itself a
 * conditional UPDATE, so two requests cannot take over the same stale claim.
 *
 * The claim, the completion and the release each run in their own short transaction: the
 * claim has to be **visible to other connections** before the handler starts, which is the
 * whole point, so it cannot share the booking transaction.
 */
import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { sql, withProjectContext } from '@bookrail/db';
import { errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv, AuthContext } from '../context.js';
import { requireAuth } from '../http.js';
import { isPublicPath } from '../routes/public.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Header on a replayed response, so a client can tell a replay from a fresh execution. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** Matches the CHECK in migration 0010. */
export const MAX_KEY_LENGTH = 255;

/**
 * How long a claim is trusted before another request may take it over.
 *
 * Well above any request this API can legitimately take (the booking transaction is
 * milliseconds, the SLO is 500 ms) and well below the 24 hour retention, so the window in
 * which a takeover could race a very slow winner does not exist in practice.
 */
export const LEASE_SECONDS = 90;

type Claim =
  | { kind: 'claimed' }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; status: number; body: unknown };

interface StoredRow {
  [column: string]: unknown;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  completed_at: string | null;
  stale: boolean;
}

/**
 * The request, reduced to what makes two requests "the same one".
 *
 * Path **and** query string, the latter with its parameters sorted so that `?a=1&b=2` and
 * `?b=2&a=1` hash alike. No POST of `/v1` reads the query string today, so leaving it out
 * would be harmless today and a silent bug the first time one does, and `parseExpand` is
 * generic enough that it will.
 *
 * Headers are deliberately excluded: `Authorization` changes on every key rotation, and a
 * rotated key must not invalidate an in-flight idempotent retry.
 */
function requestTarget(url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].sort(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
  );
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return query.length === 0 ? parsed.pathname : `${parsed.pathname}?${query.join('&')}`;
}

function requestHash(method: string, target: string, body: string): string {
  return createHash('sha256').update(`${method}\n${target}\n${body}`, 'utf8').digest('hex');
}

/**
 * Claims the key, or explains why it cannot be claimed.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` blocks until the concurrent inserter commits or rolls
 * back, and the `SELECT` that follows takes a fresh snapshot (`read committed`), so the loser
 * always sees the winner's row rather than an empty result.
 */
async function claim(deps: AppDeps, auth: AuthContext, key: string, hash: string): Promise<Claim> {
  return withProjectContext(
    deps.db,
    { projectId: auth.projectId, environment: auth.environment },
    async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO idempotency_keys (id, project_id, environment, key, request_hash, expires_at)
        VALUES (${uuidv7()}, ${auth.projectId}, ${auth.environment}, ${key}, ${hash},
                now() + interval '24 hours')
        ON CONFLICT (project_id, environment, key) DO NOTHING
        RETURNING id
      `);
      if (inserted.rows.length > 0) return { kind: 'claimed' };

      const { rows } = await tx.execute<StoredRow>(sql`
        SELECT request_hash, response_status, response_body, completed_at::text AS completed_at,
               (completed_at IS NULL
                AND locked_at < now() - ${LEASE_SECONDS} * interval '1 second') AS stale
          FROM idempotency_keys
         WHERE key = ${key}
      `);
      const row = rows[0];
      // The row vanished between the two statements: only the purge job deletes rows, and
      // only rows older than 24 hours, so this means the key had just expired. Treat it as a
      // fresh request rather than inventing an error the caller cannot act on.
      if (row === undefined) return { kind: 'claimed' };
      if (row.request_hash !== hash) return { kind: 'mismatch' };
      if (row.completed_at !== null) {
        return { kind: 'replay', status: row.response_status ?? 200, body: row.response_body };
      }
      if (!row.stale) return { kind: 'in_progress' };

      // Take over a claim whose owner died. Conditional on the row still being stale, so two
      // requests reaching here together produce one winner and one `in_progress`.
      const taken = await tx.execute<{ id: string }>(sql`
        UPDATE idempotency_keys
           SET locked_at = now()
         WHERE key = ${key} AND completed_at IS NULL
           AND locked_at < now() - ${LEASE_SECONDS} * interval '1 second'
        RETURNING id
      `);
      return taken.rows.length > 0 ? { kind: 'claimed' } : { kind: 'in_progress' };
    },
  );
}

async function complete(
  deps: AppDeps,
  auth: AuthContext,
  key: string,
  status: number,
  body: string,
): Promise<void> {
  let parsed: unknown = null;
  try {
    parsed = body === '' ? null : JSON.parse(body);
  } catch {
    // Nothing this API returns is not JSON; if that ever changes, the safe answer is to
    // forget the key rather than to store something a replay could not reproduce.
    await release(deps, auth, key);
    return;
  }
  await withProjectContext(
    deps.db,
    { projectId: auth.projectId, environment: auth.environment },
    (tx) =>
      tx.execute(sql`
        UPDATE idempotency_keys
           SET response_status = ${status},
               response_body = ${JSON.stringify(parsed)}::jsonb,
               completed_at = now()
         WHERE key = ${key} AND completed_at IS NULL
      `),
  );
}

/** Gives the key back, so the caller may retry: used for 5xx and for a handler that threw. */
async function release(deps: AppDeps, auth: AuthContext, key: string): Promise<void> {
  await withProjectContext(
    deps.db,
    { projectId: auth.projectId, environment: auth.environment },
    (tx) =>
      tx.execute(sql`
        DELETE FROM idempotency_keys WHERE key = ${key} AND completed_at IS NULL
      `),
  );
}

/**
 * Applied to every POST under `/v1`, availability included.
 *
 * Availability has no side effect to protect, so idempotency there is harmless rather than
 * useful, but a client that sends the header on every POST, which is what an SDK with a
 * retry policy does, must not get a different contract on one endpoint. The header stays
 * optional everywhere: a POST without it behaves exactly as before.
 */
export function idempotency(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    if (c.req.method !== 'POST') return next();
    // The public routes have no key, so there is no project to scope a claim to, and no row of
    // `idempotency_keys` that could hold one. A header sent there is ignored rather than
    // refused: each of them is safe to repeat by construction, because the token, the poll
    // token and the OAuth state are each good for exactly one outcome.
    if (isPublicPath(c.req.path)) return next();
    const raw = c.req.header(IDEMPOTENCY_HEADER);
    if (raw === undefined) return next();
    // Trimmed here rather than left to the HTTP client: `fetch` already strips the spaces at
    // the edges of a header value, and a contract that depended on which client sent the
    // request would be no contract at all. `"  K  "` and `"K"` are one key; `"   "` is empty.
    const key = raw.trim();
    if (key === '' || key.length > MAX_KEY_LENGTH) {
      throw errors.invalidRequest(
        `Idempotency-Key must be between 1 and ${String(MAX_KEY_LENGTH)} characters.`,
        'Idempotency-Key',
        'parameter_invalid',
      );
    }

    const auth = requireAuth(c);
    // Hono caches the body, so reading the text here does not stop the route from reading it
    // as JSON afterwards.
    const body = await c.req.text();
    const hash = requestHash(c.req.method, requestTarget(c.req.url), body);

    const outcome = await claim(deps, auth, key, hash);
    if (outcome.kind === 'mismatch') {
      throw errors.invalidRequest(
        'This Idempotency-Key was already used for a request with a different body or path.',
        'Idempotency-Key',
        'idempotency_key_reused',
      );
    }
    if (outcome.kind === 'in_progress') {
      throw errors.conflict(
        'A request with this Idempotency-Key is still in progress. Retry in a moment.',
        'idempotency_key_in_progress',
        'Idempotency-Key',
      );
    }
    if (outcome.kind === 'replay') {
      return new Response(outcome.body === null ? '' : JSON.stringify(outcome.body), {
        status: outcome.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          [REPLAYED_HEADER]: 'true',
        },
      });
    }

    try {
      await next();
    } catch (error) {
      // The failure escaped Hono's own handling, so there is no response to store. Release
      // only if nothing was committed; otherwise remember the failure, as below.
      if (c.get('effectCommitted') === true) {
        // The handler threw after committing: there is no response to store, and whatever the
        // route may have nominated never reached the client either.
        await complete(deps, auth, key, 500, internalErrorBody(c));
      } else {
        await release(deps, auth, key);
      }
      throw error;
    }

    const status = c.res.status;
    const committed = c.get('effectCommitted') === true;

    // **The key is released only when nothing was committed.** A 5xx normally means the request did
    // not happen, and the caller is invited to retry it, but a write route commits its transaction
    // *before* it can finish building the answer, so a connection that dies, a `statement_timeout`,
    // or a failover in that window produces a 500 on a booking that exists. Releasing the key there
    // would let the retry book a second time, which is exactly the second effect the header
    // promises never to produce. So the 500 is stored instead: the retry receives the same 500 and
    // the caller finds out what happened with `GET /v1/bookings`, which is a worse answer than a
    // booking id and a far better one than a duplicate booking.
    //
    // A POST to a path that does not exist never had an effect and must not burn the key: a
    // typo in the URL would otherwise make the correct request a 400 `idempotency_key_reused`.
    const unknownEndpoint = status === 404 && c.get('errorCode') === 'unknown_endpoint';
    if (!committed && (status >= 500 || unknownEndpoint)) {
      await release(deps, auth, key);
      return;
    }
    await complete(deps, auth, key, status, await storableBody(c));
  };
}

/**
 * The body to remember: what the route nominated, or the response itself.
 *
 * A route nominates a body only to *narrow* it (the one caller today hands over the same
 * object minus its secret), so a replay answers with less than the first request did, never
 * with something the caller never received.
 */
async function storableBody(c: Context<AppEnv>): Promise<string> {
  const nominated = c.get('idempotencyResponseBody');
  if (nominated !== undefined) return JSON.stringify(nominated);
  return c.res.clone().text();
}

/**
 * The envelope to store when the handler threw *after* committing.
 *
 * Rebuilt rather than read from `c.res`, because in this branch there is no response: the
 * exception escaped every handler. It has to match what the client actually received, which
 * `requestContext` builds from the same `errors.internal()`.
 */
function internalErrorBody(c: Context<AppEnv>): string {
  return JSON.stringify(errors.internal().toPayload(c.get('requestId') ?? ''));
}
