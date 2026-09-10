import { createTestDatabase, dropTestDatabase } from '../src/testing.js';
import { TEST_DB_NAME } from './db-name.js';

export async function setup(): Promise<void> {
  await createTestDatabase(TEST_DB_NAME);
}

export async function teardown(): Promise<void> {
  await dropTestDatabase(TEST_DB_NAME);
}
