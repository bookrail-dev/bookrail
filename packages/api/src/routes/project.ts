/**
 * `GET /v1/project`: what the calling key is.
 *
 * The API had no way of answering "who am I". Every other route needs the caller to already
 * know which project it is talking to, which is fine for an integration with the id in its
 * configuration and useless for a CLI, an MCP server or a person pasting a key into a terminal:
 * `bookrail whoami` could only prove a key worked by making an unrelated list succeed, and
 * `doctor` had to declare "project" as a check it could not run.
 *
 * Three decisions worth naming:
 *
 *  1. **Singular, and no id in the path.** The key *is* the selector. `GET /v1/projects/{id}`
 *     would invite a caller to pass someone else's id and learn something from the difference
 *     between 404 and 403; here there is nothing to pass.
 *  2. **The key's own attributes are nested under `api_key`.** `tenant_id` and `scopes` belong
 *     to the credential, not to the project (two keys of the same project can carry different
 *     ones), and flattening them would say otherwise.
 *  3. **No secret, not even a prefix of one.** `id` and `environment` identify the credential
 *     for support; the `prefix` column is a lookup detail and stays out.
 *  4. **The plan and this month's usage of it are here**, because "where do I stand" is part of
 *     "who am I" once a plan can refuse a booking. The usage is the account's, summed over its
 *     projects, and always the live numbers, whichever key asks: a key of the test environment
 *     is how somebody exploring finds out how far the account is from the threshold. A key
 *     scoped to a tenant gets `usage: null`: the numbers are the whole account's.
 *
 * `projects` is control-plane: the application role has `SELECT` and nothing else (migration
 * 0007), and the table carries no `project_id` column and therefore no RLS policy, so the
 * `WHERE id = auth.projectId` here *is* the isolation, and it comes from the authenticated key
 * rather than from anything the caller sent.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { projects } from '@bookrail/db';
import { CURRENT_API_VERSION, encodeId, errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { inProject } from '../http.js';
import { plansOf, usagePayload } from '../plan.js';

export function projectRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', async (c) => {
    const payload = await inProject(c, deps, async (tx, auth) => {
      const rows = await tx.select().from(projects).where(eq(projects.id, auth.projectId)).limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: encodeId('project', row.id),
        object: 'project' as const,
        name: row.name,
        environment: auth.environment,
        api_version: c.get('apiVersion') ?? CURRENT_API_VERSION,
        default_timezone: row.defaultTimezone,
        default_currency: row.defaultCurrency,
        api_key: {
          id: encodeId('api_key', auth.apiKeyId),
          object: 'api_key' as const,
          kind: auth.kind,
          environment: auth.environment,
          scopes: auth.scopes,
          tenant_id: auth.tenantId,
        },
        plan: auth.plan,
        // Not for a key scoped to a tenant: the usage is the whole account's, summed over its
        // projects, and a key handed to one tenant of a marketplace must not read the
        // marketplace's volume of business.
        usage:
          auth.tenantId === null
            ? await usagePayload(tx, plansOf(deps), auth.accountId, auth.plan, Date.now())
            : null,
        created_at: row.createdAt.toISOString(),
      };
    });
    // A key whose project row has vanished is a broken control plane, not a client mistake.
    if (payload === null) {
      throw errors.internal('The project this key belongs to could not be read.');
    }
    return c.json(payload);
  });

  return routes;
}
