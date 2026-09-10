import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
