import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { TEST_DB_NAME } from './db-name.js';

/**
 * Where the contract guard appends the operations it saw answer with a success status.
 *
 * A **file** rather than a counter in memory, because Vitest runs each test file in its own
 * worker with its own module registry: an array in `contract.ts` would be emptied between one
 * file and the next, and the coverage check would only ever see the last suite. Derived from
 * the test database name so two runs against different databases cannot mix their counts, and
 * placed in the system temporary directory so it never lands in the repository.
 */
export const COVERAGE_FILE = resolve(tmpdir(), `bookrail-openapi-coverage-${TEST_DB_NAME}.txt`);
