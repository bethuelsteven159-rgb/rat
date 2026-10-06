import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before any test module (and therefore before src/config.ts) loads,
    // keeping test artifacts out of the real data/ directory.
    setupFiles: ['./test/setupEnv.ts'],
    // The end-to-end suite clones and parses real git repositories.
    testTimeout: 30_000,
  },
});
