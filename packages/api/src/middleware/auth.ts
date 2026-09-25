import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { apiKeys, withAuthContext, withProjectContext } from '@bookrail/db';
import { errors, planMonthOf, planOf, type Environment } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { parseApiKey } from '../keys.js';
import { PLAN_USAGE_HEADER, planUsageHeader, plansOf } from '../plan.js';
import { isPublicPath } from '../routes/public.js';

/** Exactly the columns `auth_lookup_api_key` returns (migration 0013, extended by 0025). */
interface ApiKeyRow {
  [column: string]: unknown;
  id: string;
  project_id: string;
  environment: Environment;
  kind: 'secret' | 'publishable';
  scopes: string[];
  tenant_id: string | null;
  revoked_at: Date | null;
  account_id: string;
  plan: string;
}

/** Do not write last_used_at more than once a minute per key. */
const LAST_USED_THROTTLE = sql`interval '60 seconds'`;

function extractBearer(c: Context<AppEnv>): string {
  const header = c.req.header('authorization');
  if (!header) {
    throw errors.authentication(
      'No API key provided. Send it as `Authorization: Bearer sk_test_...`.',
      'missing_api_key',
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw errors.authentication(
      'Malformed Authorization header. Expected `Authorization: Bearer sk_test_...`.',
      'invalid_authorization_header',
    );
  }
  return match[1].trim();
}

/**
 * Resolves the bearer token to a project and environment.
 *
 * The lookup runs with an **empty** RLS context, because the project is exactly what we are
 * trying to find out, and an empty context is now what it says on the tin: since migration
 * 0013 the application role sees zero rows in `api_keys` from there, like in every other table.
 * The one read that is still possible is `auth_lookup_api_key`, a `SECURITY DEFINER` function
 * whose result is at most one row and whose columns are exactly the ones below. The policy it
 * replaced (`api_keys_auth_lookup`) granted the whole table instead, and was the only place in
 * the system where a mistake in the RLS context meant "sees everything" rather than "sees
 * nothing".
 *
 * Everything after this middleware runs inside a transaction pinned to the resolved project,
 * `last_used_at` included, which is why that write is still a plain `UPDATE` under
 * `api_keys_project_isolation` and not a second definer function: by then the project is known,
 * so there is nothing to elevate.
 */
export function authenticate(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    // The four families of `/v1` that carry no API key: the sign up endpoints, which are where a
    // key comes from; the dashboard, which manages keys and is opened by a session of its own,
    // checked by its router; the Stripe OAuth callback, which a browser follows and which is tied
    // to its project by a single use `state` instead; and the two Stripe webhook receivers, which
    // Stripe signs. All are listed in `routes/public.ts`, and all are matched exactly:
    // `/v1/signupsx` and `/v1/dashboardx` are different paths and still need a key.
    if (isPublicPath(c.req.path)) return next();

    const token = extractBearer(c);
    const parsed = parseApiKey(token);
    if (!parsed) {
      throw errors.authentication('Invalid API key provided.', 'invalid_api_key');
    }
    // Publishable keys exist in the key model, meant for the browser with a reduced set of
    // permissions, but those reduced permissions do not exist yet. Until they do, a `pk_`
    // key must not open the full server API: refusing is the safe default, granting is not.
    if (parsed.kind === 'publishable') {
      throw errors.authentication(
        'Publishable keys cannot be used on this endpoint.',
        'invalid_api_key',
      );
    }

    const result = await withAuthContext(deps.db, (tx) =>
      tx.execute<ApiKeyRow>(
        sql`SELECT * FROM auth_lookup_api_key(${parsed.keyHash}, ${parsed.prefix})`,
      ),
    );

    const key = result.rows[0];
    if (!key) {
      throw errors.authentication('Invalid API key provided.', 'invalid_api_key');
    }
    if (key.revoked_at !== null) {
      throw errors.authentication('This API key has been revoked.', 'revoked_api_key');
    }
    // Belt and braces: the environment is encoded in the key text and stored on the row.
    if (key.environment !== parsed.environment || key.kind !== 'secret') {
      throw errors.authentication('Invalid API key provided.', 'invalid_api_key');
    }

    const plan = planOf(key.plan);
    c.set('auth', {
      apiKeyId: key.id,
      projectId: key.project_id,
      environment: key.environment,
      kind: key.kind,
      scopes: key.scopes,
      tenantId: key.tenant_id,
      accountId: key.account_id,
      plan,
    });

    const included = plansOf(deps)[plan].bookingsIncluded;
    const usageHeader = await withProjectContext(
      deps.db,
      { projectId: key.project_id, environment: key.environment },
      async (tx) => {
        await tx
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(apiKeys.id, key.id),
              or(
                isNull(apiKeys.lastUsedAt),
                lt(apiKeys.lastUsedAt, sql`now() - ${LAST_USED_THROTTLE}`),
              ),
            ),
          );
        // The `Bookrail-Plan-Usage` header, read in the transaction this request already opens
        // for `last_used_at`, so that it costs one statement and not one more round of BEGIN
        // and COMMIT. Live keys only: the test environment is never counted, and a header
        // there would be a number about somewhere else.
        // Nor for a key scoped to a tenant, which does not see the numbers of the whole account.
        if (key.environment !== 'live' || included === null || key.tenant_id !== null) return null;
        const { rows } = await tx.execute<{ bookings_confirmed: string }>(
          sql`SELECT bookings_confirmed FROM plan_usage_for_account(${key.account_id}::uuid, ${planMonthOf(Date.now())})`,
        );
        return planUsageHeader(Number(rows[0]?.bookings_confirmed ?? 0), included);
      },
    );

    if (usageHeader === null) return next();
    // Written on the response that exists after the route, in `finally`, for the reason
    // `rate-limit.ts` gives for its own headers: the error envelope and a replayed idempotent
    // answer are built by other middlewares and must carry it too. The value is the count at
    // the start of this request; a booking this request makes is in the next one.
    try {
      await next();
    } finally {
      c.res.headers.set(PLAN_USAGE_HEADER, usageHeader);
    }
  };
}
