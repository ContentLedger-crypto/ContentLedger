import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/m1.test.ts'],
    testTimeout: 90 * 60_000,
    hookTimeout: 5 * 60_000,
  },
})
