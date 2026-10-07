import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/m2.test.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 5 * 60_000,
  },
})
