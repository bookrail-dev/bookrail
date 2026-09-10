/**
 * The transport: one place that builds a request, sends it, retries it, and turns what comes
 * back into either a typed object or a {@link BookrailError}.
 *
 * It uses the global `fetch` and `globalThis.crypto` and nothing else, so it runs unchanged on
 * Node 20, Deno, Bun, Cloudflare Workers and Vercel's edge runtime. No Node built-in is
 * imported from here, directly or through a module this one imports; `test/package.test.ts`
 * proves it by walking the emitted module graph of `dist`.
 */
import {
  BookrailConnectionError,
  BookrailError,
  errorFromResponse,
  unexpectedBody,
} from './errors.js';
import { BookrailPromise, type ResponseInfo, type WithResponse } from './response.js';
import { API_VERSION, DEFAULT_BASE_URL, USER_AGENT } from './version.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injectable so a retry test does not have to wait for the real backoff. */
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

/** The first backoff step. The ladder is 0.5 s, 1 s, 2 s, 4 s, 8 s, then flat. */
export const RETRY_INITIAL_MS = 500;
/** No backoff step is longer than this, however many attempts are configured. */
export const RETRY_MAX_MS = 8_000;
/** How much a step is randomised, either way: 0.75× to 1.25× the nominal delay. */
export const RETRY_JITTER = 0.25;
/**
 * The longest `Retry-After` this client will sit through.
 *
 * Above it the call fails with the rate limit error instead: an SDK that blocks a request
 * handler for ten minutes because a header said so has turned a 429 into an outage.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * The two `409` codes that mean "come back in a moment", not "you got it wrong".
 *
 * `idempotency_key_in_progress`: the first request with this key is still running, so by
 * definition waiting is the right answer.
 * `serialization_failure`: two transactions collided and the booking transaction could not be
 * serialised. Nothing was written, so the client can simply retry.
 */
export const RETRYABLE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'idempotency_key_in_progress',
  'serialization_failure',
]);

export interface BookrailOptions {
  /** Where the API lives. Defaults to the first server of the specification. */
  baseUrl?: string;
  /** `Bookrail-Version`. Defaults to the version the specification declares. */
  apiVersion?: string;
  /** Per attempt, not per call: a retried call may take longer than this. Default 30 s. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  maxRetries?: number;
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: FetchLike;
  /**
   * `Bookrail-Actor`, written to `actor.via` of every event the request produces, so whoever
   * reads the event log can tell a write made through this SDK from one made anywhere else.
   * Defaults to `'sdk'`; pass `undefined` **explicitly** to send no header at all, which is
   * what an application that wants its own writes to look like its own should do.
   */
  actor?: 'sdk' | undefined;
  /**
   * How the client waits between retries. Injectable for the same reason `fetch` is: a test
   * that proves the backoff ladder should assert the delays, not sit through them.
   */
  sleep?: SleepLike;
}

export interface RequestOptions {
  /**
   * The `Idempotency-Key` for this call. One is generated for every POST when it is absent,
   * and the **same** key is sent on every retry of that call, which is what makes retrying a
   * POST safe: within 24 hours the API replays the stored answer for a key it has already
   * seen instead of acting a second time.
   */
  idempotencyKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** `expand[]` values, e.g. `['customer']`. */
  expand?: readonly string[];
  /** Aborts the call. An abort through this signal is never retried. */
  signal?: AbortSignal;
  /** Extra request headers, merged last. */
  headers?: Readonly<Record<string, string>>;
}

export interface CallSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  options?: RequestOptions | undefined;
  /** Skips `Authorization`. Only `GET /openapi.json`, which the API serves without a key. */
  anonymous?: boolean;
}

const KEY_PREFIXES = ['sk_test_', 'sk_live_'] as const;

