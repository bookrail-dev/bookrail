import { Hono } from 'hono';
import { CURRENT_API_VERSION } from '@bookrail/shared';
import type { AppDeps, AppEnv } from './context.js';
import { authenticate } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { errorHandler, notFoundHandler, requestContext } from './middleware/request.js';
import { contractGuard } from './openapi/contract.js';
import { openApiDocument } from './openapi/generate.js';
import { availabilityRoutes } from './routes/availability.js';
import { bookingsRoutes } from './routes/bookings.js';
import { customersRoutes } from './routes/customers.js';
import { eventsRoutes } from './routes/events.js';
import { holdsRoutes } from './routes/holds.js';
import { internalRoutes } from './routes/internal.js';
import { locationsRoutes } from './routes/locations.js';
import { policiesRoutes } from './routes/policies.js';
import { projectRoutes } from './routes/project.js';
import { resourceGroupsRoutes } from './routes/resource-groups.js';
import { resourcesRoutes } from './routes/resources.js';
import { schedulesRoutes } from './routes/schedules.js';
import { servicesRoutes } from './routes/services.js';
import { signupsRoutes } from './routes/signups.js';
import { webhooksRoutes } from './routes/webhooks.js';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Outermost, and only in the test app: a violation recorded here must not be swallowed by
  // the error handling below and turned into a 500 (see `openapi/contract.ts`).
  if (deps.contractGuard === true) app.use('*', contractGuard());

  app.use('*', requestContext(deps));
  app.notFound(notFoundHandler);
  app.onError(errorHandler(deps));

  app.get('/health', (c) => c.json({ status: 'ok', api_version: CURRENT_API_VERSION }));

  /**
   * The specification of this API, generated from the same Zod schemas the routes validate and
   * serialize with (`src/openapi/generate.ts`).
   *
   * **No API key.** A client reads the contract before it has one, and the document contains
   * nothing a customer owns. **Generated, not read from disk**: the built process would have to
   * resolve a path that differs between `src/` and `dist/`, and `openapi.test.ts` proves that
   * `openapi/openapi.json` is byte for byte this document, so there is no stale answer to serve.
   */
  app.get('/openapi.json', (c) => {
    c.header('cache-control', 'public, max-age=3600');
    return c.json(openApiDocument());
  });

  if (deps.bootstrapToken) {
    app.route('/internal', internalRoutes(deps));
  }

  const v1 = new Hono<AppEnv>();
  v1.use('*', authenticate(deps));
  // Every POST of /v1 honours `Idempotency-Key`, availability included: an SDK with a retry
  // policy sends it on every write, and one endpoint answering differently would be a trap.
  v1.use('*', idempotency(deps));
  // The one part of `/v1` with no key in front of it, and the reason both middlewares above
  // carry an exemption: this is where a key comes from, so there cannot be one yet.
  v1.route('/signups', signupsRoutes(deps));
  v1.route('/project', projectRoutes(deps));
  v1.route('/availability', availabilityRoutes(deps));
  v1.route('/locations', locationsRoutes(deps));
  v1.route('/resources', resourcesRoutes(deps));
  v1.route('/resource_groups', resourceGroupsRoutes(deps));
  v1.route('/schedules', schedulesRoutes(deps));
  v1.route('/services', servicesRoutes(deps));
  v1.route('/policies', policiesRoutes(deps));
  v1.route('/customers', customersRoutes(deps));
  v1.route('/holds', holdsRoutes(deps));
  v1.route('/bookings', bookingsRoutes(deps));
  v1.route('/events', eventsRoutes(deps));
  v1.route('/webhooks', webhooksRoutes(deps));

  app.route('/v1', v1);

  return app;
}
