import type { receiptsPageSchema } from '@contentledger/shared'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { redactKeys } from '../app.js'
import { apiError, errorChain } from '../errors.js'
import type { Feed } from '../publisher/feed.js'
import {
  listReceipts,
  receiptJson,
  receiptsParams,
  summarize,
  summaryJson,
  summaryParams,
} from '../publisher/queries.js'
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
  limits,
  feed,
  streams,
  closing,
}: PublisherDeps): Hono {
  const app = new Hono()
  const session = requireSession(db, now)

  app.use(
    '/v1/publisher/*',
    cors({ origin: dashboardOrigin, allowMethods: ['GET'], allowHeaders: ['Authorization'] }),
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

const invalid = (c: Context, error: z.ZodError) =>
  c.json(apiError('INVALID_INPUT', 'invalid query', { issues: z.flattenError(error) }), 400)
