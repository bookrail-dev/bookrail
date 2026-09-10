/**
 * The contract guard: every response of the test suite, validated against the schema the
 * specification declares for it.
 *
 * A schema of a response is worth nothing if nothing checks that the server respects it. This
 * middleware closes that gap without a second test suite: it sits outermost in the test app,
 * finds the operation from the **matched route** (Hono's own `matchedRoutes`, never a regular
 * expression over the path), and parses the body with the Zod schema the registry declares for
 * that status. A field the schema does not know about fails, because every response schema is
 * `.strict()`; a status the operation does not declare fails; an error code the operation does
 * not list fails.
 *
 * **It is never mounted in production.** `server.ts` does not pass the flag, and it could not:
 * the cost is a second full validation of every response, and the value (proving the document
 * is true) is entirely a build-time value. `AppDeps.contractGuard` follows
 * `allowPrivateWebhookTargets`: a flag that only code can set, never the environment.
 *
 * **How a violation is reported.** Throwing here would be caught by `app.onError` and turned
 * into a 500, which is exactly the shape of failure that hides a bug. So a violation is
 * recorded in a module-level list instead, and `test/harness.ts` throws it in the test that made
 * the call, where the stack trace names the request, and where a failure cannot be mistaken for
 * an expected error response.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { appendFileSync } from 'node:fs';
import type { AppEnv } from '../context.js';
import { errorSchema } from '../schemas/responses.js';
import { errorCodesOf } from './generate.js';
import { honoPathToOpenApi, operationFor, type OperationDefinition } from './registry.js';

/** Where the coverage recorder appends the operations it saw succeed. */
export const COVERAGE_FILE_ENV = 'BOOKRAIL_CONTRACT_COVERAGE';

const violations: string[] = [];

/** Empties and returns the violations recorded since the last call. */
export function takeContractViolations(): string[] {
  return violations.splice(0, violations.length);
}

function record(message: string): void {
  violations.push(message);
}

/**
 * The route Hono actually matched, in OpenAPI form.
 *
 * `c.req.routePath` is the path of the *current* handler, which inside a middleware is `*`.
 * `matchedRoutes` is the whole chain, so the last entry that is not a wildcard middleware is
 * the handler that ran, or, when the request failed in `authenticate`, the handler that would
 * have run, which is the operation the caller was asking for and the one whose error codes are
 * being checked.
 */
function matchedOperation(c: Context<AppEnv>): OperationDefinition | undefined {
  const routes = c.req.matchedRoutes;
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index];
    if (route === undefined) continue;
    if (route.method === 'ALL') continue;
    if (route.path === '*' || route.path.endsWith('/*')) continue;
    return operationFor(c.req.method, honoPathToOpenApi(route.path));
  }
  return undefined;
}

function issues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function contractGuard(): MiddlewareHandler<AppEnv> {
  const coverageFile = process.env[COVERAGE_FILE_ENV];

  return async (c: Context<AppEnv>, next) => {
    await next();

    const operation = matchedOperation(c);
    if (operation === undefined) return;

    const status = c.res.status;
    const declared = operation.responses[status];
    const isError = status >= 400;
    if (declared === undefined && !isError) {
      record(
        `${operation.operationId} answered ${String(status)}, which the registry does not declare.`,
      );
      return;
    }

    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      record(`${operation.operationId} answered ${String(status)} with a body that is not JSON.`);
      return;
    }

    if (declared !== undefined) {
      const parsed = declared.safeParse(body);
      if (!parsed.success) {
        record(
          `${operation.operationId} ${String(status)} does not match its schema: ${issues(parsed.error)}`,
        );
        return;
      }
      if (status < 400 && coverageFile !== undefined) {
        appendFileSync(coverageFile, `${operation.operationId}\n`);
      }
      return;
    }

    const parsed = errorSchema.safeParse(body);
    if (!parsed.success) {
      record(
        `${operation.operationId} ${String(status)} is not the documented error envelope: ${issues(parsed.error)}`,
      );
      return;
    }
    const allowed = new Set(errorCodesOf(operation));
    if (!allowed.has(parsed.data.error.code)) {
      record(
        `${operation.operationId} answered ${String(status)} \`${parsed.data.error.code}\`, ` +
          `which is not among the error codes the registry declares for it ` +
          `(${[...allowed].join(', ')}).`,
      );
    }
  };
}
