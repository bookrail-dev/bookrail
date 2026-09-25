/**
 * `/v1/signups`: how somebody who has never spoken to us gets a test key and a live key, at
 * eleven at night, without writing to anybody.
 *
 * These routes take no API key, which is the whole point and also the reason every decision
 * below is about what an unauthenticated caller may learn or cause. The other paths of `/v1`
 * without one (the dashboard, the Stripe OAuth callback and the Stripe webhooks) are named with
 * these in `routes/public.ts`.
 *
 * ## Nothing here writes to the database directly
 *
 * The process that serves these routes holds one database credential, the application role,
 * which is bound by Row Level Security and has no privilege at all on `accounts`, `projects`,
 * `api_keys` or `signups`. It could not create an account if it wanted to. Everything below
 * calls one of the four `SECURITY DEFINER` functions of migration 0021, each of which does one
 * thing and checks its own preconditions inside the database, in one transaction, under a row
 * lock where a race would otherwise be possible.
 *
 * ## The terms
 *
 * A request carries the two ticks of the terms (`accept_terms`, `approve_clauses`) or is refused
 * with `400 terms_not_accepted`. The versions accepted are recorded with the request, and the
 * confirm writes them next to the account it creates (migration 0027).
 *
 * ## What the two tokens are for
 *
 * The **confirmation token** proves that whoever is confirming can read the mailbox. It is 32
 * random bytes, it exists in clear text only inside the message, and the database holds its
 * SHA-256. It never appears in a response of this API.
 *
 * The **poll token** proves that whoever is collecting the key is the terminal that asked for
 * it. A browser gets no poll token: it is handed the key in the answer to its own confirm, so
 * there is nothing to come back for. A terminal cannot be handed anything, because the person
 * clicks the link in a different process and possibly on a different machine, so the key waits
 * for it, encrypted, for fifteen minutes, and is released exactly once.
 *
 * ## What an unauthenticated caller cannot learn
 *
 * Creating a sign up answers the same way for an address that already has an account and for
 * one that does not: a difference there would make this an endpoint for asking whether somebody
 * is a customer. The collision is reported by the confirm, which is reached only by whoever
 * opened the mailbox.
 *
 * A claim needs the identifier **and** the poll token, both matched in the same `WHERE`, so a
 * wrong token is indistinguishable from a wrong identifier.
 *
 * ## Two keys, and the live one is real
 *
 * Since 24 September 2026 the confirm mints two keys, a test one and a live one, both secret, with no
 * scopes and no tenant. The live one books for real, on the free plan the account is born on,
 * which refuses new live bookings once the month's included ones are used (`402
 * plan_limit_reached`, migration 0025): that refusal, decided in the transaction of the booking,
 * is what makes it safe to hand a live key to whoever can read a mailbox. Both keys travel in the
 * same answer (a browser) or in the same envelope (a terminal), and both are shown once.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { sql, withAuthContext } from '@bookrail/db';
import { BookrailError, LEGAL_VERSIONS, encodeId, errors, uuidv7 } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { parseJsonBody, pathId } from '../http.js';
import { callerHash } from '../caller.js';
import { generateApiKey, parseApiKey } from '../keys.js';
import { confirmationMessage } from '../mail/messages.js';
import { plansOf } from '../plan.js';
import { signupClaimSchema, signupConfirmSchema, signupCreateSchema } from '../schemas/index.js';
import type { Signup } from '../schemas/responses.js';
import { decryptSecret, encryptSecret, webhookKeyMissing } from '../webhooks/secrets.js';
/**
 * Re-exported so that `/v1/signups` is still the place you look for what makes these routes
 * public. The predicate itself lives beside the one the Stripe callback needs, in `public.ts`.
 */
export { SIGNUPS_PREFIX, isSignupPath } from './public.js';