function headerRecord(headers: Headers): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/** `Retry-After` in milliseconds: an integer number of seconds, or an HTTP date. */
export function retryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new BookrailConnectionError('The request was aborted by the caller.', 'aborted'));
    }
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function randomUuid(): string {
  const webCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (webCrypto?.randomUUID === undefined) {
    throw new BookrailError(
      'internal',
      'globalThis.crypto.randomUUID is not available, so no Idempotency-Key can be generated. Pass `idempotencyKey` explicitly, or run on a runtime with the Web Crypto API (Node 19+, Deno, Bun, workers).',
      { code: 'crypto_unavailable' },
    );
  }
  return webCrypto.randomUUID();
}

/**
 * Appends a query object to a URL.
 *
 * An array becomes a repeated parameter, never a comma-joined string: a comma is a legal
 * character inside an event type, and joining would make `a,b` indistinguishable from one
 * value that happens to contain one. The API spells those parameters `expand[]` and `type[]`,
 * and so does this package: the brackets are part of the name the specification declares.
 */
export function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const name = key.endsWith('[]') ? key : `${key}[]`;
      for (const item of value as unknown[]) url.searchParams.append(name, String(item));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

/** The shared machinery every resource method goes through. */
export class BookrailCore {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly environment: 'test' | 'live';
  readonly timeoutMs: number;
  readonly maxRetries: number;

  readonly #secretKey: string;
  readonly #fetch: FetchLike;
  readonly #sleep: SleepLike;
  readonly #actor: 'sdk' | undefined;

  constructor(secretKey: string, options: BookrailOptions = {}) {
    if (typeof secretKey !== 'string' || secretKey.length === 0) {
      throw new BookrailError(
        'authentication',
        'A Bookrail secret key is required: new Bookrail(process.env.BOOKRAIL_SECRET_KEY). Create one with `bookrail login` or from the project bootstrap.',
        { code: 'missing_api_key' },
      );
    }
    const prefix = KEY_PREFIXES.find((candidate) => secretKey.startsWith(candidate));
    if (prefix === undefined) {
      // Refused here, not by the server: a `pk_` key is a browser key, which these endpoints
      // reject with a 401, and a round trip to learn that is a round trip wasted.
      throw new BookrailError(
        'authentication',
        `A Bookrail secret key starts with "sk_test_" or "sk_live_"; this one starts with "${secretKey.slice(0, 8)}". Publishable keys (pk_) are for the browser SDK, which does not exist yet.`,
        { code: 'invalid_api_key' },
      );
    }

    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.environment = prefix === 'sk_live_' ? 'live' : 'test';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#secretKey = secretKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? defaultSleep;
    // `'actor' in options` and not `options.actor ?? 'sdk'`: absent means "the default", and an
    // explicit `undefined` means "send nothing". Those are two different requests.
    this.#actor = 'actor' in options ? options.actor : 'sdk';
  }

  /** The value this client sends as `Bookrail-Actor`, or `undefined` when it sends none. */
  get actor(): 'sdk' | undefined {
    return this.#actor;
  }

  /** One call, typed. */
  request<T>(spec: CallSpec): BookrailPromise<T> {
    return new BookrailPromise<T>(this.perform<T>(spec));
  }

