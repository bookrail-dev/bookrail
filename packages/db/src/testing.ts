import { Client } from 'pg';
import {
  assertSafeIdentifier,
  databaseNameFromUrl,
  resolveDatabaseUrls,
  withDatabaseName,
  type DatabaseUrls,
} from './config.js';
import { migrate } from './migrate.js';

/**
 * Creates a dedicated, empty test database and migrates it.
 *
 * No Docker and no testcontainers on the development machine: the harness talks to the
 * Postgres named by DATABASE_URL, connecting to the `postgres` maintenance database in order
 * to drop and recreate the test database from scratch on every run.
 */
export interface TestDatabase extends DatabaseUrls {
  drop(): Promise<void>;
}

const RETRYABLE_CODES = new Set([
  '55006', // object_in_use: template1 is busy
  '23505', // unique_violation on pg_database_datname_index
  '42P04', // duplicate_database, if a concurrent run won the race
]);

async function withRetry<T>(fn: () => Promise<T>, attempts = 20, delayMs = 150): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!code || !RETRYABLE_CODES.has(code)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const dbName = assertSafeIdentifier(name, 'test database name');
  const base = resolveDatabaseUrls();
  const maintenanceUrl = withDatabaseName(base.admin, 'postgres');

  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await withRetry(() => admin.query(`DROP DATABASE IF EXISTS ${dbName}`));
    // CREATE DATABASE takes a lock on template1, so two packages bootstrapping their test
    // databases at the same time (turbo runs them in parallel) can collide with
    // `source database "template1" is being accessed by other users`. Retry, do not serialise.
    await withRetry(() => admin.query(`CREATE DATABASE ${dbName}`));
  } finally {
    await admin.end();
  }

  const urls = resolveDatabaseUrls({ databaseName: dbName });
  await migrate({ adminUrl: urls.admin, appRole: urls.appRole, jobsRole: urls.jobsRole });

  return {
    ...urls,
    databaseName: databaseNameFromUrl(urls.admin),
    async drop(): Promise<void> {
      const cleanup = new Client({ connectionString: maintenanceUrl });
      await cleanup.connect();
      try {
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await withRetry(() => cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`));
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function dropTestDatabase(name: string): Promise<void> {
  const dbName = assertSafeIdentifier(name, 'test database name');
  const base = resolveDatabaseUrls();
  const admin = new Client({ connectionString: withDatabaseName(base.admin, 'postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await withRetry(() => admin.query(`DROP DATABASE IF EXISTS ${dbName}`));
  } finally {
    await admin.end();
  }
}
