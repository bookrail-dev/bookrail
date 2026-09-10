import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Environment } from '@bookrail/shared';
import { schema } from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ProjectContext {
  projectId: string;
  environment: Environment;
}

export interface CreatePoolOptions extends Omit<PoolConfig, 'connectionString'> {
  connectionString: string;
}

export function createPool(options: CreatePoolOptions): Pool {
  return new Pool({ max: 10, ...options });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/**
 * How the transaction is opened. Passed straight to `BEGIN`, so the isolation level is set
 * by the `BEGIN` itself and not by a `SET TRANSACTION` statement, which Postgres refuses
 * once the first query (here, `set_config`) has run.
 */
export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
}

/**
 * Opens a transaction and pins the RLS context to it.
 *
 * `set_config(..., true)` is transaction-local: it is undone at COMMIT or ROLLBACK, so a
 * pooled connection can never leak one project's context into the next request.
 */
export async function withProjectContext<T>(
  db: Database,
  ctx: ProjectContext,
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.project_id', ${ctx.projectId}, true),
                 set_config('app.environment', ${ctx.environment}, true)`,
    );
    return fn(tx);
  }, options);
}

/**
 * Transaction with an explicitly empty context, used to resolve an API key before the project
 * is known. Only the `api_keys_auth_lookup` policy can match here, and it is SELECT-only.
 */
export async function withAuthContext<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.project_id', '', true),
                 set_config('app.environment', '', true)`,
    );
    return fn(tx);
  });
}
