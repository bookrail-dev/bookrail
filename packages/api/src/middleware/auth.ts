import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { apiKeys, withAuthContext, withProjectContext } from '@bookrail/db';
import { errors, type Environment } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { parseApiKey } from '../keys.js';

/** Exactly the columns `auth_lookup_api_key` returns (migration 0013). */
interface ApiKeyRow {
  [column: string]: unknown;
  id: string;
  project_id: string;
  environment: Environment;
  kind: 'secret' | 'publishable';
  scopes: string[];
  tenant_id: string | null;
  revoked_at: Date | null;
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

    c.set('auth', {
      apiKeyId: key.id,
      projectId: key.project_id,
      environment: key.environment,
      kind: key.kind,
      scopes: key.scopes,
      tenantId: key.tenant_id,
    });

    await withProjectContext(
      deps.db,
      { projectId: key.project_id, environment: key.environment },
      (tx) =>
        tx
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
          ),
    );

    await next();
  };
}