/** 32 bytes of randomness, in the alphabet that survives a URL and an email client. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The address to count this request against.
 *
 * `X-Forwarded-For` is read **only** when the request itself arrived over loopback, which is
 * where the reverse proxy is and the only place it can be. From anywhere else the header is
 * whatever the caller typed, so the socket wins and the header is ignored: a limit that a
 * caller can reset by changing a header is not a limit.
 *
 * **When there is no socket at all it fails closed.** Reading the socket means reaching into
 * the shape `@hono/node-server` puts on `c.env`, and the day that shape changes the probe would
 * quietly start finding nothing. If "nothing" meant "trust the header", a library upgrade would
 * turn the per caller limit into a number the caller chooses; so "nothing" means the single
 * bucket `unknown`, where every such request counts against the same ten a day. The one
 * deployment that has no socket on purpose is the API driven in process by a test, and it says
 * so with `trustForwardedFor`, a flag only code can set.
 */
export function callerAddress(c: Context<AppEnv>, trustForwardedFor = false): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const socket = socketAddress(c);
  if (trustForwardedFor) return forwarded ?? socket ?? 'unknown';
  if (socket === undefined) return 'unknown';
  return isLoopback(socket) ? (forwarded ?? socket) : socket;
}

function socketAddress(c: Context<AppEnv>): string | undefined {
  const env: unknown = c.env;
  if (typeof env !== 'object' || env === null) return undefined;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (typeof incoming !== 'object' || incoming === null) return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (typeof socket !== 'object' || socket === null) return undefined;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

/**
 * `EENVELOPE`, `ETIMEDOUT`, `EAUTH`, or the constructor name when the transport gives no code.
 * Never the message: see the call site.
 */
function errorClass(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.name : 'unknown';
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/** `ada@example.com` becomes `Ada`, cut to what the column accepts. */
export function accountNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Bookrail';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  const named = cleaned === '' ? 'Bookrail' : cleaned;
  return `${named.charAt(0).toUpperCase()}${named.slice(1)}`.slice(0, 200);
}

function disabled(): BookrailError {
  return new BookrailError(
    'internal',
    'signup_disabled',
    'Self service sign up is not enabled on this deployment.',
    undefined,
    'Write to hello@bookrail.dev and say what you are building.',
  );
}

/**
 * The keys a terminal collects, as the plain text of the envelope: a JSON object with the two of
 * them, in the `v1` envelope the webhook secrets use. An envelope written before 24 September 2026
 * holds the test key alone, as a bare string, and still decrypts to a test key.
 */
interface EnvelopedKeys {
  test: string;
  live: string | null;
}

export function sealKeys(keys: { test: string; live: string }): string {
  return JSON.stringify({ test: keys.test, live: keys.live });
}

export function openKeys(plain: string): EnvelopedKeys {
  if (plain.startsWith('{')) {
    const parsed = JSON.parse(plain) as { test?: unknown; live?: unknown };
    if (typeof parsed.test === 'string') {
      return { test: parsed.test, live: typeof parsed.live === 'string' ? parsed.live : null };
    }
  }
  return { test: plain, live: null };
}

/**
 * A sign up without the two ticks of the terms.
 *
 * `400` and a code of its own, not `parameter_missing`: the request is well formed, and what is
 * missing is an agreement, which the form, the terminal command and an agent each have to ask a
 * person for.
 */
export function termsNotAccepted(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'terms_not_accepted',
    'API keys are issued under the Terms of Service and the Data Processing Agreement, and this request did not accept them.',
    'accept_terms',
    'Read https://bookrail.dev/terms and https://bookrail.dev/dpa, then send accept_terms: true and approve_clauses: true. From a terminal: npx bookrail@latest signup, which asks for both (an older version of the CLI cannot).',
  );
}

function emailFailed(): BookrailError {
  return new BookrailError(
    'internal',
    'signup_email_failed',
    'The confirmation message could not be sent.',
    undefined,
    'Try again in a minute. If it keeps failing, write to hello@bookrail.dev.',
  );
}

