import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/**/*.int.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.int.test.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
