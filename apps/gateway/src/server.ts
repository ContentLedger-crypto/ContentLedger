import { SETTLEMENT_CHANNEL } from '@contentledger/db'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Connection } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { z } from 'zod'
import { createApp } from './app.js'
import { offerStore } from './offers.js'
import { fixturesOrigin } from './origin.js'
import { rpcPayments } from './payments.js'
import { publisherFeed } from './publisher/feed.js'
import { listenForSettlements, notifyThrough, postgresListen } from './publisher/listen.js'
import { clientAddress, tokenBucket } from './rate-limit.js'
import { rpcOwnedWorks, rpcRegistry } from './registry.js'
import { authRoutes } from './routes/auth.js'
import { contentRoutes } from './routes/content.js'
import { publicRoutes } from './routes/public.js'
import { publisherRoutes } from './routes/publisher.js'
import { quoteRoutes } from './routes/quote.js'

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    DATABASE_URL: z.url(),
    // LISTEN needs a session of its own; the transaction pooler hands each statement elsewhere.
    DATABASE_LISTEN_URL: z.url(),
    FIXTURES_BASE_URL: z.url(),
    SOLANA_CLUSTER: z.enum(['mainnet', 'devnet', 'testnet', 'localnet']),
    DASHBOARD_ORIGIN: z.string().refine((value) => URL.parse(value)?.origin === value, {
      message: 'an origin: scheme, host and port, no path or trailing slash',
    }),
    PORT: z.coerce.number().int().positive().default(8879),
    // How many proxies in front of the gateway append to X-Forwarded-For; 0 = none, use the socket.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  })
  .parse(process.env)

const OFFER_TTL_MS = 60_000
const OFFER_MAX_BYTES = 32 * 1024 * 1024

// Sized from the M1 run, which must pass untouched: one address, strictly sequential,
// ~2.7 requests/s at most with a burst of 70 refusals in a row, and ~1.3 drafts/s.
const REQUESTS = { capacity: 120, perSecond: 10 }
const DRAFTS = { capacity: 20, perSecond: 2 }
// A sign-in is two requests; this allows a handful in a row, then one every ten seconds.
const SIGN_INS = { capacity: 10, perSecond: 0.1 }
// A dashboard opens with two requests and pages on demand; the live feed is one stream.
// The burst leaves room for three dashboards behind one address, as in the M2 run.
const PUBLISHER_READS = { capacity: 30, perSecond: 1 }
// Three dashboards behind one address with room to spare; proxies drop a connection
// idle for about a minute, so the heartbeat comes well inside that.
const STREAMS = { maxPerAddress: 10, heartbeatMs: 15_000 }
const PROBE = { probeMs: 30_000, echoTimeoutMs: 5_000 }

// The transaction pooler (6543) does not keep prepared statements across transactions.
const sql = postgres(env.DATABASE_URL, { prepare: false })
const db = drizzle(sql)
const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed')
const registry = rpcRegistry(connection)
const now = () => new Date()
const clock = () => Date.now()
const feed = publisherFeed(db)
const closing = new AbortController()
const settlements = listenForSettlements({
  connect: postgresListen(env.DATABASE_LISTEN_URL, SETTLEMENT_CHANNEL),
  notify: notifyThrough(db, SETTLEMENT_CHANNEL),
  onSettled: (batchId) => void feed.batchSettled(batchId),
  onResync: feed.resync,
  ...PROBE,
})
const addressOf = clientAddress(
  env.TRUSTED_PROXY_HOPS,
  (c) => getConnInfo(c).remote.address ?? 'unknown',
)

const app = createApp(
  quoteRoutes(registry),
  contentRoutes({
    registry,
    db,
    origin: fixturesOrigin(env.FIXTURES_BASE_URL),
    offers: offerStore({ ttlMs: OFFER_TTL_MS, maxBytes: OFFER_MAX_BYTES, now }),
    payments: rpcPayments(env.SOLANA_RPC_URL),
    now,
    limits: {
      addressOf,
      requests: tokenBucket({ ...REQUESTS, now: clock }),
      drafts: tokenBucket({ ...DRAFTS, now: clock }),
    },
    feed,
  }),
  publicRoutes(db),
  authRoutes({
    db,
    now,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    cluster: env.SOLANA_CLUSTER,
    limits: { addressOf, auth: tokenBucket({ ...SIGN_INS, now: clock }) },
  }),
  publisherRoutes({
    db,
    now,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    registry: rpcOwnedWorks(connection),
    limits: { addressOf, publisher: tokenBucket({ ...PUBLISHER_READS, now: clock }) },
    feed,
    streams: STREAMS,
    closing: closing.signal,
  }),
)
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    closing.abort()
    void settlements.stop()
    server.close(() => void sql.end({ timeout: 5 }))
  })
}
