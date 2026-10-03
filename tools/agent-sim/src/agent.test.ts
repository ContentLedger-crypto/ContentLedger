import { createHash } from 'node:crypto'
import {
  type Config,
  type Domain,
  domainPda,
  escrowPda,
  type Work,
  workPda,
} from '@contentledger/chain'
import { MIGRATIONS_DIR, vouchers } from '@contentledger/db'
import { createApp } from '@contentledger/gateway/src/app.js'
import { offerStore } from '@contentledger/gateway/src/offers.js'
import type { PaidRegistrySnapshot } from '@contentledger/gateway/src/registry.js'
import { contentRoutes } from '@contentledger/gateway/src/routes/content.js'
import { publicRoutes } from '@contentledger/gateway/src/routes/public.js'
import { chainGenesis } from '@contentledger/shared'
import { PGlite } from '@electric-sql/pglite'
import { Keypair } from '@solana/web3.js'
import { asc, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Agent, createAgent } from './agent.js'
import type { Journal, JournalState } from './journal.js'

const SOURCE = 'https://acme-news.test/2026/ai-act-explained.html'
const UNKNOWN = 'https://acme-news.test/2026/never-registered.html'
const CONTENT = Buffer.from('<h1>AI Act, explained</h1>')
const OWNER = Keypair.generate().publicKey.toBase58()
const GATEWAY = 'http://gateway.test'

let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

const config: Config = {
  authority: OWNER,
  treasuryAta: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  protocolFeeBps: 1000,
  nodeShareBps: 0,
  voucherGraceS: 900n,
  paused: false,
  bump: 255,
}

interface World {
  now: number
  vaultBalance: bigint
  slot: bigint
}

let world: World
let keypair: Keypair
let gateway: (request: Request) => Promise<Response>
let journal: Journal & { state: JournalState | null }
let events: { event: string; fields: Record<string, unknown> }[]

