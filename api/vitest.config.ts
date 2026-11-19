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
          // Files run four at a time, each worker on its own database and Valkey db (helpers/server.ts testWorker, pinned
          // by test/harness.int.test.ts); Valkey has 16 dbs, so this stays at 15 or under. Its own groupOrder, since
          // vitest runs projects with different maxWorkers in separate groups: the unit project first, then this one.
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
