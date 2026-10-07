import { domainPda } from '@contentledger/chain'
import {
  batches,
  domains,
  MIGRATIONS_DIR,
  receipts,
  SETTLEMENT_CHANNEL,
  settlerHeartbeat,
  vouchers,
  works,
} from '@contentledger/db'
import { PGlite } from '@electric-sql/pglite'
import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Batch, PendingVoucher } from './batch.js'
import { lastBatch, loadPending, recordBatch, recordPass } from './store.js'

const AGENT = 'Agent111111111111111111111111111111111111111'
const OTHER = 'Other111111111111111111111111111111111111111'
const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32)

let db: ReturnType<typeof drizzle>
let client: PGlite

beforeAll(async () => {
  client = new PGlite()
  // Supabase ships these roles; the RLS migration names them in its policies.
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, batches, works, domains cascade`)
  for (const host of ['acme-news.test', 'devblog.test']) {
    await db.insert(domains).values({
      host,
      owner: AGENT,
      payoutOwner: AGENT,
      rateTrain: 2000n,
      rateInference: 500n,
      status: 'active',
      slot: 1n,
    })
    await db.insert(works).values({
      id: `work-${host}`,
      host,
      sourceId: `https://${host}/a`,
      contentHash: hex(0x22),
      status: 'active',
      mediaType: 'text/html',
      byteLen: 10,
      slot: 1n,
    })
  }
})

async function issue(
  consumer: string,
  seq: number,
  { host = 'acme-news.test', tariff = 2000n, method = 'escrow' as 'escrow' | 'x402' } = {},
) {
  const id = hex(seq + (consumer === AGENT ? 0 : 0x80))
  await db.insert(receipts).values({
    id,
    consumer,
    workId: `work-${host}`,
    useType: 'train',
    tariff,
    fee: tariff / 10n,
    rateLevel: 'domain',
    servedHash: hex(0x22),
    registryHash: hex(0x22),
    hashMatch: true,
    paymentMethod: method,
    paymentRef: method === 'x402' ? `ref${seq}` : null,
    acceptedAt: `2026-10-03T12:00:0${seq}.000Z`,
    acceptedTs: new Date(`2026-10-03T12:00:0${seq}.000Z`),
  })
  await db.insert(vouchers).values({
    consumer,
    seq: BigInt(seq),
    cumulative: BigInt(seq) * 2200n,
    chain: hex(0x40 + seq),
    signature: `sig${seq}`,
    receiptId: id,
  })
  return id
}

const batchOf = (pending: PendingVoucher[]): Batch => {
  const [first] = pending
  const last = pending.at(-1)
  if (first === undefined || last === undefined) throw new Error('empty')
  return {
    seqFrom: first.seq,
    seqTo: last.seq,
    root: Buffer.from(last.receiptId, 'hex'),
    last,
    receiptIds: pending.map((p) => p.receiptId),
    legs: [],
  }
}

const SETTLED_AT = new Date('2026-10-03T12:05:00.000Z')
const PUBLISHED_AT = new Date('2026-10-03T12:05:01.000Z')
const settlement = (nodeShareBps = 0) => ({
  txSig: 'settleSig',
  settledAt: SETTLED_AT,
  publishedAt: PUBLISHED_AT,
  nodeShareBps,
})

describe('loadPending', () => {
  it('groups unbatched escrow vouchers by agent in seq order, owed to the work’s domain', async () => {
    await issue(AGENT, 2, { host: 'devblog.test', tariff: 500n })
    await issue(AGENT, 1)
    await issue(OTHER, 1)

    const pending = await loadPending(db)
    expect([...pending.keys()].sort()).toEqual([AGENT, OTHER].sort())
    expect(pending.get(AGENT)).toEqual([
      {
        seq: 1n,
        cumulative: 2200n,
        chain: hex(0x41),
        signature: 'sig1',
        receiptId: hex(1),
        domain: domainPda('acme-news.test')[0].toBase58(),
        tariff: 2000n,
        acceptedTs: new Date('2026-10-03T12:00:01.000Z'),
      },
      expect.objectContaining({
        seq: 2n,
        domain: domainPda('devblog.test')[0].toBase58(),
        tariff: 500n,
      }),
    ])
  })

  // FR-013c: an x402 receipt is not in the agent's chain, so a batch carrying it is
  // rejected by settle_batch whole — one stray receipt would stop every publisher's payout.
  it('never offers an x402 receipt, even one a voucher points at', async () => {
    await issue(AGENT, 1, { method: 'x402' })
    expect(await loadPending(db)).toEqual(new Map())
  })

  it('skips what is already batched', async () => {
    await issue(AGENT, 1)
    await issue(AGENT, 2)
    const first = (await loadPending(db)).get(AGENT)?.slice(0, 1) ?? []
    await recordBatch(db, AGENT, batchOf(first), settlement())
    expect((await loadPending(db)).get(AGENT)?.map((p) => p.seq)).toEqual([2n])
  })
})

