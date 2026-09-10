/**
 * Connection configuration.
 *
 * Two roles, on purpose:
 *  - the admin URL (a superuser) runs migrations and the bootstrap endpoint. It bypasses RLS.
 *  - the app URL (`bookrail_app`, NOSUPERUSER NOBYPASSRLS) is what the API and the integration
 *    tests use. Everything that goes through it is subject to Row Level Security.
 *
 * `DATABASE_URL` alone is enough to get going: the app URL is derived from it by swapping the
 * user, so `DATABASE_URL=postgres://localhost:5432/bookrail_dev pnpm test` still exercises RLS.
 */

export const DEFAULT_APP_ROLE = 'bookrail_app';

/**
 * The role pg-boss connects as. It owns the `pgboss` schema and nothing else: the worker
 * delivers webhooks to the public internet, so the connection it holds for its own queue must
 * not be the one that can read every tenant's rows.
 */
export const DEFAULT_JOBS_ROLE = 'bookrail_jobs';

export interface DatabaseUrls {
  admin: string;
  app: string;
  appRole: string;
  jobsRole: string;
  databaseName: string;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

export function assertSafeIdentifier(value: string, what: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(value)} is not a bare SQL identifier.`);
  }
  return value;
}

export function databaseNameFromUrl(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!name) throw new Error(`Connection string has no database name: ${redactUrl(url)}`);
  return name;
}

export function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}

/** Same host and database, different role. Password only when APP_DB_PASSWORD is set. */
export function deriveAppUrl(adminUrl: string, role: string, password?: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = encodeURIComponent(role);
  parsed.password = password ? encodeURIComponent(password) : '';
  return parsed.toString();
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid connection string>';
  }
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the database name in both URLs; used by the test harness. */
  databaseName?: string;
}

export function resolveDatabaseUrls(options: ResolveOptions = {}): DatabaseUrls {
  const env = options.env ?? process.env;
  const base = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!base) {
    throw new Error('DATABASE_URL (or DATABASE_ADMIN_URL) must be set.');
  }
  const appRole = assertSafeIdentifier(env.APP_DB_ROLE ?? DEFAULT_APP_ROLE, 'APP_DB_ROLE');
  const jobsRole = assertSafeIdentifier(env.JOBS_DB_ROLE ?? DEFAULT_JOBS_ROLE, 'JOBS_DB_ROLE');

  let admin = base;
  let app = env.DATABASE_APP_URL ?? deriveAppUrl(base, appRole, env.APP_DB_PASSWORD);

  if (options.databaseName) {
    admin = withDatabaseName(admin, options.databaseName);
    app = withDatabaseName(app, options.databaseName);
  }

  return { admin, app, appRole, jobsRole, databaseName: databaseNameFromUrl(admin) };
}