/**
 * The five headers, as data, so that they can be put on a response that this middleware did not
 * build. See {@link cors}.
 *
 * `Access-Control-Max-Age` is the one that is not about permission but about arithmetic. Without
 * it a browser remembers a preflight for a few seconds, so a visitor who mistypes an address and
 * tries again a moment later pays for a second `OPTIONS`, and every submission of the form is two
 * requests against the limit in front of these routes rather than one. Ten minutes is well inside
 * what browsers cap it at, and nothing behind it changes more often than a deployment.
 */
export function signupCorsHeaders(siteOrigin: string): Readonly<Record<string, string>> {
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': siteOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

/**
 * Cross origin access, for these routes and for nothing else.
 *
 * The sign up page of the website is on `bookrail.dev` and the API is on another host, so the
 * browser asks first. One origin, two methods, one request header, ten minutes of preflight
 * cache, and a `Vary` so that a cache in between never serves the answer for one origin to a
 * request from another. The rest of `/v1` gets no CORS headers at all: it is called with a secret
 * key, and a secret key does not belong in a browser.
 *
 * **The headers go on after the response exists, not before.** Setting them with `c.header()`
 * puts them in the context's prepared set, which is applied only to responses the context
 * builds; an error is answered by `errorHandler`, which constructs a `Response` of its own, and
 * a `400`, a `429` or a `503` therefore left without a single `Access-Control-*` header. The
 * browser refuses such a response before the page can read it, so the sign up form said "the
 * API could not be reached" for every error the server took the trouble to explain. Writing
 * them onto `c.res.headers` afterwards covers every status, the ones this router did not
 * produce included.
 */
function cors(deps: AppDeps): MiddlewareHandler<AppEnv> {
  // `no-store` on every answer of these routes: the confirm of a browser and the claim of a
  // terminal carry the two keys in clear text, and nothing in between should keep a copy.
  const headers = { ...signupCorsHeaders(deps.siteOrigin), 'Cache-Control': 'no-store' };
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      for (const [name, value] of Object.entries(headers)) c.header(name, value);
      return c.body(null, 204);
    }
    await next();
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  };
}

/**
 * A `timestamptz` arrives from a raw statement as the text Postgres prints, not as a `Date`,
 * so it is asked for as text and parsed here, which is what every other raw read in this
 * package does.
 */
interface StartRow {
  [column: string]: unknown;
  id: string;
  expires_at: string;
}

interface ConfirmRow {
  [column: string]: unknown;
  id: string;
  status: string;
  client: 'cli' | 'web';
  account_id: string | null;
  project_id: string | null;
  api_key_id: string | null;
  live_api_key_id: string | null;
  account_name: string;
  project_name: string;
  default_timezone: string;
  default_currency: string;
}

interface ClaimRow {
  [column: string]: unknown;
  status: string;
  previous_status: string;
  pending_secret: string | null;
  expires_at: string;
  account_id: string | null;
  project_id: string | null;
  api_key_id: string | null;
  live_api_key_id: string | null;
  account_name: string;
  project_name: string;
  default_timezone: string;
  default_currency: string;
}

