import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createTestDatabase, dropTestDatabase } from '@bookrail/db/testing';
import { OPERATIONS } from '../src/openapi/registry.js';
import { COVERAGE_FILE } from './coverage-file.js';
import { TEST_DB_NAME } from './db-name.js';

export async function setup(): Promise<void> {
  writeFileSync(COVERAGE_FILE, '', 'utf8');
  await createTestDatabase(TEST_DB_NAME);
}

/**
 * Every operation of the registry must have answered with a success status at least once.
 *
 * The same rule the MCP tools live under: an operation no test ever calls is
 * an operation whose schema nothing has checked, and a specification full of those is a
 * specification that is true only where somebody happened to look. The check runs here, after
 * the last test file, because that is the only place in a Vitest run that sees the whole suite.
 */
export async function teardown(): Promise<void> {
  await dropTestDatabase(TEST_DB_NAME);

  const hit = new Set(
    readFileSync(COVERAGE_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  rmSync(COVERAGE_FILE, { force: true });

  const missing = OPERATIONS.filter((operation) => !hit.has(operation.operationId)).map(
    (operation) => `${operation.method.toUpperCase()} ${operation.path} (${operation.operationId})`,
  );
  if (missing.length > 0) {
    throw new Error(
      `${String(missing.length)} operation(s) of the OpenAPI registry were never exercised with a ` +
        `success status by the test suite:\n  ${missing.join('\n  ')}\n` +
        'Every operation needs a test that calls it, or its response schema is unproven.',
    );
  }
}
