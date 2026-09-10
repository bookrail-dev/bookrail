import type { Context } from 'hono';
import { type z } from 'zod';
import { decodeId, encodeId, errors, type ObjectKind, type BookrailError } from '@bookrail/shared';
import { withProjectContext, type Transaction } from '@bookrail/db';
import type { TransitionActor } from '@bookrail/engine';
import type { AppDeps, AppEnv, AuthContext } from './context.js';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export function requireAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw errors.authentication('This endpoint requires an API key.', 'missing_api_key');
  return auth;
}

/**
 * The `actor` an HTTP write records in `events`.
 *
 * `{type: "api", id: "key_…"}` is the credential that called, not the person it acted for,
 * which is what `cancelled_by` on a booking is for. `via` is added **only when the caller sent
 * `Bookrail-Actor`**: an absent field says "this request did not declare a tool", which is a
 * different statement from `via: null` and one that costs no bytes in every event ever written
 * by a client that does not use one.
 */
export function eventActor(c: Context<AppEnv>, auth: AuthContext): TransitionActor {
  const via = c.get('actorVia');
  return {
    type: 'api',
    id: encodeId('api_key', auth.apiKeyId),
    ...(via === undefined ? {} : { via }),
  };
}

/** Runs the callback in a transaction pinned to the caller's project and environment. */
export async function inProject<T>(
  c: Context<AppEnv>,
  deps: AppDeps,
  fn: (tx: Transaction, auth: AuthContext) => Promise<T>,
): Promise<T> {
  const auth = requireAuth(c);
  return withProjectContext(
    deps.db,
    { projectId: auth.projectId, environment: auth.environment },
    (tx) => fn(tx, auth),
  );
}

/**
 * `["pricing_rules", 3, "when", "time_from"]` becomes `pricing_rules[3].when.time_from`.
 *
 * A Zod path mixes object keys and array indices, and joining it with dots produced
 * `pricing_rules.3.when.time_from`, which nothing a caller has (a JSON pointer, a JavaScript
 * expression, a `jq` filter) accepts. The indexed form is the one reported instead, and it
 * applies to every array parameter, not only to pricing rules: `requirements[0].resource_id`
 * reads the same way.
 */
function paramPath(path: readonly (string | number)[]): string | undefined {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out === '' ? undefined : out;
}

function issueToError(issue: z.ZodIssue): BookrailError {
  const param = paramPath(issue.path);
  const missing =
    issue.code === 'invalid_type' &&
    'received' in issue &&
    (issue as { received?: string }).received === 'undefined';
  return errors.invalidRequest(
    issue.message,
    param,
    missing ? 'parameter_missing' : 'parameter_invalid',
  );
}

export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw errors.invalidRequest('Request body must be valid JSON.', undefined, 'invalid_body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw first ? issueToError(first) : errors.invalidRequest('Invalid request body.');
  }
  return parsed.data;
}

/**
 * {@link parseJsonBody} for an endpoint whose body is optional.
 *
 * `POST /v1/bookings/{id}/confirm` takes no parameters, and a client that sends no body at all
 * (which is what every HTTP library does when you give it nothing to send) must not get a
 * `400 invalid_body`. An empty body, and only an empty body, is read as `{}`; anything present
 * but unparseable is still an error, because a caller that meant to send something and got the
 * encoding wrong deserves to be told.
 */
export async function parseOptionalJsonBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  const text = (await c.req.text()).trim();
  if (text === '') {
    const empty = schema.safeParse({});
    if (!empty.success) throw errors.invalidRequest('Request body is required.');
    return empty.data;
  }
  return parseJsonBody(c, schema);
}

/**
 * Same contract as {@link parseJsonBody}, for a query string. Query values are always text,
 * so a schema used here has to coerce what it wants as a number; `.strict()` on the schema
 * turns a misspelled parameter into a 400 rather than into a silently ignored filter.
 *
 * `raw` exists for the one thing `c.req.query()` cannot express: a **repeated** parameter.
 * That method flattens `?type[]=a&type[]=b` to a single string, so a route with a repeatable
 * filter builds its own record with {@link repeatedQuery} and passes it here.
 */
export function parseQuery<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
  raw: Record<string, unknown> = c.req.query(),
): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw first ? issueToError(first) : errors.invalidRequest('Invalid query parameters.');
  }
  return parsed.data;
}

export interface ListParams {
  limit: number;
  startingAfter: string | null;
}

export function parseListParams(c: Context<AppEnv>, kind: ObjectKind): ListParams {
  const rawLimit = c.req.query('limit');
  let limit = DEFAULT_LIST_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      throw errors.invalidRequest(
        `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
        'limit',
        'parameter_invalid',
      );
    }
    limit = parsed;
  }

  const rawCursor = c.req.query('starting_after');
  let startingAfter: string | null = null;
  if (rawCursor !== undefined && rawCursor !== '') {
    const decoded = decodeId(kind, rawCursor);
    if (!decoded) {
      // Says what is actually checked: the shape and the object kind. Existence is not
      // verified: an id that never existed simply yields the page after it, and one from
      // another project yields nothing, because RLS hides the rows either way.
      throw errors.invalidRequest(
        `starting_after must be a ${kind} identifier.`,
        'starting_after',
        'parameter_invalid',
      );
    }
    startingAfter = decoded;
  }

  return { limit, startingAfter };
}

/**
 * Every value of a repeatable query parameter, in the two spellings the API accepts.
 *
 * `?type[]=a&type[]=b` is the documented form (it is the one `expand[]` already uses and the
 * one every HTTP library produces for an array), and `?type=a&type=b` is accepted next to it
 * because it is what a person types by hand. A single `?type=a` therefore comes back as a
 * one-element array and nothing about the old contract changes.
 */
export function repeatedQuery(c: Context<AppEnv>, name: string): string[] {
  return [...(c.req.queries(`${name}[]`) ?? []), ...(c.req.queries(name) ?? [])];
}

/** `?expand[]=requirements&expand[]=schedule`; the bare `expand=` form is accepted too. */
export function parseExpand(c: Context<AppEnv>, allowed: readonly string[]): Set<string> {
  const values = [...(c.req.queries('expand[]') ?? []), ...(c.req.queries('expand') ?? [])];
  const result = new Set<string>();
  for (const value of values) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!allowed.includes(trimmed)) {
        throw errors.invalidRequest(
          `Cannot expand "${trimmed}". Expandable: ${allowed.join(', ') || 'nothing'}.`,
          'expand',
          'parameter_invalid',
        );
      }
      result.add(trimmed);
    }
  }
  return result;
}

/** Path parameter -> UUID, with a 404 (never a 400) for a well formed id of the wrong kind. */
export function pathId(
  c: Context<AppEnv>,
  kind: ObjectKind,
  objectName: string,
  name = 'id',
): string {
  const raw = c.req.param(name) ?? '';
  const decoded = decodeId(kind, raw);
  if (!decoded) throw errors.notFound(objectName, raw);
  return decoded;
}

export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

/** Cursor pagination: fetch one extra row to know whether another page exists. */
export function paginate<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export function listEnvelope<T>(page: T[], hasMore: boolean): ListEnvelope<T> {
  return { object: 'list', data: page, has_more: hasMore };
}

export interface DeletedEnvelope {
  id: string;
  object: string;
  deleted: true;
}

export function deletedEnvelope(id: string, object: string): DeletedEnvelope {
  return { id, object, deleted: true };
}

/** INSERT ... RETURNING always yields exactly one row; anything else is a bug, not a 4xx. */
export function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw errors.internal('Expected the database to return a row.');
  return row;
}
