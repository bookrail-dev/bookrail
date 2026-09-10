/** A database of its own, so this suite never races the API or engine suites. */
export const TEST_DB_NAME = process.env.TEST_CLI_DATABASE_NAME ?? 'bookrail_test_cli';
