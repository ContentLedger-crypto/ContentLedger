import { createHash } from 'node:crypto'
import {
  acceptedAtColumns,
  batches,
  domains,
  MIGRATIONS_DIR,
  receipts,
  sessions,
  works,
} from '@contentledger/db'
import { publisherReceiptSchema, settlementEventSchema } from '@contentledger/shared'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Hono } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { type Feed, publisherFeed } from '../publisher/feed.js'
import { publisherRoutes } from './publisher.js'

const DASHBOARD = 'https://publisher.example'
const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58()
const ALICE = key(1)
const BOB = key(2)
const AGENT = key(9)
const TOKENS: Record<string, string> = { [ALICE]: 'a'.repeat(43), [BOB]: 'b'.repeat(43) }
const MAX_STREAMS = 3
const HEARTBEAT_MS = 50

let db: ReturnType<typeof drizzle>
let feed: Feed
let subscriptions = 0
let closing: AbortController
let app: Hono
let nextReceipt = 0
const opened: Array<() => Promise<void>> = []

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate receipts, batches, works, domains, sessions cascade`)
  nextReceipt = 0
  await db.insert(sessions).values(
    [ALICE, BOB].map((wallet) => ({
      tokenHash: sha256Hex(TOKENS[wallet] ?? ''),
      wallet,
      expiresAt: new Date(Date.now() + 60_000),
    })),
  )
  await db.insert(domains).values([domainRow('alice.test', ALICE), domainRow('bob.test', BOB)])
  await db.insert(works).values([workRow(key(11), 'alice.test'), workRow(key(21), 'bob.test')])

  const real = publisherFeed(db)
  subscriptions = 0
  feed = {
    ...real,
    subscribe(wallet, listener) {
      subscriptions += 1
      const unsubscribe = real.subscribe(wallet, listener)
      return () => {
        subscriptions -= 1
        unsubscribe()
      }
    },
  }
  closing = new AbortController()
  app = createApp(
    publisherRoutes({
      db,
      now: () => new Date(),
      dashboardOrigin: DASHBOARD,
      registry: { countWorks: async () => 0 },
      limits: { addressOf: () => '203.0.113.9', publisher: { take: () => ({ ok: true }) } },
      feed,
      streams: { maxPerAddress: MAX_STREAMS, heartbeatMs: HEARTBEAT_MS },
      closing: closing.signal,
    }),
  )
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map((close) => close()))
})

function domainRow(host: string, owner: string) {
  return {
    host,
    owner,
    payoutOwner: owner,
    rateTrain: 2000n,
    rateInference: 500n,
    status: 'active' as const,
    slot: 1n,
  }
}

function workRow(id: string, host: string) {
  return {
    id,
    host,
    sourceId: `https://${host}/a`,
    contentHash: 'aa'.repeat(32),
    rateTrain: null,
    rateInference: null,
    status: 'active' as const,
    mediaType: 'text/html',
    byteLen: 100,
    slot: 1n,
  }
}

async function issue(workId: string): Promise<string> {
  nextReceipt += 1
  const id = nextReceipt.toString(16).padStart(64, '0')
  await db.insert(receipts).values({
    id,
    consumer: AGENT,
    workId,
    useType: 'inference',
    tariff: 500n,
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

interface Frame {
  event?: string
  data?: unknown
  comment?: string
}

/** Reads the SSE body frame by frame; `null` once the server has ended the stream. */
async function connect(wallet?: string) {
  const res = await app.request('/v1/publisher/stream', {
    headers: {
      Origin: DASHBOARD,
      ...(wallet === undefined ? {} : { Authorization: `Bearer ${TOKENS[wallet]}` }),
    },
  })
  const reader = res.status === 200 ? res.body?.getReader() : undefined
  const decoder = new TextDecoder()
  let buffered = ''
  let done = false
  const close = async () => {
    if (!done) await reader?.cancel().catch(() => {})
    done = true
  }
  opened.push(close)

  async function next(timeoutMs = 2_000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const end = buffered.indexOf('\n\n')
      if (end !== -1) {
        const block = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        return parse(block)
      }
      if (reader === undefined || done) return null
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('no frame in time')
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no frame in time')), left),
        ),
      ])
      if (chunk.done) {
        done = true
        return null
      }
      buffered += decoder.decode(chunk.value, { stream: true })
    }
  }

  /** Skips heartbeats, which arrive whenever they please. */
  async function nextEvent(timeoutMs?: number): Promise<Frame | null> {
    while (true) {
      const frame = await next(timeoutMs)
      if (frame?.comment === undefined) return frame
    }
  }

  return { res, next, nextEvent, close }
}

