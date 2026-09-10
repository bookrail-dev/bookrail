import type { Context, MiddlewareHandler } from 'hono';
import {
  API_VERSION_HEADER,
  CURRENT_API_VERSION,
  isSupportedApiVersion,
  newRequestId,
  REQUEST_ID_HEADER,
  BookrailError,
  errors,
} from '@bookrail/shared';
import { ACTOR_HEADER, API_ACTORS, type ApiActor, type AppDeps, type AppEnv } from '../context.js';
import { translatePgError } from '../pg-errors.js';

function toBookrailError(error: unknown, deps: AppDeps, requestId: string): BookrailError {
  if (error instanceof BookrailError) return error;
  const translated = translatePgError(error);
  if (translated) return translated;
  deps.logger.error('unhandled_error', {
    request_id: requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return errors.internal();
}

function errorResponse(error: BookrailError, requestId: string, apiVersion: string): Response {
  return new Response(JSON.stringify(error.toPayload(requestId)), {
    status: error.status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      [REQUEST_ID_HEADER]: requestId,
      [API_VERSION_HEADER]: apiVersion,
    },
  });
}

/**
 * Outermost middleware: assigns the request id, negotiates the API version, converts every
 * failure into the documented error envelope, and writes exactly one structured log line.
 * Bodies are never logged.
 */
export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const requestId = newRequestId();
    c.set('requestId', requestId);
    c.set('apiVersion', CURRENT_API_VERSION);

    const startedAt = Date.now();
    let failed: BookrailError | null = null;

    try {
      // Validated here, before authentication and before any route runs: an invalid actor must
      // never reach a write, because the point of the header is what lands in the append-only
      // event log. Absent leaves the variable unset, which is what the routes read.
      const declaredActor = c.req.header(ACTOR_HEADER);
      if (declaredActor !== undefined && declaredActor !== '') {
        if (!(API_ACTORS as readonly string[]).includes(declaredActor)) {
          throw errors.invalidRequest(
            `Unknown actor "${declaredActor}". ${ACTOR_HEADER} accepts: ${API_ACTORS.join(', ')}.`,
            ACTOR_HEADER,
            'parameter_invalid',
          );
        }
        c.set('actorVia', declaredActor as ApiActor);
      }

      const requested = c.req.header(API_VERSION_HEADER);
      if (requested !== undefined && requested !== '') {
        if (!isSupportedApiVersion(requested)) {
          throw errors.invalidRequest(
            `Unsupported API version "${requested}". Supported: ${CURRENT_API_VERSION}.`,
            API_VERSION_HEADER,
            'unsupported_api_version',
          );
        }
        c.set('apiVersion', requested);
      }
      await next();
    } catch (error) {
      // Reached only when the failure escapes Hono's own compose-level error handling.
      failed = toBookrailError(error, deps, requestId);
      c.set('errorCode', failed.code);
      c.res = errorResponse(failed, requestId, c.get('apiVersion'));
    }

    c.res.headers.set(REQUEST_ID_HEADER, requestId);
    c.res.headers.set(API_VERSION_HEADER, c.get('apiVersion'));

    const auth = c.get('auth');
    deps.logger.info('request', {
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
      api_version: c.get('apiVersion'),
      // The access log carries the declared actor too: it is the field that answers "was this
      // the MCP server or the customer's own code" without opening the event log.
      actor_via: c.get('actorVia') ?? null,
      project_id: auth?.projectId ?? null,
      environment: auth?.environment ?? null,
      api_key_id: auth?.apiKeyId ?? null,
      error_code: failed?.code ?? c.get('errorCode') ?? null,
    });
  };
}

/** 404 for unknown routes, in the same envelope as everything else. */
export function notFoundHandler(c: Context<AppEnv>): Response {
  const requestId = c.get('requestId') ?? newRequestId();
  const error = new BookrailError(
    'not_found',
    'unknown_endpoint',
    `Unrecognized request URL (${c.req.method} ${c.req.path}).`,
  );
  c.set('errorCode', error.code);
  return errorResponse(error, requestId, c.get('apiVersion') ?? CURRENT_API_VERSION);
}

/** Safety net: reached only if requestContext itself throws. */
export function errorHandler(deps: AppDeps) {
  return (error: Error, c: Context<AppEnv>): Response => {
    const requestId = c.get('requestId') ?? newRequestId();
    const bookrail = toBookrailError(error, deps, requestId);
    c.set('errorCode', bookrail.code);
    return errorResponse(bookrail, requestId, c.get('apiVersion') ?? CURRENT_API_VERSION);
  };
}
