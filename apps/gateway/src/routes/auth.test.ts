import { createHash } from 'node:crypto'
import { authChallenges, MIGRATIONS_DIR, sessions } from '@contentledger/db'
import { type AuthChallenge, authChallengeSchema, sessionGrantSchema } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PGlite } from '@electric-sql/pglite'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { Hono } from 'hono'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { RateLimiter } from '../rate-limit.js'
import { type AuthDeps, authRoutes, requireSession, signInMessage } from './auth.js'

const DASHBOARD = 'https://publisher.example'
const START = new Date('2026-10-06T12:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

let db: ReturnType<typeof drizzle>
let at: Date
let refuse: boolean

const limiter: RateLimiter = {
  take: () => (refuse ? { ok: false, retryAfter: 7 } : { ok: true }),
}

const deps = (): AuthDeps => ({
  db,
  now: () => at,
  dashboardOrigin: DASHBOARD,
  cluster: 'devnet',
  limits: { addressOf: () => '203.0.113.9', auth: limiter },
})

function buildApp() {
  const guarded = new Hono()
  guarded.get(
    '/v1/whoami',
    requireSession(db, () => at),
    (c) => c.json({ wallet: c.get('wallet') }),
  )
  return createApp(authRoutes(deps()), guarded)
}

function keypair() {
  const secret = ed25519.utils.randomSecretKey()
  return { secret, wallet: new PublicKey(ed25519.getPublicKey(secret)).toBase58() }
}

const post = (path: string, body: unknown) =>
  buildApp().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DASHBOARD },
    body: JSON.stringify(body),
  })

async function challenge(wallet: string): Promise<AuthChallenge> {
  const res = await post('/v1/auth/challenge', { wallet })
  expect(res.status).toBe(200)
  return authChallengeSchema.parse(await res.json())
}

