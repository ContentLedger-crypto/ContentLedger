import { acceptedAtColumns, domains, MIGRATIONS_DIR, receipts, works } from '@contentledger/db'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionWallet } from '../routes/auth.js'
import { listReceipts, PAGE_SIZE, receiptsParams, summarize, summaryParams } from './queries.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58()
const session = (seed: number) => key(seed) as SessionWallet

const ALICE = 1
const BOB = 2
const NOBODY = 3
const AGENT = key(9)

let db: ReturnType<typeof drizzle>
let nextReceipt = 0

beforeAll(async () => {
  const client = new PGlite()
  // Supabase ships these roles; the RLS migration names them in its policies.
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate receipts, works, domains cascade`)
  nextReceipt = 0
  await db.insert(domains).values([
    domainRow('alice.test', key(ALICE), key(ALICE)),
    // Bob's domain pays out to Alice's wallet: payout_owner is set by whoever registers
    // and never signs, so it must not let Alice in.
    domainRow('bob.test', key(BOB), key(ALICE)),
  ])
  await db
    .insert(works)
    .values([
      workRow(key(11), 'alice.test', 'https://alice.test/a'),
      workRow(key(12), 'alice.test', 'https://alice.test/b'),
      workRow(key(21), 'bob.test', 'https://bob.test/a'),
    ])
})

function domainRow(host: string, owner: string, payoutOwner: string) {
  return {
    host,
    owner,
    payoutOwner,
    rateTrain: 2000n,
    rateInference: 500n,
    status: 'active' as const,
    slot: 1n,
  }
}

function workRow(id: string, host: string, sourceId: string) {
  return {
    id,
    host,
    sourceId,
    contentHash: 'aa'.repeat(32),
    rateTrain: null,
    rateInference: null,
    status: 'active' as const,
    mediaType: 'text/html',
    byteLen: 100,
    slot: 1n,
  }
}

function receiptRow(workId: string, acceptedAt: string, tariff: bigint) {
  nextReceipt += 1
  return {
    id: nextReceipt.toString(16).padStart(64, '0'),
    consumer: AGENT,
    workId,
    useType: 'train' as const,
    tariff,
    fee: 10n,
    rateLevel: 'domain' as const,
    servedHash: 'aa'.repeat(32),
    registryHash: 'aa'.repeat(32),
    hashMatch: true,
    paymentMethod: 'escrow' as const,
    paymentRef: null,
    ...acceptedAtColumns(acceptedAt),
  }
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString()

const range = (from: string, to: string) => {
  const parsed = summaryParams.safeParse({ from, to })
  if (!parsed.success) throw parsed.error
  return parsed.data
}

describe('listReceipts', () => {
  it("returns only the session wallet's receipts, newest first", async () => {
    await db
      .insert(receipts)
      .values([
        receiptRow(key(11), at(1), 2000n),
        receiptRow(key(21), at(2), 2000n),
        receiptRow(key(12), at(3), 500n),
      ])

    const page = await listReceipts(db, session(ALICE), {})

    expect(page.items.map((r) => [r.workId, r.acceptedAt])).toEqual([
      [key(12), at(3)],
      [key(11), at(1)],
    ])
    expect(page.items[0]).toMatchObject({
      sourceId: 'https://alice.test/b',
      consumer: AGENT,
      useType: 'train',
      tariff: 500n,
      settledAt: null,
    })
    expect(page.nextCursor).toBeNull()
  })

  it('does not show the payout owner a domain somebody else owns', async () => {
    await db.insert(receipts).values(receiptRow(key(21), at(1), 2000n))

    expect((await listReceipts(db, session(ALICE), {})).items).toEqual([])
    expect((await listReceipts(db, session(BOB), {})).items).toHaveLength(1)
  })

  it('returns an empty page to a wallet that owns no domain', async () => {
    await db.insert(receipts).values(receiptRow(key(11), at(1), 2000n))

    expect(await listReceipts(db, session(NOBODY), {})).toEqual({ items: [], nextCursor: null })
  })

  it('pages through receipts sharing one timestamp without repeating or skipping any', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
      receiptRow(i % 2 === 0 ? key(11) : key(12), at(i < 5 ? 0 : 1), 1n),
    )
    await db.insert(receipts).values(rows)

    const first = await listReceipts(db, session(ALICE), {})
    expect(first.items).toHaveLength(PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()

    const params = receiptsParams.parse({ cursor: first.nextCursor })
    const second = await listReceipts(db, session(ALICE), params)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()

    const seen = [...first.items, ...second.items].map((r) => r.id)
    expect(new Set(seen).size).toBe(rows.length)
  })

  it("a cursor taken from someone else's receipt only positions, never widens", async () => {
    await db
      .insert(receipts)
      .values([
        receiptRow(key(11), at(1), 2000n),
        receiptRow(key(21), at(2), 2000n),
        receiptRow(key(11), at(3), 2000n),
      ])
    const [bobs] = (await listReceipts(db, session(BOB), {})).items
    if (bobs === undefined) throw new Error('fixture lost')

    const params = receiptsParams.parse({ cursor: `${bobs.acceptedAt}_${bobs.id}` })
    const page = await listReceipts(db, session(ALICE), params)

    expect(page.items.map((r) => r.acceptedAt)).toEqual([at(1)])
  })
})

describe('receiptsParams', () => {
  it.each([
    ['host', { host: 'bob.test' }],
    ['wallet', { wallet: key(BOB) }],
  ])('refuses a %s parameter instead of ignoring it', (_, query) => {
    expect(receiptsParams.safeParse(query).success).toBe(false)
  })

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a day that does not exist', `2026-02-30T12:00:00.000Z_${'0'.repeat(64)}`],
    ['an id that is not hex', `2026-10-06T12:00:00.000Z_${'z'.repeat(64)}`],
  ])('refuses %s as a cursor without throwing', (_, cursor) => {
    expect(receiptsParams.safeParse({ cursor }).success).toBe(false)
  })
})

describe('summarize', () => {
  it('totals the period per work to the base unit, from inclusive and to exclusive', async () => {
    await db
      .insert(receipts)
      .values([
        receiptRow(key(11), at(0), 999n),
        receiptRow(key(11), at(10), 2000n),
        receiptRow(key(11), at(20), 2001n),
        receiptRow(key(12), at(15), 500n),
        receiptRow(key(12), at(30), 7n),
      ])

    const summary = await summarize(db, session(ALICE), range(at(10), at(30)))

    expect(summary.total).toBe(4501n)
    expect(summary.count).toBe(3)
    expect(summary.byWork).toEqual([
      { workId: key(11), sourceId: 'https://alice.test/a', count: 2, total: 4001n },
      { workId: key(12), sourceId: 'https://alice.test/b', count: 1, total: 500n },
    ])
  })

  it("leaves another owner's receipts out of the total, payout wallet or not", async () => {
    await db
      .insert(receipts)
      .values([receiptRow(key(11), at(1), 2000n), receiptRow(key(21), at(2), 5000n)])

    const summary = await summarize(db, session(ALICE), range(at(0), at(59)))

    expect(summary.total).toBe(2000n)
    expect(summary.byWork.map((w) => w.workId)).toEqual([key(11)])
  })

  it('returns zero for a wallet that owns nothing', async () => {
    await db.insert(receipts).values(receiptRow(key(11), at(1), 2000n))

    expect(await summarize(db, session(NOBODY), range(at(0), at(59)))).toEqual({
      total: 0n,
      count: 0,
      byWork: [],
    })
  })
})

describe('summaryParams', () => {
  it('refuses a host parameter instead of ignoring it', () => {
    expect(summaryParams.safeParse({ from: at(0), to: at(1), host: 'bob.test' }).success).toBe(
      false,
    )
  })

  it.each([
    ['an empty period', at(1), at(1)],
    ['a reversed period', at(2), at(1)],
    ['a date that is not one', 'yesterday', at(1)],
  ])('refuses %s without throwing', (_, from, to) => {
    expect(summaryParams.safeParse({ from, to }).success).toBe(false)
  })
})