function snapshot(source: string): PaidRegistrySnapshot {
  const domain: Domain = {
    owner: OWNER,
    payoutOwner: OWNER,
    host: 'acme-news.test',
    rateTrain: 2000n,
    rateInference: 500n,
    status: 'active',
    bump: 254,
  }
  const work: Work = {
    domain: domainPda('acme-news.test')[0].toBase58(),
    sourceHash: '11'.repeat(32),
    contentHash: createHash('sha256').update(CONTENT).digest('hex'),
    rateTrain: null,
    rateInference: null,
    status: 'active',
    attestedBy: 0,
    bump: 253,
  }
  world.slot += 1n
  return {
    config,
    domain: { address: work.domain, account: domain },
    work: source === SOURCE ? { address: workPda(source)[0].toBase58(), account: work } : null,
    escrow: {
      address: escrowPda(keypair.publicKey)[0].toBase58(),
      account: {
        consumer: keypair.publicKey.toBase58(),
        vault: Keypair.generate().publicKey.toBase58(),
        settledTotal: 0n,
        lastSeq: 0n,
        lastChain: '00'.repeat(32),
        withdrawAfter: 0n,
        bump: 252,
        vaultBump: 251,
      },
      vaultBalance: world.vaultBalance,
    },
    slot: world.slot,
  }
}

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, batches, works, domains cascade`)
  world = { now: Date.parse('2026-10-03T12:00:00.000Z'), vaultBalance: 1_000_000n, slot: 1n }
  keypair = Keypair.generate()
  const now = () => new Date(world.now)
  const app = createApp(
    contentRoutes({
      registry: { read: async (s) => snapshot(s), readWithEscrow: async (s) => snapshot(s) },
      db,
      origin: { fetch: async () => ({ bytes: Uint8Array.from(CONTENT), mediaType: 'text/html' }) },
      offers: offerStore({ ttlMs: 60_000, maxBytes: 1 << 20, now }),
      payments: { transaction: async () => null },
      now,
    }),
    publicRoutes(db),
  )
  gateway = async (request) => app.fetch(request)
  journal = {
    state: null,
    async read() {
      return this.state
    },
    async write(state) {
      this.state = structuredClone(state)
    },
  }
  events = []
})

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>

function agentWith(hook: Hook = (_, forward) => forward(), agentKeypair = keypair): Agent {
  return createAgent({
    keypair: agentKeypair,
    gatewayUrl: GATEWAY,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      return hook(request, () => gateway(request))
    }) as typeof fetch,
    journal,
    settledPosition: async () => ({
      seq: 0n,
      cumulative: 0n,
      chain: chainGenesis(escrowPda(agentKeypair.publicKey)[0].toBytes()),
    }),
    log: (event, fields) => events.push({ event, fields }),
  })
}

const isVoucher = (request: Request) => request.headers.has('X-ContentLedger-Voucher')

const kept = async () =>
  (await db.select({ seq: vouchers.seq }).from(vouchers).orderBy(asc(vouchers.seq))).map(
    (row) => row.seq,
  )

describe('agent against the gateway', () => {
  it('pays per request and gets the bytes with a receipt, extending one chain', async () => {
    const agent = agentWith()

    const first = await agent.request(SOURCE, 'train')
    const second = await agent.request(SOURCE, 'train')

    expect(first).toMatchObject({ kind: 'delivered', receipt: { seq: 1, tariff: '2000' } })
    expect(second).toMatchObject({ kind: 'delivered', receipt: { seq: 2, hashMatch: true } })
    if (second.kind === 'delivered') expect(Buffer.from(second.bytes)).toEqual(CONTENT)
    expect(await kept()).toEqual([1n, 2n])
    expect(journal.state?.position).toMatchObject({ seq: 2n, cumulative: 4400n })
  })

  it('is refused and pays nothing for a work that is not registered', async () => {
    const outcome = await agentWith().request(UNKNOWN, 'train')
    expect(outcome).toMatchObject({ kind: 'refused', status: 404, code: 'NOT_FOUND' })
    expect(await kept()).toEqual([])
  })

  it('is refused when its escrow cannot cover the price', async () => {
    world.vaultBalance = 100n
    const outcome = await agentWith().request(SOURCE, 'train')
    expect(outcome).toEqual({
      kind: 'refused',
      status: 402,
      code: 'PAYMENT_REQUIRED',
      reason: 'insufficient-funds',
    })
  })

  // The gateway kept the voucher but the answer never arrived: the agent paid for
  // seq 1, learns so from the public receipt, and moves on without signing seq 1 twice.
  it('recovers a voucher the gateway kept after its answer was lost', async () => {
    let dropped = false
    const agent = agentWith(async (request, forward) => {
      const res = await forward()
      if (isVoucher(request) && !dropped) {
        dropped = true
        throw new TypeError('fetch failed')
      }
      return res
    })

    const outcome = await agent.request(SOURCE, 'train')

    expect(outcome).toMatchObject({ kind: 'delivered', receipt: { seq: 2 } })
    expect(events.map((e) => e.event)).toEqual(['voucher-unanswered', 'paid-undelivered'])
    expect(await kept()).toEqual([1n, 2n])
  })

  it('signs the same seq again when the lost voucher never reached the gateway', async () => {
    let dropped = false
    const agent = agentWith(async (request, forward) => {
      if (isVoucher(request) && !dropped) {
        dropped = true
        throw new TypeError('fetch failed')
      }
      return forward()
    })

    const outcome = await agent.request(SOURCE, 'train')

    expect(outcome).toMatchObject({ kind: 'delivered', receipt: { seq: 1 } })
    expect(events.map((e) => e.event)).toEqual(['voucher-unanswered'])
    expect(journal.state?.doubtful).toEqual([])
  })

  it('takes a fresh draft when its offer expired before the voucher arrived', async () => {
    let delayed = false
    const agent = agentWith(async (request, forward) => {
      if (isVoucher(request) && !delayed) {
        delayed = true
        world.now += 61_000
      }
      return forward()
    })

    expect(await agent.request(SOURCE, 'train')).toMatchObject({
      kind: 'delivered',
      receipt: { seq: 1, acceptedAt: '2026-10-03T12:01:01.000Z' },
    })
  })

  // Signing the chain over a draft commits the agent to it; a gateway that inflates the
  // running total gets no signature at all.
  it('refuses to sign a draft that overstates what it owes', async () => {
    const vouchersSent: Request[] = []
    const agent = agentWith(async (request, forward) => {
      if (isVoucher(request)) vouchersSent.push(request)
      const res = await forward()
      if (res.status !== 402) return res
      const json = (await res.json()) as {
        error: { details: { methods: { offer?: { cumulativeAfter: string } }[] } }
      }
      const offer = json.error.details.methods[0]?.offer
      if (offer) offer.cumulativeAfter = '2201'
      return Response.json(json, { status: 402 })
    })

    await expect(agent.request(SOURCE, 'train')).rejects.toThrow(/cumulative-mismatch/)
    expect(vouchersSent).toEqual([])
  })

  it('disputes bytes that are not the ones its receipt names', async () => {
    const agent = agentWith(async (request, forward) => {
      const res = await forward()
      if (!isVoucher(request) || res.status !== 200) return res
      return new Response('tampered', { status: 200, headers: res.headers })
    })

    const outcome = await agent.request(SOURCE, 'train')

    expect(outcome).toMatchObject({ kind: 'disputed', reason: 'served-hash-mismatch' })
    // Paid all the same: the gateway kept the voucher.
    expect(journal.state?.position.seq).toBe(1n)
  })

  it('continues from its journal after a restart, not from the chain', async () => {
    await agentWith().request(SOURCE, 'train')
    const restarted = agentWith()
    expect(await restarted.request(SOURCE, 'train')).toMatchObject({
      kind: 'delivered',
      receipt: { seq: 2 },
    })
  })

  it('will not use another agent’s journal', async () => {
    await agentWith().request(SOURCE, 'train')
    await expect(agentWith(undefined, Keypair.generate()).request(SOURCE, 'train')).rejects.toThrow(
      /journal belongs/,
    )
  })
})
