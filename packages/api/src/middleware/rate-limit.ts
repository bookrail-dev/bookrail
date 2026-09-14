/**
 * A ceiling on how fast one API key may call, applied in front of every authenticated route.
 *
 * ## Where it sits, and why exactly there
 *
 * After `authenticate`, because the thing being limited is a **key** and that is where the key
 * becomes known. Before `idempotency`, for two reasons that are really one: a `429` must never be
 * stored as the answer of an `Idempotency-Key`, since the whole promise of that header is that a
 * retry gets the same answer, and "you were going too fast" is the one answer a retry must be
 * allowed to change; and a refused request must not burn the key either, since nothing happened
 * and the caller is being invited to send the same request again.
 *
 * ## What it counts
 *
 * The API key id, not the project and not the address. Two keys of one project have two buckets:
 * a key is how a caller identifies itself, it is what can be rotated, and a staging deployment
 * hammering its own key must not throttle the production one beside it. A route reached without a
 * key is not counted at all, which today means the sign up endpoints: they are where a key comes
 * from, they have a limit of their own in the database and another in the reverse proxy, and
 * there is no bucket to name for a caller who has nothing yet.
 *
 * ## The headers
 *
 * `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, the three field form of the
 * IETF draft that is already widely deployed, on every authenticated response and not only on a
 * refusal: a client that only learns its budget when it has run out cannot pace itself. No
 * `X-RateLimit-*`: one spelling.
 *
 * They are written **after** the response exists, on `c.res.headers`, rather than with
 * `c.header()` before. The prepared header set of the context is applied only to responses the
 * context itself builds, and the responses that matter most here are the two it does not: the
 * error envelope, which is constructed by the request middleware, and a replayed idempotent
 * answer, which is constructed by the middleware below this one. Setting them the other way round
 * is the bug that left every sign up error without its CORS headers until it was found on a
 * Friday.
 *
 * ## When Redis is not there
 *
 * The request goes through. A rate limiter is a protection, and an unreachable Redis must not
 * become an unreachable API: that would turn a degraded cache into an outage. The response then
 * carries `RateLimit-Policy: unavailable` instead of the three counters, so a client can tell
 * "no limit was applied" from "you have plenty left", and one `warn` line a minute names the
 * class of failure, without the URL and without anything about the caller.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ThrottledWarner } from '@bookrail/engine';
import { errors, REQUEST_ID_HEADER, type BookrailError } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import type { RateLimitDecision } from '../rate-limit.js';

export const RATE_LIMIT_LIMIT_HEADER = 'RateLimit-Limit';
export const RATE_LIMIT_REMAINING_HEADER = 'RateLimit-Remaining';
export const RATE_LIMIT_RESET_HEADER = 'RateLimit-Reset';
export const RATE_LIMIT_POLICY_HEADER = 'RateLimit-Policy';
export const RETRY_AFTER_HEADER = 'Retry-After';

/** The value of `RateLimit-Policy` when no limit could be applied at all. */
export const POLICY_UNAVAILABLE = 'unavailable';

/** How often a degraded limiter may complain. One line a minute, per process. */
export const WARN_WINDOW_MS = 60_000;

export function rateLimitedError(rate: number, burst: number): BookrailError {
  return errors.rateLimited(
    `This key may make ${String(rate)} requests per second, with bursts of ${String(burst)}.`,
    'Wait for Retry-After, or spread the calls. Live keys have higher limits.',
  );
}

export function rateLimit(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const settings = deps.rateLimit;
  const warner = new ThrottledWarner(deps.logger, WARN_WINDOW_MS);

  return async (c: Context<AppEnv>, next) => {
    // Switched off for this deployment: no header, no call, nothing to say.
    if (settings === undefined) return next();

    // No key, no bucket. The sign up endpoints are the only routes of `/v1` that get here
    // without one, and they are limited by address in the reverse proxy and by address and
    // mailbox in the database.
    const auth = c.get('auth');
    if (auth === undefined) return next();

    const policy = settings.limits[auth.environment];
    let decision: RateLimitDecision;
    try {
      decision = await settings.limiter.check(auth.apiKeyId, policy.rate, policy.burst, Date.now());
    } catch (error) {
      warner.warn('rate_limiter_degraded', {
        limiter: settings.limiter.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await next();
      } finally {
        c.res.headers.set(RATE_LIMIT_POLICY_HEADER, POLICY_UNAVAILABLE);
      }
      return;
    }

    if (!decision.allowed) {
      const error = rateLimitedError(policy.rate, policy.burst);
      const requestId = c.get('requestId');
      c.set('errorCode', error.code);
      // One line per refusal, with the key id and never the key, so that a caller hitting the
      // ceiling is visible without the access log having to be joined to anything.
      deps.logger.info('rate_limited', {
        request_id: requestId,
        api_key_id: auth.apiKeyId,
        project_id: auth.projectId,
        environment: auth.environment,
        method: c.req.method,
        path: c.req.path,
        rate: policy.rate,
        burst: policy.burst,
        retry_after_ms: Math.round(decision.retryAfterMs),
      });
      return new Response(JSON.stringify(error.toPayload(requestId)), {
        status: error.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          [REQUEST_ID_HEADER]: requestId,
          [RETRY_AFTER_HEADER]: String(retryAfterSeconds(decision.retryAfterMs)),
          ...headersOf(decision),
        },
      });
    }

    // `finally`, not a plain statement after `await next()`: a route that throws is answered by
    // the error envelope of the request middleware, and the counters belong on that answer too.
    // Reading `c.res` here builds the empty response the context would have built anyway, and
    // the error envelope inherits its headers when it replaces it.
    try {
      await next();
    } finally {
      for (const [name, value] of Object.entries(headersOf(decision))) {
        c.res.headers.set(name, value);
      }
    }
  };
}

/** `Retry-After` is whole seconds, and never zero: a wait of 200 ms is asked for as one second. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** The three counters. `RateLimit-Reset` is whole seconds, rounded up. */
export function headersOf(decision: RateLimitDecision): Record<string, string> {
  return {
    [RATE_LIMIT_LIMIT_HEADER]: String(decision.limit),
    [RATE_LIMIT_REMAINING_HEADER]: String(decision.remaining),
    [RATE_LIMIT_RESET_HEADER]: String(Math.ceil(decision.resetMs / 1000)),
  };
}
