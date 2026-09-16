import { defineConfig } from 'drizzle-kit'

// `generate` мережі не потребує — знімок збирається зі схеми. `DATABASE_URL`
// потрібен лише для `migrate`/`push`, і його запускає деплой (T061), не гейт.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/contentledger' },
})
