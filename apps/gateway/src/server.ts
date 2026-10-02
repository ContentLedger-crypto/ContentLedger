import { serve } from '@hono/node-server'
import { Connection } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { z } from 'zod'
import { createApp } from './app.js'
import { offerStore } from './offers.js'
import { fixturesOrigin } from './origin.js'
import { rpcPayments } from './payments.js'
import { rpcRegistry } from './registry.js'
import { contentRoutes } from './routes/content.js'
import { publicRoutes } from './routes/public.js'
import { quoteRoutes } from './routes/quote.js'

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    DATABASE_URL: z.url(),
    FIXTURES_BASE_URL: z.url(),
    PORT: z.coerce.number().int().positive().default(8879),
  })
  .parse(process.env)

const OFFER_TTL_MS = 60_000
const OFFER_MAX_BYTES = 32 * 1024 * 1024

// The transaction pooler (6543) does not keep prepared statements across transactions.
const sql = postgres(env.DATABASE_URL, { prepare: false })
const db = drizzle(sql)
const registry = rpcRegistry(new Connection(env.SOLANA_RPC_URL, 'confirmed'))
const now = () => new Date()

const app = createApp(
  quoteRoutes(registry),
  contentRoutes({
    registry,
    db,
    origin: fixturesOrigin(env.FIXTURES_BASE_URL),
    offers: offerStore({ ttlMs: OFFER_TTL_MS, maxBytes: OFFER_MAX_BYTES, now }),
    payments: rpcPayments(env.SOLANA_RPC_URL),
    now,
  }),
  publicRoutes(db),
)
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => void sql.end({ timeout: 5 })))
}
