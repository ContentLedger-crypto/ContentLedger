import {
  acceptedAtColumns,
  batches,
  domains,
  MIGRATIONS_DIR,
  receipts,
  works,
} from '@contentledger/db'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionWallet } from '../routes/auth.js'
import type { Database } from '../store.js'
import { type FeedEvent, publisherFeed } from './feed.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58()
const session = (seed: number) => key(seed) as SessionWallet

const ALICE = 1
const BOB = 2
const AGENT = key(9)
const BATCH = 'bb'.repeat(32)
const SETTLED_AT = new Date('2026-10-07T09:00:00.000Z')

let db: ReturnType<typeof drizzle>
let nextReceipt = 0

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate receipts, batches, works, domains cascade`)
  nextReceipt = 0
  await db.insert(domains).values([
    domainRow('alice.test', key(ALICE), key(ALICE)),
    // Paid out to Alice, owned by Bob: only the owner signs, so only Bob sees it.
    domainRow('bob.test', key(BOB), key(ALICE)),
  ])
  await db
    .insert(works)
    .values([
      workRow(key(11), 'alice.test', 'https://alice.test/a'),
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

async function issue(workId: string, tariff = 2000n): Promise<string> {
  nextReceipt += 1
  const id = nextReceipt.toString(16).padStart(64, '0')
  await db.insert(receipts).values({
    id,
    consumer: AGENT,
    workId,
    useType: 'train',
    tariff,
    fee: 10n,
    rateLevel: 'domain',
    servedHash: 'aa'.repeat(32),
    registryHash: 'aa'.repeat(32),
    hashMatch: true,
    paymentMethod: 'escrow',
    paymentRef: null,
    ...acceptedAtColumns(new Date(Date.UTC(2026, 9, 7, 8, nextReceipt)).toISOString()),
  })
  return id
}

async function settle(ids: string[]) {
  await db.insert(batches).values({
    id: BATCH,
    consumer: AGENT,
    seqFrom: 1n,
    seqTo: BigInt(ids.length),
    root: BATCH,
    chain: 'cc'.repeat(32),
    txSig: '1'.repeat(88),
    publishedAt: SETTLED_AT,
  })
  await db
    .update(receipts)
    .set({ batchId: BATCH, settledAt: SETTLED_AT })
    .where(inArray(receipts.id, ids))
}

function listen(feed: ReturnType<typeof publisherFeed>, wallet: number) {
  const events: FeedEvent[] = []
  const stop = feed.subscribe(session(wallet), (event) => events.push(event))
  return { events, stop }
}

describe('publisherFeed', () => {
  it("delivers an issued receipt to its domain owner's subscribers only", async () => {
    const feed = publisherFeed(db)
    const alice = listen(feed, ALICE)
    const aliceAgain = listen(feed, ALICE)
    const bob = listen(feed, BOB)

    const id = await issue(key(11), 2n ** 60n)
    await feed.receiptIssued(id)

    const expected: FeedEvent = {
      type: 'receipt',
      receipt: {
        id,
        workId: key(11),
        sourceId: 'https://alice.test/a',
        consumer: AGENT,
        useType: 'train',
        tariff: 2n ** 60n,
        acceptedAt: '2026-10-07T08:01:00.000Z',
        settledAt: null,
      },
    }
    expect(alice.events).toEqual([expected])
    expect(aliceAgain.events).toEqual([expected])
    expect(bob.events).toEqual([])
  })

  it('does not tell the payout wallet about a domain it does not own', async () => {
    const feed = publisherFeed(db)
    const alice = listen(feed, ALICE)
    const bob = listen(feed, BOB)

    await feed.receiptIssued(await issue(key(21)))

    expect(alice.events).toEqual([])
    expect(bob.events.map((event) => event.type)).toEqual(['receipt'])
  })

  it('splits a settled batch by owner, each told only of their own receipts', async () => {
    const feed = publisherFeed(db)
    const alice = listen(feed, ALICE)
    const bob = listen(feed, BOB)
    const a1 = await issue(key(11))
    const b1 = await issue(key(21))
    const a2 = await issue(key(11))
    await settle([a1, b1, a2])

    await feed.batchSettled(BATCH)

    expect(alice.events).toEqual([
      { type: 'settlement', batchId: BATCH, settledAt: SETTLED_AT, receiptIds: [a1, a2] },
    ])
    expect(bob.events).toEqual([
      { type: 'settlement', batchId: BATCH, settledAt: SETTLED_AT, receiptIds: [b1] },
    ])
  })

  it('stops delivering once unsubscribed', async () => {
    const feed = publisherFeed(db)
    const alice = listen(feed, ALICE)
    alice.stop()
    await feed.receiptIssued(await issue(key(11)))
    expect(alice.events).toEqual([])
  })

  it('tells every subscriber to re-read when events may have been lost', () => {
    const feed = publisherFeed(db)
    const alice = listen(feed, ALICE)
    const bob = listen(feed, BOB)
    feed.resync()
    expect(alice.events).toEqual([{ type: 'resync' }])
    expect(bob.events).toEqual([{ type: 'resync' }])
  })

  it('does not touch the database while nobody is listening', async () => {
    const log = vi.fn()
    const unreachable = new Proxy({} as Database, {
      get() {
        throw new Error('database touched')
      },
    })
    const feed = publisherFeed(unreachable, log)
    await feed.receiptIssued('1'.padStart(64, '0'))
    await feed.batchSettled(BATCH)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs a failed lookup instead of failing the request that issued the receipt', async () => {
    const log = vi.fn()
    const broken = new Proxy({} as Database, {
      get() {
        throw new Error('connection reset')
      },
    })
    const feed = publisherFeed(broken, log)
    listen(feed, ALICE)
    await expect(feed.receiptIssued('1'.padStart(64, '0'))).resolves.toBeUndefined()
    expect(String(log.mock.calls[0]?.[0])).toContain('connection reset')
  })
})
