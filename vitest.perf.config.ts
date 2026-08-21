import { defineConfig } from 'vitest/config';

/** The stress suite runs on demand: `npm run test:perf`. */
export default defineConfig({
  test: { include: ['test/perf.test.ts'], testTimeout: 120_000 },
});
