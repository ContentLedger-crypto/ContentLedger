import type { settlementEventSchema } from '@contentledger/shared'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { z } from 'zod'
import { apiError } from '../errors.js'
import type { Feed, FeedEvent } from '../publisher/feed.js'
import { receiptJson } from '../publisher/queries.js'
import type { SessionVariables } from './auth.js'

export interface StreamLimits {
  /** Open at once from one client address; each holds a socket for as long as it lives. */
  maxPerAddress: number
  /** Below the idle timeout of the proxies in front, which drop a silent connection. */
  heartbeatMs: number
}

interface StreamDeps {
  feed: Feed
  now: () => Date
  addressOf: (c: Context) => string
  limits: StreamLimits
  closing: AbortSignal
}

/**
 * Stateless: the stream says `ready` once subscribed, and the dashboard reads its
 * snapshot after that, so nothing issued in between can fall through a gap.
 */
export function streamHandler({ feed, now, addressOf, limits, closing }: StreamDeps) {
  const open = new Map<string, number>()

  return (c: Context<{ Variables: SessionVariables }>) => {
    const address = addressOf(c)
    const held = open.get(address) ?? 0
    if (held >= limits.maxPerAddress) {
      return c.json(
        apiError('RATE_LIMITED', 'too many open streams', { limit: limits.maxPerAddress }),
        429,
      )
    }
    open.set(address, held + 1)
    const release = () => {
      const left = (open.get(address) ?? 1) - 1
      if (left === 0) open.delete(address)
      else open.set(address, left)
    }

    const wallet = c.get('wallet')
    const expiresAt = c.get('sessionExpiresAt')

    return streamSSE(c, async (stream) => {
      // One writer at a time: events arrive from the feed while a heartbeat may be in flight.
      let queue = Promise.resolve()
      const send = (write: () => Promise<void>) => {
        queue = queue.then(write).catch(() => {})
      }
      const unsubscribe = feed.subscribe(wallet, (event) =>
        send(() => stream.writeSSE({ event: event.type, data: JSON.stringify(dataOf(event)) })),
      )
      try {
        send(() => stream.writeSSE({ event: 'ready', data: '{}' }))
        await new Promise<void>((resolve) => {
          const ping = async () => {
            await stream.write(': ping\n\n')
          }
          const heartbeat = setInterval(() => send(ping), limits.heartbeatMs)
          // FR-018a: a session ends on its own, and a stream must not outlive it.
          const expiry = setTimeout(end, Math.max(0, expiresAt.getTime() - now().getTime()))
          function end() {
            clearInterval(heartbeat)
            clearTimeout(expiry)
            closing.removeEventListener('abort', end)
            resolve()
          }
          stream.onAbort(end)
          closing.addEventListener('abort', end)
          if (closing.aborted) end()
        })
        await queue
      } finally {
        unsubscribe()
        release()
      }
    })
  }
}

function dataOf(event: FeedEvent) {
  switch (event.type) {
    case 'receipt':
      return receiptJson(event.receipt)
    case 'settlement':
      return {
        batchId: event.batchId,
        settledAt: event.settledAt.toISOString(),
        receiptIds: event.receiptIds,
      } satisfies z.input<typeof settlementEventSchema>
    case 'resync':
      return {}
  }
}
