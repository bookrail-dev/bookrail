import { randomUUID } from 'node:crypto';
import { CliError, EXIT } from '../errors.js';
import { API_VERSION, type Environment } from '../version.js';
import { apiErrorToCliError, networkError, timeoutError } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  /**
   * The secret key, when there is one.
   *
   * `undefined` sends no `Authorization` header at all, which is what the three `/v1/signups`
   * endpoints want: they are where a key comes from, so requiring one would be a circle. Every
   * other endpoint answers `401 missing_api_key` without it, which is the right answer.
   */
  secretKey?: string;
  environment: Environment;
  timeoutMs?: number;
  /** Injectable for the tests; defaults to the global `fetch` of Node 20. */
  fetch?: FetchLike;
  userAgent?: string;
  /**
   * The value of the `Bookrail-Actor` header: which of Bookrail's own tools is calling.
   *
   * The API accepts a closed list (`mcp`, `cli`, `sdk`, `dashboard`) and writes it into
   * `events.actor.via`, so that a write made through the MCP server can be told apart from a
   * write made by the customer's own code at equal API key. Unset sends no header at all, which
   * is what a caller that is none of those four should do: an absent field is honest, and a
   * wrong one is written into an append-only log for ever.
   */
  actor?: string;
}

export interface RequestOptions {
  body?: unknown;
  /**
   * Query parameters. An array value is sent as a repeated `name[]=` parameter, the form the
   * API documents for `expand[]` and for `type[]` on the event log.
   */
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  /**
   * Overrides the generated key. Idempotency is on by default for every POST: the same
   * `Idempotency-Key` within 24 hours returns the stored answer and has no second effect. A CLI
   * driven by an agent is retried, and a retry that books twice is the failure mode this header
   * exists to remove.
   */
  idempotencyKey?: string;
  /** `expand[]` values, e.g. `['requirements']`. */
  expand?: string[];
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  requestId: string | undefined;
  apiVersion: string | undefined;
}

export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Paging is by cursor (`starting_after`), never by offset, and 100 is the largest page. */
const PAGE_LIMIT = 100;

/**
 * The HTTP client every command goes through.
 *
 * It knows nothing about stdin, stdout or the terminal on purpose: the MCP server mounts the
 * same class in process, where writing to a stream would corrupt the protocol. Its only
 * outputs are values and {@link CliError}.
 */
export class ApiClient {
  readonly baseUrl: string;
  readonly environment: Environment;
  private readonly secretKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly doFetch: FetchLike;
  private readonly userAgent: string;
  private readonly actor: string | undefined;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.environment = options.environment;
    this.secretKey = options.secretKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? 'bookrail-cli';
    this.actor = options.actor;
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      // An array is a repeated `name[]=`, never a comma-joined string: a comma is a legal
      // character inside an event type and joining would make `a,b` indistinguishable from a
      // single value that happens to contain one.
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    for (const value of options.expand ?? []) url.searchParams.append('expand[]', value);

    const headers: Record<string, string> = {
      ...(this.secretKey === undefined ? {} : { authorization: `Bearer ${this.secretKey}` }),
      accept: 'application/json',
      'bookrail-version': API_VERSION,
      'user-agent': this.userAgent,
      ...(this.actor === undefined ? {} : { 'bookrail-actor': this.actor }),
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (method === 'POST') {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(url.toString(), {
        method,
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError(this.baseUrl, this.timeoutMs);
      throw networkError(this.baseUrl, error);
    } finally {
      clearTimeout(timer);
    }

    const requestId = response.headers.get('bookrail-request-id') ?? undefined;
    const apiVersion = response.headers.get('bookrail-version') ?? undefined;
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new CliError(
            'invalid_response',
            `${url.pathname} answered with a body that is not JSON.`,
            {
              fix: 'Check that BOOKRAIL_API_URL points at a Bookrail API and not at a proxy or a login page.',
              requestId,
              exitCode: EXIT.service,
            },
          );
        }
      }
    }

    if (!response.ok) {
      throw apiErrorToCliError(
        response.status,
        parsed,
        requestId,
        response.headers.get('retry-after'),
      );
    }
    return { status: response.status, data: parsed as T, requestId, apiVersion };
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { ...options, body });
  }

  patch<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Every page of a collection, following `starting_after` until `has_more` is false.
   *
   * `push`, `pull` and `diff` need the whole set to compute a plan, and a cursor loop written
   * three times is a cursor loop that will be wrong once.
   */
  async listAll<T extends { id: string }>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T[]> {
    const all: T[] = [];
    let startingAfter: string | undefined;
    // A configuration with more than fifty thousand objects of one kind is not a
    // configuration a `bookrail.config.ts` describes; the cap turns a server that always
    // answers `has_more: true` into an error instead of an infinite loop.
    for (let page = 0; page < 500; page += 1) {
      const response = await this.get<ListEnvelope<T>>(path, {
        ...options,
        query: { ...(options.query ?? {}), limit: PAGE_LIMIT, starting_after: startingAfter },
      });
      all.push(...response.data.data);
      if (!response.data.has_more) return all;
      startingAfter = response.data.data.at(-1)?.id;
      if (startingAfter === undefined) return all;
    }
    throw new CliError('too_many_objects', `${path} did not stop paginating after 500 pages.`, {
      fix: 'Narrow the project down, or report the issue: this is a server-side pagination bug.',
      exitCode: EXIT.service,
    });
  }

  /** `GET /health`, which needs no key. Used by `doctor` before it trusts anything else. */
  async health(): Promise<{ status: string; api_version?: string }> {
    const response = await this.request<{ status: string; api_version?: string }>('GET', '/health');
    return response.data;
  }
}
