import { fileURLToPath } from 'node:url'

export * from './accepted-at.js'
export * from './schema.js'

/** One SQL history for two targets: Supabase at deploy, PGlite in tests. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

/** The settler notifies inside the batch transaction, so a listener hears only committed batches. */
export const SETTLEMENT_CHANNEL = 'settlement'
