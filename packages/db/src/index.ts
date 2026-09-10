export * from './config.js';
export * from './client.js';
export * from './migrate.js';
export * from './schema/index.js';

/**
 * Re-exported so that a package which only needs to write SQL against a `Transaction` (the
 * availability engine) does not have to depend on Drizzle itself.
 */
export { sql } from 'drizzle-orm';