  /** The bytes of a call, retried, with the envelope. Public so pagination can reuse it. */
  async perform<T>(spec: CallSpec): Promise<WithResponse<T>> {
    const options = spec.options ?? {};
    const url = new URL(`${this.baseUrl}${spec.path}`);
    appendQuery(url, spec.query);
    for (const value of options.expand ?? []) url.searchParams.append('expand[]', value);

    const headers: Record<string, string> = {
      accept: 'application/json',
      'bookrail-version': this.apiVersion,
      'user-agent': USER_AGENT,
    };
    if (spec.anonymous !== true) headers['authorization'] = `Bearer ${this.#secretKey}`;
    if (this.#actor !== undefined) headers['bookrail-actor'] = this.#actor;
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    if (spec.method === 'POST') {
      // Generated once, outside the retry loop, and sent again unchanged on every attempt.
      // That single fact is what makes retrying a POST safe.
      headers['idempotency-key'] = options.idempotencyKey ?? randomUuid();
    }
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }

    const payload = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const target = url.toString();

    let attempt = 0;
    for (;;) {
      const outcome = await this.attempt<T>(target, spec.method, headers, payload, timeoutMs, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        retries: attempt,
      });
      if (outcome.ok) return outcome.value;

      const retriesLeft = maxRetries - attempt;
      const delay = this.delayFor(outcome.error, attempt, retriesLeft);
      if (delay === null) throw outcome.error;
      await this.#sleep(delay, options.signal);
      attempt += 1;
    }
  }

  /**
   * How long to wait before trying again, or `null` when this failure is final.
   *
   * Never a 4xx other than 429 and the two conflict codes above: those say the request itself
   * is wrong, and repeating a wrong request is only a slower way to fail.
   */
  private delayFor(error: BookrailError, attempt: number, retriesLeft: number): number | null {
    if (retriesLeft <= 0) return null;

    if (error instanceof BookrailConnectionError) {
      if (error.code === 'aborted') return null;
      return this.backoff(attempt);
    }

    const status = error.status;
    if (status === undefined) return null;
    if (status === 429 || status >= 500) {
      const after = retryAfterMs(error.headers?.['retry-after'], Date.now());
      if (after === null) return this.backoff(attempt);
      if (after > MAX_RETRY_AFTER_MS) return null;
      return after;
    }
    if (status === 409 && RETRYABLE_CONFLICT_CODES.has(error.code)) return this.backoff(attempt);
    return null;
  }

  private backoff(attempt: number): number {
    const nominal = Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS);
    const spread = 1 - RETRY_JITTER + Math.random() * RETRY_JITTER * 2;
    return Math.round(nominal * spread);
  }

  private async attempt<T>(
    target: string,
    method: string,
    headers: Readonly<Record<string, string>>,
    payload: string | undefined,
    timeoutMs: number,
    context: { signal?: AbortSignal; retries: number },
  ): Promise<{ ok: true; value: WithResponse<T> } | { ok: false; error: BookrailError }> {
    const controller = new AbortController();
    let timedOut = false;
    const caller = context.signal;
    const onCallerAbort = (): void => controller.abort();
    // A function, not an expression: `aborted` is a getter whose value changes while we await,
    // and TypeScript would otherwise narrow it to `false` for the rest of the method.
    const callerAborted = (): boolean => caller !== undefined && caller.aborted;
    if (callerAborted()) {
      return {
        ok: false,
        error: new BookrailConnectionError('The request was aborted by the caller.', 'aborted'),
      };
    }
    caller?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(target, {
        method,
        headers: { ...headers },
        signal: controller.signal,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (cause) {
      if (callerAborted()) {
        return {
          ok: false,
          error: new BookrailConnectionError('The request was aborted by the caller.', 'aborted'),
        };
      }
      if (timedOut) {
        return {
          ok: false,
          error: new BookrailConnectionError(
            `${method} ${target} did not answer within ${String(timeoutMs)} ms.`,
            'timeout',
            cause,
          ),
        };
      }
      return {
        ok: false,
        error: new BookrailConnectionError(
          `${method} ${target} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
          'connection',
          cause,
        ),
      };
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }

    const responseHeaders = headerRecord(response.headers);
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      return {
        ok: false,
        error: new BookrailConnectionError(
          `${method} ${target} answered ${String(response.status)} but the body could not be read.`,
          'connection',
          cause,
        ),
      };
    }

    let parsed: unknown = null;
    let parseFailed = false;
    if (rawBody !== '') {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        error: errorFromResponse(
          response.status,
          responseHeaders,
          rawBody,
          parseFailed ? null : parsed,
        ),
      };
    }

    if (parseFailed || typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        error: unexpectedBody(
          response.status,
          responseHeaders,
          rawBody,
          parseFailed ? 'a body that is not JSON' : 'a body that is not a JSON object',
        ),
      };
    }

    const info: ResponseInfo = {
      status: response.status,
      headers: responseHeaders,
      requestId: responseHeaders['bookrail-request-id'],
      idempotentReplayed: responseHeaders['idempotent-replayed'] === 'true',
      retries: context.retries,
    };
    return { ok: true, value: { data: parsed as T, response: info } };
  }
}
