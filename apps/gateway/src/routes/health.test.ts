import { MIGRATIONS_DIR, settlerHeartbeat } from '@contentledger/db'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { Database } from '../store.js'
import { healthRoutes, settlerVerdict } from './health.js'

const NOW = new Date('2026-10-07T12:00:00Z')
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000)
const pass = (ageSeconds: number, failedAgents = 0) => ({
  passedAt: secondsAgo(ageSeconds),
  intervalSeconds: 60,
  failedAgents,
})

describe('settlerVerdict', () => {
  it('is healthy right after a clean pass', () => {
    expect(settlerVerdict(pass(30), NOW)).toEqual({ healthy: true })
  })

  it('still trusts a pass three intervals old: waiting for finality can outlast one', () => {
    expect(settlerVerdict(pass(180), NOW)).toEqual({ healthy: true })
  })

  it('calls a settler stalled once its last pass is older than three intervals', () => {
    expect(settlerVerdict(pass(181), NOW)).toEqual({
      healthy: false,
      reason: 'settler last passed 181 s ago',
    })
  })

  it('is unhealthy when the last pass gave up on an agent', () => {
    expect(settlerVerdict(pass(10, 2), NOW)).toEqual({
      healthy: false,
      reason: 'settler gave up on 2 agents in its last pass',
    })
  })

  it('is unhealthy when the settler has never reported', () => {
    expect(settlerVerdict(null, NOW)).toEqual({
      healthy: false,
      reason: 'settler has not reported a pass',
    })
  })
})

describe('GET /health', () => {
  let db: ReturnType<typeof drizzle>

  beforeAll(async () => {
    const client = new PGlite()
    // Supabase ships these roles; the RLS migration names them in its policies.
    await client.exec('create role anon; create role authenticated;')
    db = drizzle(client)
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  })

  beforeEach(async () => {
    await db.execute(sql`truncate settler_heartbeat`)
  })

  const get = (database: Database, method = 'GET') =>
    createApp(healthRoutes({ db: database, now: () => NOW })).request('/health', { method })

  it('answers 200 with the last pass when the settler keeps up', async () => {
    await db.insert(settlerHeartbeat).values({ id: 1, ...pass(42) })

    const response = await get(db)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      status: 'ok',
      settler: { passedAt: '2026-10-07T11:59:18.000Z', ageSeconds: 42, failedAgents: 0 },
    })
  })

  it('answers HEAD too, as uptime monitors send it', async () => {
    await db.insert(settlerHeartbeat).values({ id: 1, ...pass(42) })
    expect((await get(db, 'HEAD')).status).toBe(200)
  })

  it('answers 503 with the reason when the settler has stalled', async () => {
    await db.insert(settlerHeartbeat).values({ id: 1, ...pass(600) })

    const response = await get(db)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'degraded',
      reason: 'settler last passed 600 s ago',
      settler: { passedAt: '2026-10-07T11:50:00.000Z', ageSeconds: 600, failedAgents: 0 },
    })
  })

  it('answers 503 without the cause when the database cannot be read', async () => {
    const broken = {
      select: () => {
        throw new Error('connect ECONNREFUSED postgres://user:secret@host:6543')
      },
    } as unknown as Database

    const response = await get(broken)

    expect(response.status).toBe(503)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ status: 'down', reason: 'database unreachable' })
    expect(body).not.toContain('secret')
  })
})
