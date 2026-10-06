import { createHash, randomBytes } from 'node:crypto'
import { authChallenges, sessions } from '@contentledger/db'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import { and, eq, gt, isNull, lte } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { apiError } from '../errors.js'
import type { RateLimiter } from '../rate-limit.js'
import type { Database } from '../store.js'

export type Cluster = 'mainnet' | 'devnet' | 'testnet' | 'localnet'

/** Minted only by `requireSession`: a wallet from a query string must not type-check as one. */
export type SessionWallet = string & { readonly __brand: 'SessionWallet' }

export interface AuthDeps {
  db: Database
  now: () => Date
  /** Scheme, host and port only: it is both the CORS origin and the domain the wallet signs for. */
  dashboardOrigin: string
  cluster: Cluster
  limits: {
    addressOf: (c: Context) => string
    /** Challenge and verify together, by client address: each one touches the database unsigned. */
    auth: RateLimiter
  }
}

/** The fields of a Sign In With Solana request, as the wallet standard's `signIn` takes them. */
export interface SignInInput {
  domain: string
  address: string
  statement: string
  uri: string
  version: string
  chainId: string
  nonce: string
  issuedAt: string
  expirationTime: string
}

const CHALLENGE_TTL_MS = 5 * 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
const STATEMENT = 'Sign in to the ContentLedger publisher dashboard.'

// Zod 4 runs a refinement even after the regex has failed, and bs58 throws on a
// character outside its alphabet: the shape check has to gate the decode itself.
const base58Bytes = (
  shape: RegExp,
  length: number,
  accept: (bytes: Uint8Array) => boolean,
  message: string,
) =>
  z.string().superRefine((value, ctx) => {
    if (!shape.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'not base58 of the expected length' })
      return
    }
    const bytes = utils.bytes.bs58.decode(value)
    if (bytes.length !== length || !accept(bytes)) ctx.addIssue({ code: 'custom', message })
  })

const wallet = base58Bytes(
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  32,
  (bytes) => PublicKey.isOnCurve(bytes),
  'not a public key on the ed25519 curve',
)

const challengeBody = z.object({ wallet })

const verifyBody = z.object({
  wallet,
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  signature: base58Bytes(
    /^[1-9A-HJ-NP-Za-km-z]{86,88}$/,
    64,
    () => true,
    'not a 64-byte signature',
  ),
})

const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/

/**
 * The text a wallet builds from `SignInInput`. Verify rebuilds it from the stored challenge
 * and checks the signature over these exact bytes, so nothing the client sends is parsed.
 */
export function signInMessage(input: SignInInput): string {
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    input.address,
    '',
    input.statement,
    '',
    `URI: ${input.uri}`,
    `Version: ${input.version}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join('\n')
}

export function authRoutes({ db, now, dashboardOrigin, cluster, limits }: AuthDeps): Hono {
  const app = new Hono()
  const site = { domain: new URL(dashboardOrigin).host, uri: dashboardOrigin }
  const inputFor = (address: string, nonce: string, expiresAt: Date): SignInInput => ({
    ...site,
    address,
    statement: STATEMENT,
    version: '1',
    chainId: `solana:${cluster}`,
    nonce,
    issuedAt: new Date(expiresAt.getTime() - CHALLENGE_TTL_MS).toISOString(),
    expirationTime: expiresAt.toISOString(),
  })

  app.use(
    '/v1/auth/*',
    cors({ origin: dashboardOrigin, allowMethods: ['POST'], allowHeaders: ['Content-Type'] }),
  )
  app.use('/v1/auth/*', async (c, next) => {
    const allowed = limits.auth.take(limits.addressOf(c))
    if (allowed.ok) return next()
    c.header('Retry-After', String(allowed.retryAfter))
    return c.json(
      apiError('RATE_LIMITED', 'too many requests', { retryAfter: allowed.retryAfter }),
      429,
    )
  })

  app.post('/v1/auth/challenge', async (c) => {
    const body = challengeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return invalid(c, body.error)

    const at = now()
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = new Date(at.getTime() + CHALLENGE_TTL_MS)
    await db.delete(authChallenges).where(lte(authChallenges.expiresAt, at))
    await db.insert(authChallenges).values({ nonce, wallet: body.data.wallet, expiresAt })

    const input = inputFor(body.data.wallet, nonce, expiresAt)
    return c.json({ input, message: signInMessage(input) })
  })

  app.post('/v1/auth/verify', async (c) => {
    const body = verifyBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return invalid(c, body.error)
    const { wallet: address, nonce, signature } = body.data

    const [challenge] = await db
      .select()
      .from(authChallenges)
      .where(and(eq(authChallenges.nonce, nonce), eq(authChallenges.wallet, address)))
    if (challenge === undefined) return denied(c)
    const message = new TextEncoder().encode(
      signInMessage(inputFor(address, nonce, challenge.expiresAt)),
    )
    const signed = ed25519.verify(
      utils.bytes.bs58.decode(signature),
      message,
      utils.bytes.bs58.decode(address),
    )
    // Burned only after the signature holds: anyone may know a nonce, and a forged
    // attempt must not cost the wallet owner its sign-in.
    if (!signed) return denied(c)

    const at = now()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS)
    const issued = await db.transaction(async (tx) => {
      const burned = await tx
        .update(authChallenges)
        .set({ usedAt: at })
        .where(
          and(
            eq(authChallenges.nonce, nonce),
            isNull(authChallenges.usedAt),
            gt(authChallenges.expiresAt, at),
          ),
        )
        .returning({ nonce: authChallenges.nonce })
      if (burned.length === 0) return false
      await tx.delete(sessions).where(lte(sessions.expiresAt, at))
      await tx.insert(sessions).values({ tokenHash: sha256Hex(token), wallet: address, expiresAt })
      return true
    })
    if (!issued) return denied(c)

    return c.json({ token, expiresAt: expiresAt.toISOString() })
  })

  return app
}

export function requireSession(db: Database, now: () => Date) {
  return createMiddleware<{ Variables: { wallet: SessionWallet } }>(async (c, next) => {
    const token = bearer.exec(c.req.header('Authorization') ?? '')?.[1]
    if (token === undefined) return denied(c)
    const [session] = await db
      .select({ wallet: sessions.wallet })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, now())))
    if (session === undefined) return denied(c)
    c.set('wallet', session.wallet as SessionWallet)
    await next()
  })
}

const invalid = (c: Context, error: z.ZodError) =>
  c.json(apiError('INVALID_INPUT', 'invalid body', { issues: z.flattenError(error) }), 400)

// One answer for every failure: which check failed tells a prober whether a nonce exists.
function denied(c: Context) {
  c.header('WWW-Authenticate', 'Bearer')
  return c.json(apiError('UNAUTHORIZED', 'sign-in required', {}), 401)
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')
