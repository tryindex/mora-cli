import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The Malloy compile check spins up DuckDB, which is slow on a cold start.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
