import { Hono } from 'hono';
import { errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { createBootstrap } from '../bootstrap.js';
import { parseJsonBody } from '../http.js';
import { secretEquals } from '../keys.js';
import { bootstrapSchema } from '../schemas/index.js';

/**
 * Internal, non-public endpoint used by the local setup and by the test harness to create an
 * account, a project and one secret key per environment. It is registered only when
 * BOOKRAIL_BOOTSTRAP_TOKEN is set, and it is the only route that runs on the admin connection:
 * accounts and projects are not writable by the RLS-bound application role.
 *
 * **It is not mounted in production**: neither the token nor the owner
 * connection string is in `api.env` any more, so the process exposed to the internet holds
 * neither. The same work is done there by
 * `bookrail-bootstrap`, a command run over SSH that opens the connection, creates, prints and
 * dies. The two share `createBootstrap`, so there is one implementation and one behaviour.
 */
export function internalRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/bootstrap', async (c) => {
    const expected = deps.bootstrapToken;
    if (!expected) throw errors.notFound('endpoint', '/internal/bootstrap');

    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1] || !secretEquals(match[1].trim(), expected)) {
      throw errors.authentication('Invalid bootstrap token.', 'invalid_bootstrap_token');
    }

    const body = await parseJsonBody(c, bootstrapSchema);
    return c.json(await createBootstrap(deps.adminDb, body), 201);
  });

  return routes;
}
