import { createHash } from 'node:crypto'
import {
  acceptedAtColumns,
  domains,
  MIGRATIONS_DIR,
  receipts,
  sessions,
  works,
} from '@contentledger/db'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { PAGE_SIZE } from '../publisher/queries.js'
import type { RateLimiter } from '../rate-limit.js'
import type { OwnedWorksReader } from '../registry.js'
import { type PublisherDeps, publisherRoutes } from './publisher.js'

const DASHBOARD = 'https://publisher.example'
const NOW = new Date('2026-10-06T12:00:00.000Z')

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58()
const ALICE = key(1)
const BOB = key(2)
const AGENT = key(9)
const TOKENS = { [ALICE]: 'a'.repeat(43), [BOB]: 'b'.repeat(43) }

let db: ReturnType<typeof drizzle>
let refuse: boolean
let registry: OwnedWorksReader
let nextReceipt = 0

const limiter: RateLimiter = {
  take: () => (refuse ? { ok: false, retryAfter: 7 } : { ok: true }),
}

const deps = (): PublisherDeps => ({
  db,
  now: () => NOW,
  dashboardOrigin: DASHBOARD,
  registry,
  limits: { addressOf: () => '203.0.113.9', publisher: limiter },
})

const get = (path: string, wallet?: string, headers: Record<string, string> = {}) =>
  createApp(publisherRoutes(deps())).request(path, {
    headers: {
      Origin: DASHBOARD,
      ...(wallet === undefined ? {} : { Authorization: `Bearer ${TOKENS[wallet]}` }),
      ...headers,
    },
  })

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate receipts, works, domains, sessions cascade`)
  refuse = false
  nextReceipt = 0
  registry = { countWorks: async () => 2 }
  await db.insert(sessions).values(
    [ALICE, BOB].map((wallet) => ({
      tokenHash: sha256Hex(TOKENS[wallet] ?? ''),
      wallet,
      expiresAt: new Date(NOW.getTime() + 60_000),
    })),
  )
  await db.insert(domains).values([domainRow('alice.test', ALICE), domainRow('bob.test', BOB)])
  await db
    .insert(works)
    .values([
      workRow(key(11), 'alice.test', 'https://alice.test/a'),
      workRow(key(12), 'alice.test', 'https://alice.test/b'),
      workRow(key(21), 'bob.test', 'https://bob.test/a'),
    ])
})

afterEach(() => {
  vi.restoreAllMocks()
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

const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 11, minute)).toISOString()

// Above 2^53, where a JSON number would round: the API must carry money as text.
const HUGE = 2n ** 60n + 1n

interface ReceiptsPage {
  items: Array<Record<string, unknown>>
  nextCursor: string | null
}

describe('GET /v1/publisher/receipts', () => {
  it("serves the session wallet's receipts with money as decimal strings", async () => {
    await db
      .insert(receipts)
      .values([
        receiptRow(key(11), at(1), HUGE),
        receiptRow(key(21), at(2), 2000n),
        receiptRow(key(12), at(3), 500n),
      ])
    await db
      .update(receipts)
      .set({ settledAt: new Date(at(4)) })
      .where(sql`${receipts.id} = ${'1'.padStart(64, '0')}`)

    const res = await get('/v1/publisher/receipts', ALICE)

    expect(res.status).toBe(200)
    const page = (await res.json()) as ReceiptsPage
    expect(page.nextCursor).toBeNull()
    expect(page.items).toEqual([
      {
        id: '3'.padStart(64, '0'),
        workId: key(12),
        sourceId: 'https://alice.test/b',
        consumer: AGENT,
        useType: 'train',
        tariff: '500',
        acceptedAt: at(3),
        settledAt: null,
      },
      {
        id: '1'.padStart(64, '0'),
        workId: key(11),
        sourceId: 'https://alice.test/a',
        consumer: AGENT,
        useType: 'train',
        tariff: HUGE.toString(),
        acceptedAt: at(1),
        settledAt: at(4),
      },
    ])
  })

  it('pages through the cursor it hands out', async () => {
    await db
      .insert(receipts)
      .values(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => receiptRow(key(11), at(i % 60), 1n)))

    const first = (await (await get('/v1/publisher/receipts', ALICE)).json()) as ReceiptsPage
    expect(first.items).toHaveLength(PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()

    const cursor = encodeURIComponent(first.nextCursor ?? '')
    const res = await get(`/v1/publisher/receipts?cursor=${cursor}`, ALICE)
    const second = (await res.json()) as ReceiptsPage
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const ids = new Set([...first.items, ...second.items].map((item) => item.id))
    expect(ids.size).toBe(PAGE_SIZE + 1)
  })

  it("does not show another publisher's receipts", async () => {
    await db.insert(receipts).values(receiptRow(key(11), at(1), 2000n))
    const page = (await (await get('/v1/publisher/receipts', BOB)).json()) as ReceiptsPage
    expect(page.items).toEqual([])
  })

  it.each([
    ['a host to widen the view', '?host=alice.test'],
    ['a wallet to widen the view', `?wallet=${ALICE}`],
    ['a malformed cursor', '?cursor=nope'],
    ['a repeated cursor', `?cursor=${at(1)}_${'1'.padStart(64, '0')}&cursor=x`],
  ])('refuses %s with 400', async (_, query) => {
    await db.insert(receipts).values(receiptRow(key(11), at(1), 2000n))
    const res = await get(`/v1/publisher/receipts${query}`, BOB)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })
})

describe('GET /v1/publisher/summary', () => {
  const period = `?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(30))}`

  it('sums the period by work, with the count of works registered on chain', async () => {
    const asked: string[] = []
    registry = {
      countWorks: async (owner) => {
        asked.push(owner)
        return 5
      },
    }
    await db
      .insert(receipts)
      .values([
        receiptRow(key(11), at(1), HUGE),
        receiptRow(key(11), at(2), 2000n),
        receiptRow(key(12), at(3), 500n),
        receiptRow(key(12), at(30), 700n),
        receiptRow(key(21), at(4), 900n),
      ])

    const res = await get(`/v1/publisher/summary${period}`, ALICE)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      total: (HUGE + 2500n).toString(),
      count: 3,
      byWork: [
        {
          workId: key(11),
          sourceId: 'https://alice.test/a',
          count: 2,
          total: (HUGE + 2000n).toString(),
        },
        { workId: key(12), sourceId: 'https://alice.test/b', count: 1, total: '500' },
      ],
      registeredWorks: 5,
    })
    expect(asked).toEqual([ALICE])
  })

  it('tells a publisher with nothing registered so, rather than an empty period', async () => {
    registry = { countWorks: async () => 0 }
    const res = await get(`/v1/publisher/summary${period}`, BOB)
    expect(await res.json()).toEqual({ total: '0', count: 0, byWork: [], registeredWorks: 0 })
  })

  it('still answers when the chain cannot be read, without leaking the RPC key', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry = {
      countWorks: async () => {
        throw new Error('fetch https://devnet.helius-rpc.com/?api-key=SECRET failed')
      },
    }
    await db.insert(receipts).values(receiptRow(key(11), at(1), 2000n))

    const res = await get(`/v1/publisher/summary${period}`, ALICE)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: '2000', registeredWorks: null })
    expect(logged).toHaveBeenCalledOnce()
    expect(String(logged.mock.calls[0]?.[0])).not.toContain('SECRET')
  })

  it.each([
    ['a missing end', `?from=${encodeURIComponent(at(0))}`],
    ['a reversed period', `?from=${encodeURIComponent(at(30))}&to=${encodeURIComponent(at(0))}`],
    ['a period over 366 days', '?from=2025-01-01T00:00:00Z&to=2026-01-02T00:00:01Z'],
    ['a host to widen the view', `${period}&host=bob.test`],
  ])('refuses %s with 400', async (_, query) => {
    const res = await get(`/v1/publisher/summary${query}`, ALICE)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('accepts a period of exactly 366 days', async () => {
    const res = await get(
      '/v1/publisher/summary?from=2025-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      ALICE,
    )
    expect(res.status).toBe(200)
  })
})

describe('guards', () => {
  it.each([
    ['receipts', '/v1/publisher/receipts'],
    ['summary', `/v1/publisher/summary?from=${at(0)}&to=${at(1)}`],
  ])('requires a session for %s, and says so to the dashboard', async (_, path) => {
    const res = await get(path)
    expect(res.status).toBe(401)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DASHBOARD)
  })

  it('refuses an expired session', async () => {
    await db.update(sessions).set({ expiresAt: NOW })
    expect((await get('/v1/publisher/receipts', ALICE)).status).toBe(401)
  })

  it('limits by address before looking the token up', async () => {
    refuse = true
    const res = await get('/v1/publisher/receipts')
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DASHBOARD)
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })

  const preflight = (origin: string) =>
    createApp(publisherRoutes(deps())).request('/v1/publisher/receipts', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    })

  it('lets the dashboard send its bearer token, without spending the rate limit', async () => {
    refuse = true
    const res = await preflight(DASHBOARD)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DASHBOARD)
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'authorization',
    )
  })

  it('does not let another site read the API', async () => {
    const res = await preflight('https://evil.example')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
