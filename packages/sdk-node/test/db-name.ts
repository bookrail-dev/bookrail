/** A database of its own, so this suite never races the API, engine, CLI or MCP suites. */
export const TEST_DB_NAME = process.env['TEST_SDK_DATABASE_NAME'] ?? 'bookrail_test_sdk';
