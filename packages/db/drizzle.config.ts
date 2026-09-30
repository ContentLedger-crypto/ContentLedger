import { defineConfig } from 'drizzle-kit'

// `generate` builds the snapshot from the schema and needs no network. The URL is read
// only by `migrate`/`push`, run by the deploy, not the gate; they need session mode,
// since DDL does not survive the transaction pooler that `DATABASE_URL` points at.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? 'postgres://localhost:5432/contentledger',
  },
})
