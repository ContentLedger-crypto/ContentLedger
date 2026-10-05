import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    // The milestone runs spend devnet SOL and take most of an hour: `pnpm e2e:m1`, never the gate.
    exclude: ['e2e/m1.test.ts'],
  },
})
