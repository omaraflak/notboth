import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  build: { target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts'],
    // The stress suite is heavy and deliberate; run it with `npm run test:perf`.
    exclude: ['**/node_modules/**', 'test/perf.test.ts'],
  },
});
