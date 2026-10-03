import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { usdcAmountSchema, useTypeSchema } from '@contentledger/shared'
import { Connection, Keypair } from '@solana/web3.js'
import { z } from 'zod'
import { createAgent } from './agent.js'
import { deposit, settledPosition } from './escrow.js'
import { fileJournal } from './journal.js'

const [command] = process.argv.slice(2)
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    amount: { type: 'string' },
    source: { type: 'string' },
    use: { type: 'string', default: 'train' },
    count: { type: 'string', default: '1' },
  },
})

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    AGENT_KEYPAIR_PATH: z.string().endsWith('.keypair.json'),
    GATEWAY_URL: z.url().default('http://127.0.0.1:8879'),
  })
  .parse(process.env)

const fromRoot = (path: string) => resolve(import.meta.dirname, '../../..', path)
const keypairPath = fromRoot(env.AGENT_KEYPAIR_PATH)
// Beside the key it belongs to: the journal is the agent's record of what it signed.
const journalPath = keypairPath.replace(/\.keypair\.json$/, '.journal.json')
const redactKeys = (text: string): string => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')

const loadKeypair = () =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))))

async function main(): Promise<void> {
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed')

  if (command === 'keygen') {
    if (existsSync(keypairPath)) throw new Error(`${env.AGENT_KEYPAIR_PATH} already exists`)
    const keypair = Keypair.generate()
    writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 })
    console.log(`agent ${keypair.publicKey.toBase58()}`)
    return
  }

  const keypair = loadKeypair()
  if (command === 'deposit') {
    const amount = usdcAmountSchema.parse(values.amount)
    console.log(`✓ ${await deposit(connection, keypair, amount)}`)
    return
  }

  if (command === 'fetch') {
    const source = z.url().parse(values.source)
    const use = useTypeSchema.parse(values.use)
    const count = z.coerce.number().int().positive().parse(values.count)
    const agent = createAgent({
      keypair,
      gatewayUrl: env.GATEWAY_URL,
      fetch,
      journal: fileJournal(journalPath),
      settledPosition: () => settledPosition(connection, keypair.publicKey),
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    })
    for (let i = 0; i < count; i += 1) {
      const started = performance.now()
      const outcome = await agent.request(source, use)
      const ms = Math.round(performance.now() - started)
      if (outcome.kind === 'delivered') {
        const { id, seq, tariff, fee, hashMatch } = outcome.receipt
        console.log(
          JSON.stringify({
            outcome: 'delivered',
            ms,
            bytes: outcome.bytes.length,
            id,
            seq,
            tariff,
            fee,
            hashMatch,
          }),
        )
      } else {
        console.log(JSON.stringify({ outcome: outcome.kind, ms, ...outcome }))
      }
    }
    return
  }

  throw new Error(
    'usage: agent <keygen | deposit --amount <base units> | fetch --source <url> [--use train|inference] [--count n]>',
  )
}

main().catch((error: unknown) => {
  console.error(redactKeys(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
