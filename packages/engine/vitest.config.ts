import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The availability suites read from a real Postgres, so the package needs
    // the same throwaway database the db and api packages create. The timeline, schedule and
    // DST suites stay pure and do not touch it.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
