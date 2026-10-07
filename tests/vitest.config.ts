import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts', 'repo/**/*.test.ts'],
    // The milestone runs spend devnet SOL and take a long while: `pnpm e2e:m1`, `pnpm e2e:m2`, never the gate.
    exclude: ['e2e/m1.test.ts', 'e2e/m2.test.ts'],
  },
})