export function signupsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', cors(deps));

  function mailer(): NonNullable<AppDeps['mailer']> {
    if (deps.mailer === undefined) throw disabled();
    return deps.mailer;
  }

  function secretKey(): Buffer {
    if (deps.webhookSecretKey === undefined) throw webhookKeyMissing();
    return deps.webhookSecretKey;
  }

  /** `POST /v1/signups`: record the intent and send the link. */
  routes.post('/', async (c) => {
    const send = mailer();
    const body = await parseJsonBody(c, signupCreateSchema);
    // Both ticks, or nothing is recorded and nothing is sent: a key is issued under the terms,
    // and a live key books for real from the moment the link is opened.
    if (body.accept_terms !== true || body.approve_clauses !== true) throw termsNotAccepted();

    const id = uuidv7();
    const token = newToken();
    const pollToken = body.client === 'cli' ? newToken() : null;

    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<StartRow>(sql`
        SELECT id, expires_at::text AS expires_at FROM signup_start(
          ${id}::uuid,
          ${body.email},
          ${sha256(token)},
          ${pollToken === null ? null : sha256(pollToken)},
          ${body.client},
          ${callerHash(callerAddress(c, deps.trustForwardedFor === true))},
          ${body.account_name ?? accountNameFromEmail(body.email)},
          ${body.project_name ?? 'Default'},
          ${body.default_timezone ?? 'UTC'},
          ${body.default_currency ?? 'EUR'},
          ${LEGAL_VERSIONS.terms},
          ${LEGAL_VERSIONS.dpa}
        )
      `),
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The sign up could not be recorded.');

    // Sent inside the request, not from a queue. At this volume a queue would add an encrypted
    // table and a second worker to gain nothing: the caller is a person waiting for a message,
    // and an honest error they can act on beats a promise that something will happen later. The
    // row stays behind on a failure, and the daily limit counts it, deliberately: a mail server
    // that refuses is not an invitation to try the same address fifty times.
    try {
      await send.send(
        confirmationMessage({
          to: body.email,
          siteUrl: deps.siteUrl,
          token,
          freeBookingsIncluded: plansOf(deps).free.bookingsIncluded ?? 0,
        }),
      );
    } catch (error) {
      // The **class** of the failure and nothing else. An SMTP refusal quotes the envelope
      // (`550 5.1.1 <you@example.com>: Recipient address rejected`), so writing `error.message`
      // here would put a stranger's address in the journal in clear text, which is exactly what
      // the logging rule of this product forbids. The code and the name are enough to tell a
      // refused recipient from a dead connection from a wrong password.
      deps.logger.warn('signup_email_failed', {
        signup_id: encodeId('signup', row.id),
        error_code: errorClass(error),
      });
      throw emailFailed();
    }

    const payload: Signup = {
      id: encodeId('signup', row.id),
      object: 'signup',
      status: 'pending',
      email: body.email,
      expires_at: new Date(row.expires_at).toISOString(),
      ...(pollToken === null ? {} : { poll_token: pollToken }),
    };
    return c.json(payload, 202);
  });

  /** `POST /v1/signups/confirm`: the link was opened. */
  routes.post('/confirm', async (c) => {
    mailer();
    const key = secretKey();
    const body = await parseJsonBody(c, signupConfirmSchema);

    // The key is minted here, before the call, because the function that writes it cannot mint
    // one: the clear text has to exist in this process either way, and the database only ever
    // sees the hash. The identifier of the key is also the additional authenticated data of the
    // envelope, so a stored envelope that was moved to another sign up row fails to decrypt
    // rather than quietly handing somebody another account's key.
    const test = generateApiKey('test');
    const live = generateApiKey('live');
    const accountId = uuidv7();
    const projectId = uuidv7();
    const keyId = uuidv7();
    const liveKeyId = uuidv7();
    // Sealed with the test key's identifier as additional data, as before: the envelope carries
    // both keys, and moving it to another sign up row fails to decrypt.
    const envelope = encryptSecret(sealKeys({ test: test.key, live: live.key }), key, keyId);

    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<ConfirmRow>(sql`
        SELECT * FROM signup_confirm(
          ${sha256(body.token)},
          ${accountId}::uuid,
          ${projectId}::uuid,
          ${keyId}::uuid,
          ${test.prefix},
          ${test.keyHash},
          ${'test secret key'},
          ${liveKeyId}::uuid,
          ${live.prefix},
          ${live.keyHash},
          ${'live secret key'},
          ${envelope}
        )
      `),
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The sign up could not be confirmed.');

    if (row.status === 'email_taken') {
      const payload: Signup = {
        id: encodeId('signup', row.id),
        object: 'signup',
        status: 'email_taken',
      };
      return c.json(payload);
    }

    const payload: Signup = {
      id: encodeId('signup', row.id),
      object: 'signup',
      status: 'confirmed',
      ...created(row, test.prefix, live.prefix),
      ...(row.client === 'cli'
        ? { delivered_to: 'cli' as const }
        : { secret_key: test.key, live_secret_key: live.key }),
    };
    return c.json(payload);
  });

  /** `POST /v1/signups/{id}/claim`: the terminal comes back for its key. */
  routes.post('/:id/claim', async (c) => {
    mailer();
    const key = secretKey();
    const id = pathId(c, 'signup', 'signup');
    const body = await parseJsonBody(c, signupClaimSchema);

    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<ClaimRow>(
        sql`
          SELECT status, previous_status, pending_secret, expires_at::text AS expires_at,
                 account_id, project_id, api_key_id, live_api_key_id, account_name,
                 project_name, default_timezone, default_currency
            FROM signup_claim(${id}::uuid, ${sha256(body.poll_token)})
        `,
      ),
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The sign up could not be read.');

    if (row.status === 'pending') {
      const payload: Signup = {
        id: encodeId('signup', id),
        object: 'signup',
        status: 'pending',
        expires_at: new Date(row.expires_at).toISOString(),
      };
      return c.json(payload);
    }
    if (row.status === 'expired' || row.status === 'email_taken') {
      const payload: Signup = {
        id: encodeId('signup', id),
        object: 'signup',
        status: row.status,
      };
      return c.json(payload);
    }
    if (row.pending_secret === null) {
      // Two different things, and the caller says something different for each: somebody
      // collected this key already, or nobody came for it within its fifteen minutes.
      const expired = row.previous_status === 'confirmed';
      throw new BookrailError(
        'conflict',
        expired ? 'signup_secret_expired' : 'signup_secret_claimed',
        expired
          ? 'That key was not collected within fifteen minutes and is no longer available.'
          : 'That key has already been collected. It is shown once.',
        undefined,
        'Run `bookrail signup` again to get a new link.',
      );
    }

    const keys = openKeys(decryptSecret(row.pending_secret, key, row.api_key_id ?? ''));
    const parsed = parseApiKey(keys.test);
    const parsedLive = keys.live === null ? null : parseApiKey(keys.live);
    if (parsed === null || (keys.live !== null && parsedLive === null)) {
      throw errors.internal('The stored key could not be read.');
    }
    const payload: Signup = {
      id: encodeId('signup', id),
      object: 'signup',
      status: 'confirmed',
      ...created(row, parsed.prefix, parsedLive?.prefix ?? null),
      secret_key: keys.test,
      ...(keys.live === null ? {} : { live_secret_key: keys.live }),
    };
    return c.json(payload);
  });

  return routes;
}

