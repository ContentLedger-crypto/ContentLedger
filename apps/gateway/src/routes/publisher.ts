import {
  base58SignatureSchema,
  changeRequestSchema,
  type preparedRegistrationSchema,
  type publisherDomainsSchema,
  type publisherWorksSchema,
  type receiptsPageSchema,
  registrationRequestSchema,
  type registrationStatusSchema,
} from '@contentledger/shared'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { redactKeys } from '../app.js'
import { apiError, errorChain } from '../errors.js'
import type { ContentOrigin } from '../origin.js'
import { prepareChange } from '../publisher/changes.js'
import type { Feed } from '../publisher/feed.js'
import {
  listReceipts,
  receiptJson,
  receiptsParams,
  sourcesOf,
  summarize,
  summaryJson,
  summaryParams,
} from '../publisher/queries.js'
import {
  prepareRegistration,
  type RegistrationChain,
  registrationStatus,
  type SignatureChain,
} from '../publisher/registration.js'
import type { RateLimiter } from '../rate-limit.js'
import type { OwnedWorksReader } from '../registry.js'
import type { Database } from '../store.js'
import { requireSession } from './auth.js'
import { type StreamLimits, streamHandler } from './stream.js'

export interface PublisherDeps {
  db: Database
  now: () => Date
  dashboardOrigin: string
  registry: OwnedWorksReader
  registration: { chain: RegistrationChain & SignatureChain; origin: ContentOrigin }
  limits: {
    addressOf: (c: Context) => string
    /** By client address and ahead of the session check: a guessed token still costs a lookup. */
    publisher: RateLimiter
  }
  feed: Feed
  streams: StreamLimits
  /** Aborted on shutdown: an open stream would otherwise hold the server open for good. */
  closing: AbortSignal
}

export function publisherRoutes({
  db,
  now,
  dashboardOrigin,
  registry,
  registration,
  limits,
  feed,
  streams,
  closing,
}: PublisherDeps): Hono {
  const app = new Hono()
  const session = requireSession(db, now)

  app.use(
    '/v1/publisher/*',
    cors({
      origin: dashboardOrigin,
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Authorization', 'Content-Type'],
    }),
  )
  app.use('/v1/publisher/*', async (c, next) => {
    const allowed = limits.publisher.take(limits.addressOf(c))
    if (allowed.ok) return next()
    c.header('Retry-After', String(allowed.retryAfter))
    return c.json(
      apiError('RATE_LIMITED', 'too many requests', { retryAfter: allowed.retryAfter }),
      429,
    )
  })

  app.get('/v1/publisher/receipts', session, async (c) => {
    const params = receiptsParams.safeParse(queryOf(c))
    if (!params.success) return invalid(c, params.error)

    const page = await listReceipts(db, c.get('wallet'), params.data)
    return c.json({
      items: page.items.map(receiptJson),
      nextCursor: page.nextCursor,
    } satisfies z.input<typeof receiptsPageSchema>)
  })

  app.get('/v1/publisher/summary', session, async (c) => {
    const params = summaryParams.safeParse(queryOf(c))
    if (!params.success) return invalid(c, params.error)
    const wallet = c.get('wallet')

    // The mirror cannot tell "nothing registered" from "nothing earned", and only the
    // first asks the dashboard to show what to do; without the chain it shows totals alone.
    const [summary, registeredWorks] = await Promise.all([
      summarize(db, wallet, params.data),
      registry.countWorks(wallet).catch((error: unknown) => {
        console.error(`registered works of ${wallet} unread: ${redactKeys(errorChain(error))}`)
        return null
      }),
    ])
    return c.json(summaryJson(summary, registeredWorks))
  })

  app.get('/v1/publisher/domains', session, async (c) => {
    const owned = await registry.ownedDomains(c.get('wallet'))
    return c.json({
      domains: owned.map(({ address, account, works }) => ({
        address,
        host: account.host,
        rateTrain: account.rateTrain.toString(),
        rateInference: account.rateInference.toString(),
        status: account.status,
        works,
      })),
    } satisfies z.input<typeof publisherDomainsSchema>)
  })

  app.get('/v1/publisher/works', session, async (c) => {
    const owned = await registry.ownedWorks(c.get('wallet'))
    const sources = await sourcesOf(
      db,
      owned.map(({ address }) => address),
    )
    return c.json({
      works: owned.map(({ address, account }) => ({
        address,
        domain: account.domain,
        source: sources.get(address) ?? null,
        rateTrain: account.rateTrain?.toString() ?? null,
        rateInference: account.rateInference?.toString() ?? null,
        status: account.status,
      })),
    } satisfies z.input<typeof publisherWorksSchema>)
  })

  // Signed transactions are followed by GET /registrations/:signature: a change lands or
  // fails the same way a registration does.
  app.post('/v1/publisher/changes', session, async (c) => {
    const body = changeRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json(
        apiError('INVALID_INPUT', 'invalid body', { issues: z.flattenError(body.error) }),
        400,
      )
    }

    const result = await prepareChange(c.get('wallet'), body.data, registration.chain)
    if (!result.ok) {
      return c.json(apiError('CHANGE_REFUSED', 'change refused', { reason: result.reason }), 422)
    }
    return c.json(result.prepared satisfies z.input<typeof preparedRegistrationSchema>)
  })

  app.post('/v1/publisher/registrations', session, async (c) => {
    const body = registrationRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json(
        apiError('INVALID_INPUT', 'invalid body', { issues: z.flattenError(body.error) }),
        400,
      )
    }

    const result = await prepareRegistration(c.get('wallet'), body.data, registration)
    if (!result.ok) {
      return c.json(
        apiError('REGISTRATION_REFUSED', 'registration refused', { reason: result.reason }),
        422,
      )
    }
    return c.json(result.prepared satisfies z.input<typeof preparedRegistrationSchema>)
  })

  app.get('/v1/publisher/registrations/:signature', session, async (c) => {
    const params = statusParams.safeParse({
      signature: c.req.param('signature'),
      ...queryOf(c),
    })
    if (!params.success) return invalid(c, params.error)

    const status = await registrationStatus(
      params.data.signature,
      params.data.lastValidBlockHeight,
      registration.chain,
    )
    return c.json(status satisfies z.input<typeof registrationStatusSchema>)
  })

  app.get(
    '/v1/publisher/stream',
    session,
    streamHandler({ feed, now, addressOf: limits.addressOf, limits: streams, closing }),
  )

  return app
}

// A repeated key stays an array, so the strict schemas refuse it instead of taking one.
const queryOf = (c: Context) =>
  Object.fromEntries(
    Object.entries(c.req.queries()).map(([name, values]) => [
      name,
      values.length === 1 ? values[0] : values,
    ]),
  )

const statusParams = z.strictObject({
  signature: base58SignatureSchema,
  lastValidBlockHeight: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})

const invalid = (c: Context, error: z.ZodError) =>
  c.json(apiError('INVALID_INPUT', 'invalid query', { issues: z.flattenError(error) }), 400)
