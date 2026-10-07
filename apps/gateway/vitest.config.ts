import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each database suite starts its own PGlite and runs every migration in `beforeAll`;
    // with all of them in parallel on a two-core CI runner that has taken over 10 s.
    hookTimeout: 30_000,
  },
})
