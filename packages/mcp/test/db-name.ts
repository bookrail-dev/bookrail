/** A database of its own, so this suite never races the API, engine or CLI suites. */
export const TEST_DB_NAME = process.env.TEST_MCP_DATABASE_NAME ?? 'bookrail_test_mcp';
