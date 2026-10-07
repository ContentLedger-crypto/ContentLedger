import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { z } from 'zod'
import { rpcSettlementChain } from './chain.js'
import { type Log, settleAll } from './settler.js'
import { recordPass } from './store.js'

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    DATABASE_URL: z.url(),
    OPERATOR_KEYPAIR_PATH: z.string().min(1),
    SETTLE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    SETTLE_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    SETTLE_MIN_RECEIPTS: z.coerce.number().int().positive().default(10),
    SETTLE_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  })
  .parse(process.env)

const operator = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../..', env.OPERATOR_KEYPAIR_PATH), 'utf8'),
    ),
  ),
)

// The transaction pooler (6543) does not keep prepared statements across transactions.
const sql = postgres(env.DATABASE_URL, { prepare: false })
const redactKeys = (text: string): string => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')
const log: Log = (level, message, fields) => {
  const line = redactKeys(JSON.stringify({ level, message, ...fields }))
  if (level === 'error') console.error(line)
  else console.log(line)
}

const deps = {
  db: drizzle(sql),
  chain: rpcSettlementChain(new Connection(env.SOLANA_RPC_URL, 'finalized'), operator),
  operator: operator.publicKey,
  policy: {
    minReceipts: env.SETTLE_MIN_RECEIPTS,
    maxAgeMs: env.SETTLE_MAX_AGE_SECONDS * 1000,
    maxReceipts: env.SETTLE_MAX_BATCH_SIZE,
  },
  now: () => new Date(),
  log,
}

let timer: NodeJS.Timeout | undefined
let inFlight: Promise<void> = Promise.resolve()
let stopping = false

// Scheduled after a pass ends, not on a fixed clock: waiting for `finalized` can outlast
// the interval, and two passes at once would race for the same vouchers.
const tick = () => {
  inFlight = settleAll(deps)
    .then(({ failed }) =>
      recordPass(deps.db, {
        passedAt: deps.now(),
        intervalSeconds: env.SETTLE_INTERVAL_SECONDS,
        failedAgents: failed,
      }),
    )
    .catch((error: unknown) =>
      log('error', 'settlement pass failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      if (!stopping) timer = setTimeout(tick, env.SETTLE_INTERVAL_SECONDS * 1000)
    })
}

log('info', 'settler started', {
  operator: operator.publicKey.toBase58(),
  intervalSeconds: env.SETTLE_INTERVAL_SECONDS,
})
tick()

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true
    clearTimeout(timer)
    void inFlight.then(() => sql.end({ timeout: 5 }))
  })
}