/**
 * The objects a confirmed sign up produced, in the shape every answer carries them.
 *
 * The prefixes are passed in rather than read from a row: each is the first eight characters of
 * the key's own random body, and this process is the only place the keys exist in clear text.
 * `livePrefix` is `null` for a sign up confirmed before the live key existed.
 */
function created(
  row: {
    account_id: string | null;
    project_id: string | null;
    api_key_id: string | null;
    live_api_key_id: string | null;
    account_name: string;
    project_name: string;
    default_timezone: string;
    default_currency: string;
  },
  prefix: string,
  livePrefix: string | null,
): Partial<Signup> {
  if (row.account_id === null || row.project_id === null || row.api_key_id === null) return {};
  const testKey = {
    id: encodeId('api_key', row.api_key_id),
    object: 'api_key' as const,
    environment: 'test' as const,
    kind: 'secret' as const,
    prefix,
  };
  const liveKey =
    row.live_api_key_id === null || livePrefix === null
      ? null
      : {
          id: encodeId('api_key', row.live_api_key_id),
          object: 'api_key' as const,
          environment: 'live' as const,
          kind: 'secret' as const,
          prefix: livePrefix,
        };
  return {
    account: {
      id: encodeId('account', row.account_id),
      object: 'account',
      name: row.account_name,
    },
    project: {
      id: encodeId('project', row.project_id),
      object: 'project',
      name: row.project_name,
      default_timezone: row.default_timezone,
      default_currency: row.default_currency,
    },
    api_key: testKey,
    api_keys: liveKey === null ? [testKey] : [testKey, liveKey],
  };
}