const sign = (secret: Uint8Array, message: string) =>
  utils.bytes.bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret))

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate auth_challenges, sessions`)
  at = START
  refuse = false
})

describe('signInMessage', () => {
  it('lays the fields out exactly as the Sign In With Solana text format', () => {
    expect(
      signInMessage({
        domain: 'publisher.example',
        address: 'Wa11et1111111111111111111111111111111111111',
        statement: 'Sign in.',
        uri: 'https://publisher.example',
        version: '1',
        chainId: 'solana:devnet',
        nonce: 'abcdef0123456789',
        issuedAt: '2026-10-06T12:00:00.000Z',
        expirationTime: '2026-10-06T12:05:00.000Z',
      }),
    ).toBe(
      [
        'publisher.example wants you to sign in with your Solana account:',
        'Wa11et1111111111111111111111111111111111111',
        '',
        'Sign in.',
        '',
        'URI: https://publisher.example',
        'Version: 1',
        'Chain ID: solana:devnet',
        'Nonce: abcdef0123456789',
        'Issued At: 2026-10-06T12:00:00.000Z',
        'Expiration Time: 2026-10-06T12:05:00.000Z',
      ].join('\n'),
    )
  })
})

describe('POST /v1/auth/challenge', () => {
  it('binds a fresh nonce to the wallet, the dashboard and five minutes', async () => {
    const { wallet } = keypair()
    const { input, message } = await challenge(wallet)

    expect(input).toMatchObject({
      domain: 'publisher.example',
      address: wallet,
      uri: DASHBOARD,
      version: '1',
      chainId: 'solana:devnet',
      issuedAt: START.toISOString(),
      expirationTime: new Date(START.getTime() + 5 * MINUTE).toISOString(),
    })
    expect(input.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(message).toBe(signInMessage(input))

    const rows = await db.select().from(authChallenges)
    expect(rows).toEqual([
      {
        nonce: input.nonce,
        wallet,
        expiresAt: new Date(START.getTime() + 5 * MINUTE),
        usedAt: null,
      },
    ])
  })

  it('gives every request its own nonce', async () => {
    const { wallet } = keypair()
    const first = await challenge(wallet)
    const second = await challenge(wallet)
    expect(first.input.nonce).not.toBe(second.input.nonce)
  })

  it('drops challenges that have expired when it writes a new one', async () => {
    const { wallet } = keypair()
    const stale = await challenge(wallet)
    at = new Date(START.getTime() + 5 * MINUTE)
    const fresh = await challenge(wallet)

    const nonces = (await db.select().from(authChallenges)).map((row) => row.nonce)
    expect(nonces).toEqual([fresh.input.nonce])
    expect(nonces).not.toContain(stale.input.nonce)
  })

  it('refuses a key that is not a point on the curve', async () => {
    const offCurve = new PublicKey(new Uint8Array(32).fill(0xff))
    expect(PublicKey.isOnCurve(offCurve.toBytes())).toBe(false)

    const res = await post('/v1/auth/challenge', { wallet: offCurve.toBase58() })
    expect(res.status).toBe(400)
    expect(await db.select().from(authChallenges)).toEqual([])
  })

  it('refuses a wallet with characters outside base58 as invalid input, not a crash', async () => {
    const res = await post('/v1/auth/challenge', { wallet: `0OIl${'1'.repeat(40)}` })
    expect(res.status).toBe(400)
  })

  it('refuses a body without a wallet', async () => {
    const res = await post('/v1/auth/challenge', { address: keypair().wallet })
    expect(res.status).toBe(400)
    expect((await res.json()) as unknown).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('answers 429 with Retry-After once the address has used its budget', async () => {
    refuse = true
    const res = await post('/v1/auth/challenge', { wallet: keypair().wallet })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(await db.select().from(authChallenges)).toEqual([])
  })
})

describe('POST /v1/auth/verify', () => {
  it('exchanges a signed challenge for a twelve-hour session stored only as a hash', async () => {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)

    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, message),
    })
    expect(res.status).toBe(200)
    const { token, expiresAt } = sessionGrantSchema.parse(await res.json())
    expect(expiresAt).toBe(new Date(START.getTime() + 12 * HOUR).toISOString())

    const rows = await db.select().from(sessions)
    expect(rows).toEqual([
      {
        tokenHash: sha256Hex(token),
        wallet,
        expiresAt: new Date(START.getTime() + 12 * HOUR),
      },
    ])
    const [used] = await db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.nonce, input.nonce))
    expect(used?.usedAt).toEqual(START)
  })

  it('does not accept the same challenge twice', async () => {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)
    const body = { wallet, nonce: input.nonce, signature: sign(secret, message) }

    expect((await post('/v1/auth/verify', body)).status).toBe(200)
    const replay = await post('/v1/auth/verify', body)
    expect(replay.status).toBe(401)
    expect((await replay.json()) as unknown).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  it('lets exactly one of two simultaneous uses of a challenge through', async () => {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)
    const body = { wallet, nonce: input.nonce, signature: sign(secret, message) }

    const statuses = (
      await Promise.all([post('/v1/auth/verify', body), post('/v1/auth/verify', body)])
    ).map((res) => res.status)
    expect(statuses.sort()).toEqual([200, 401])
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  it('refuses a challenge signed after it expired', async () => {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)
    at = new Date(START.getTime() + 5 * MINUTE)

    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, message),
    })
    expect(res.status).toBe(401)
    expect(await db.select().from(sessions)).toEqual([])
  })

  it('accepts a challenge signed a moment before it expires', async () => {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)
    at = new Date(START.getTime() + 5 * MINUTE - 1)

    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, message),
    })
    expect(res.status).toBe(200)
  })

  it('leaves the challenge usable after a bad signature, so a stranger cannot burn it', async () => {
    const { secret, wallet } = keypair()
    const stranger = keypair()
    const { input, message } = await challenge(wallet)

    const forged = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(stranger.secret, message),
    })
    expect(forged.status).toBe(401)

    const genuine = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, message),
    })
    expect(genuine.status).toBe(200)
  })

  it('refuses a challenge presented by a wallet it was not issued to', async () => {
    const owner = keypair()
    const other = keypair()
    const { input, message } = await challenge(owner.wallet)

    const res = await post('/v1/auth/verify', {
      wallet: other.wallet,
      nonce: input.nonce,
      signature: sign(other.secret, message.replace(owner.wallet, other.wallet)),
    })
    expect(res.status).toBe(401)
    expect(await db.select().from(sessions)).toEqual([])
  })

  it('refuses a signature over the same nonce for another site', async () => {
    const { secret, wallet } = keypair()
    const { input } = await challenge(wallet)
    const phished = signInMessage({
      ...input,
      domain: 'evil.example',
      uri: 'https://evil.example',
    })

    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, phished),
    })
    expect(res.status).toBe(401)
  })

  it('refuses an unknown nonce', async () => {
    const { secret, wallet } = keypair()
    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: '0'.repeat(32),
      signature: sign(secret, 'anything'),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a malformed signature as invalid input', async () => {
    const { wallet } = keypair()
    const { input } = await challenge(wallet)
    const res = await post('/v1/auth/verify', { wallet, nonce: input.nonce, signature: 'abc' })
    expect(res.status).toBe(400)
  })

  it('refuses a signature with characters outside base58 as invalid input, not a crash', async () => {
    const { wallet } = keypair()
    const { input } = await challenge(wallet)
    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: `0OIl${'1'.repeat(84)}`,
    })
    expect(res.status).toBe(400)
  })

  it('shares the challenge budget', async () => {
    refuse = true
    const { secret, wallet } = keypair()
    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: '0'.repeat(32),
      signature: sign(secret, 'anything'),
    })
    expect(res.status).toBe(429)
  })
})

describe('requireSession', () => {
  async function signIn() {
    const { secret, wallet } = keypair()
    const { input, message } = await challenge(wallet)
    const res = await post('/v1/auth/verify', {
      wallet,
      nonce: input.nonce,
      signature: sign(secret, message),
    })
    const { token } = (await res.json()) as { token: string }
    return { wallet, token }
  }

  const whoami = (authorization?: string) =>
    buildApp().request(
      '/v1/whoami',
      authorization === undefined ? {} : { headers: { Authorization: authorization } },
    )

  it('hands the route the wallet the session was issued to', async () => {
    const { wallet, token } = await signIn()
    const res = await whoami(`Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallet })
  })

  it('ends the session twelve hours later with no action from the user', async () => {
    const { token } = await signIn()
    at = new Date(START.getTime() + 12 * HOUR - 1)
    expect((await whoami(`Bearer ${token}`)).status).toBe(200)
    at = new Date(START.getTime() + 12 * HOUR)
    const res = await whoami(`Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('refuses a request without a token', async () => {
    expect((await whoami()).status).toBe(401)
  })

  it('refuses a token it never issued', async () => {
    await signIn()
    expect((await whoami(`Bearer ${'A'.repeat(43)}`)).status).toBe(401)
  })

  it('refuses the stored hash presented as a token', async () => {
    const { token } = await signIn()
    expect((await whoami(`Bearer ${sha256Hex(token)}`)).status).toBe(401)
  })
})

describe('CORS', () => {
  const preflight = (origin: string) =>
    buildApp().request('/v1/auth/verify', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })

  it('lets the dashboard call the sign-in endpoints', async () => {
    const res = await preflight(DASHBOARD)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(DASHBOARD)
  })

  it('does not let another site call them', async () => {
    const res = await preflight('https://evil.example')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