function parse(block: string): Frame {
  const frame: Frame = {}
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim()
    else if (line.startsWith('event: ')) frame.event = line.slice('event: '.length)
    else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice('data: '.length))
  }
  return frame
}

describe('GET /v1/publisher/stream', () => {
  it('requires a session', async () => {
    const { res } = await connect()
    expect(res.status).toBe(401)
  })

  it('says ready once subscribed, then streams own receipts and only those', async () => {
    const alice = await connect(ALICE)
    const bob = await connect(BOB)
    expect(alice.res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(alice.res.headers.get('Access-Control-Allow-Origin')).toBe(DASHBOARD)
    expect(await alice.nextEvent()).toEqual({ event: 'ready', data: {} })
    expect(await bob.nextEvent()).toEqual({ event: 'ready', data: {} })

    const own = await issue(key(11))
    await feed.receiptIssued(own)
    const others = await issue(key(21))
    await feed.receiptIssued(others)

    const receipt = await alice.nextEvent()
    expect(() => publisherReceiptSchema.parse(receipt?.data)).not.toThrow()
    expect(receipt).toEqual({
      event: 'receipt',
      data: {
        id: own,
        workId: key(11),
        sourceId: 'https://alice.test/a',
        consumer: AGENT,
        useType: 'inference',
        tariff: '500',
        acceptedAt: '2026-10-07T08:01:00.000Z',
        settledAt: null,
      },
    })
    expect(await bob.nextEvent()).toMatchObject({ event: 'receipt', data: { id: others } })
  })

  it('streams settlements and resyncs', async () => {
    const alice = await connect(ALICE)
    await alice.nextEvent()
    const id = await issue(key(11))
    const batchId = 'bb'.repeat(32)
    const settledAt = new Date('2026-10-07T09:00:00.000Z')
    await db.insert(batches).values({
      id: batchId,
      consumer: AGENT,
      seqFrom: 1n,
      seqTo: 1n,
      root: batchId,
      chain: 'cc'.repeat(32),
      txSig: '1'.repeat(88),
      publishedAt: settledAt,
    })
    await db.update(receipts).set({ batchId, settledAt }).where(eq(receipts.id, id))

    await feed.batchSettled(batchId)
    feed.resync()

    const settlement = await alice.nextEvent()
    expect(() => settlementEventSchema.parse(settlement?.data)).not.toThrow()
    expect(settlement).toEqual({
      event: 'settlement',
      data: { batchId, settledAt: settledAt.toISOString(), receiptIds: [id] },
    })
    expect(await alice.nextEvent()).toEqual({ event: 'resync', data: {} })
  })

  it('keeps a quiet stream alive with heartbeats', async () => {
    const alice = await connect(ALICE)
    expect(await alice.next()).toMatchObject({ event: 'ready' })
    expect(await alice.next(HEARTBEAT_MS * 10)).toEqual({ comment: 'ping' })
  })

  it('ends when the session does', async () => {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 300) })
      .where(eq(sessions.wallet, ALICE))
    const alice = await connect(ALICE)
    expect(await alice.nextEvent()).toMatchObject({ event: 'ready' })
    expect(await alice.nextEvent(2_000)).toBeNull()
  })

  it('ends every stream on shutdown', async () => {
    const alice = await connect(ALICE)
    const bob = await connect(BOB)
    await alice.nextEvent()
    await bob.nextEvent()
    closing.abort()
    expect(await alice.nextEvent()).toBeNull()
    expect(await bob.nextEvent()).toBeNull()
  })

  it('caps open streams per address and frees a slot when one closes', async () => {
    const streams = []
    for (let i = 0; i < MAX_STREAMS; i += 1) {
      const stream = await connect(i % 2 === 0 ? ALICE : BOB)
      await stream.nextEvent()
      streams.push(stream)
    }

    const refused = await connect(ALICE)
    expect(refused.res.status).toBe(429)
    expect(await refused.res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })

    await streams[0]?.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const admitted = await connect(ALICE)
    expect(admitted.res.status).toBe(200)
    expect(await admitted.nextEvent()).toMatchObject({ event: 'ready' })
  })

  it('unsubscribes a stream the client has closed, or that the server ended', async () => {
    const alice = await connect(ALICE)
    const bob = await connect(BOB)
    await alice.nextEvent()
    await bob.nextEvent()
    expect(subscriptions).toBe(2)

    await alice.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(subscriptions).toBe(1)

    closing.abort()
    expect(await bob.nextEvent()).toBeNull()
    expect(subscriptions).toBe(0)
  })
})