describe('recordBatch', () => {
  it('publishes the batch and settles its vouchers and receipts together', async () => {
    await issue(AGENT, 1)
    await issue(AGENT, 2, { tariff: 3333n })
    const pending = (await loadPending(db)).get(AGENT) ?? []
    const batch = batchOf(pending)

    await recordBatch(db, AGENT, batch, settlement(1500))

    expect(await db.select().from(batches)).toEqual([
      {
        id: hex(2),
        consumer: AGENT,
        seqFrom: 1n,
        seqTo: 2n,
        root: hex(2),
        chain: hex(0x42),
        txSig: 'settleSig',
        publishedAt: PUBLISHED_AT,
      },
    ])
    expect(
      await db.select({ batchId: vouchers.batchId }).from(vouchers).orderBy(asc(vouchers.seq)),
    ).toEqual([{ batchId: hex(2) }, { batchId: hex(2) }])
    expect(
      await db
        .select({
          batchId: receipts.batchId,
          settledAt: receipts.settledAt,
          nodeCut: receipts.nodeCut,
        })
        .from(receipts)
        .orderBy(asc(receipts.id)),
    ).toEqual([
      { batchId: hex(2), settledAt: SETTLED_AT, nodeCut: 300n },
      // Rounded down, as FR-015a splits it: 3333 × 0.15 = 499.95.
      { batchId: hex(2), settledAt: SETTLED_AT, nodeCut: 499n },
    ])
    expect(await lastBatch(db, AGENT)).toEqual({ seqTo: 2n, chain: hex(0x42) })
  })

  // GET /v1/receipts/:id answers 500 for a batched receipt without settled_at.
  it('writes nothing when one of its vouchers is already in a batch', async () => {
    await issue(AGENT, 1)
    await issue(AGENT, 2)
    const pending = (await loadPending(db)).get(AGENT) ?? []
    await recordBatch(db, AGENT, batchOf(pending.slice(0, 1)), settlement())

    await expect(recordBatch(db, AGENT, batchOf(pending), settlement())).rejects.toThrow(/already/)
    expect((await db.select().from(batches)).map((b) => b.seqTo)).toEqual([1n])
    const [second] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, hex(2)))
    expect(second?.batchId).toBeNull()
    expect(second?.settledAt).toBeNull()
  })
})

describe('recordBatch notification', () => {
  async function heard(run: () => Promise<unknown>): Promise<string[]> {
    const payloads: string[] = []
    const unlisten = await client.listen(SETTLEMENT_CHANNEL, (payload) => payloads.push(payload))
    try {
      await run().catch(() => {})
    } finally {
      await unlisten()
    }
    return payloads
  }

  it('tells listeners the batch id once it is committed', async () => {
    await issue(AGENT, 1)
    const pending = (await loadPending(db)).get(AGENT) ?? []
    expect(await heard(() => recordBatch(db, AGENT, batchOf(pending), settlement()))).toEqual([
      hex(1),
    ])
  })

  it('tells nobody about a batch that rolled back', async () => {
    await issue(AGENT, 1)
    await issue(AGENT, 2)
    const pending = (await loadPending(db)).get(AGENT) ?? []
    await recordBatch(db, AGENT, batchOf(pending.slice(0, 1)), settlement())
    expect(await heard(() => recordBatch(db, AGENT, batchOf(pending), settlement()))).toEqual([])
  })
})

describe('lastBatch', () => {
  it('is null before the first batch', async () => {
    expect(await lastBatch(db, AGENT)).toBeNull()
  })

  it('is the highest batch of that agent only', async () => {
    for (const seq of [1, 2]) await issue(AGENT, seq)
    await issue(OTHER, 1)
    const all = await loadPending(db)
    const mine = all.get(AGENT) ?? []
    await recordBatch(db, AGENT, batchOf(mine.slice(0, 1)), settlement())
    await recordBatch(db, AGENT, batchOf(mine.slice(1)), settlement())
    await recordBatch(db, OTHER, batchOf(all.get(OTHER) ?? []), { ...settlement(), txSig: 'o' })
    expect(await lastBatch(db, AGENT)).toEqual({ seqTo: 2n, chain: hex(0x42) })
  })
})

describe('recordPass', () => {
  beforeEach(async () => {
    await db.execute(sql`truncate settler_heartbeat`)
  })

  it('keeps one row holding the latest pass', async () => {
    await recordPass(db, {
      passedAt: new Date('2026-10-07T12:00:00Z'),
      intervalSeconds: 60,
      failedAgents: 2,
    })
    await recordPass(db, {
      passedAt: new Date('2026-10-07T12:01:00Z'),
      intervalSeconds: 60,
      failedAgents: 0,
    })
    expect(await db.select().from(settlerHeartbeat)).toEqual([
      { id: 1, passedAt: new Date('2026-10-07T12:01:00Z'), intervalSeconds: 60, failedAgents: 0 },
    ])
  })

  it('refuses a negative count of failed agents', async () => {
    await expect(
      recordPass(db, { passedAt: new Date(), intervalSeconds: 60, failedAgents: -1 }),
    ).rejects.toThrow()
    expect(await db.select().from(settlerHeartbeat)).toEqual([])
  })
})
