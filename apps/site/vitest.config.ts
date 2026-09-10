import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    // Every suite reads the same `dist` and two of them drive a browser: one file at a time.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
