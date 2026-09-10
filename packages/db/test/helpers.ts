import { Client } from 'pg';
import { resolveDatabaseUrls, type DatabaseUrls } from '../src/config.js';
import { TEST_DB_NAME } from './db-name.js';

export function testUrls(): DatabaseUrls {
  return resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
}

export async function adminClient(): Promise<Client> {
  const client = new Client({ connectionString: testUrls().admin });
  await client.connect();
  return client;
}

/** A connection as `bookrail_app`: no superuser, no BYPASSRLS, so RLS actually applies. */
export async function appClient(): Promise<Client> {
  const client = new Client({ connectionString: testUrls().app });
  await client.connect();
  return client;
}

export interface ProjectScope {
  projectId: string;
  environment: 'test' | 'live';
}

/** Runs a callback inside a transaction with the RLS settings of `scope`. */
export async function asProject<T>(
  client: Client,
  scope: ProjectScope,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('app.project_id', $1, true), set_config('app.environment', $2, true)`,
      [scope.projectId, scope.environment],
    );
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Same, but keeps the transaction open so a failing statement can be observed and rolled back. */
export async function beginAsProject(client: Client, scope: ProjectScope): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.project_id', $1, true), set_config('app.environment', $2, true)`,
    [scope.projectId, scope.environment],
  );
}

export interface PgFailure {
  code: string;
  message: string;
}

export async function expectPgError(promise: Promise<unknown>): Promise<PgFailure> {
  try {
    await promise;
  } catch (error) {
    const pg = error as { code?: string; message?: string };
    return { code: pg.code ?? 'unknown', message: pg.message ?? String(error) };
  }
  throw new Error('Expected the statement to fail, but it succeeded.');
}
