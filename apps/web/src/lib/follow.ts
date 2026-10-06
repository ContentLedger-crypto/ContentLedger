import type { PublisherReceipt } from '@contentledger/shared'
import { ApiError, type FeedEvent, type FeedSource } from './api'
import { type FeedState, withReceipt, withSettlement, withSnapshot } from './feed'

const RETRY_FLOOR_MS = 1000
const RETRY_CEILING_MS = 30_000

export function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  const backoff = Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** attempt)
  return Math.max(backoff, (retryAfterSeconds ?? 0) * 1000)
}

export type Link = 'connecting' | 'live' | 'reconnecting'

export interface FeedSink {
  update(change: (state: FeedState) => FeedState): void
  link(link: Link): void
  arrival(receipt: PublisherReceipt): void
  /** The gateway refused the session: it ended, or was never valid. Nothing is retried. */
  unauthorized(): void
}

// A stream that stayed up this long was healthy: a gateway restart is not a failure streak.
const HEALTHY_MS = 60_000

/**
 * One stream at a time, re-opened after a pause that grows while it keeps failing. Every
 * `ready` and `resync` re-reads the first page, so nothing issued while the stream was
 * down is missed; a failed read ends the attempt and goes through the same retry.
 */
export async function followFeed(
  source: FeedSource,
  sink: FeedSink,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    const opened = Date.now()
    const failure = await attempt(source, sink, signal)
    if (signal.aborted) return
    if (failure instanceof ApiError && failure.status === 401) {
      sink.unauthorized()
      return
    }
    failures = Date.now() - opened > HEALTHY_MS ? 1 : failures + 1
    sink.link('reconnecting')
    const retryAfter = failure instanceof ApiError ? failure.retryAfter : null
    await pause(retryDelayMs(failures - 1, retryAfter), signal)
  }
}

async function attempt(source: FeedSource, sink: FeedSink, signal: AbortSignal) {
  const current = new AbortController()
  const stop = () => current.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  let failure: unknown = null
  const fail = (error: unknown) => {
    failure ??= error
    current.abort(error)
  }
  const snapshot = () =>
    source.receipts(null, current.signal).then((page) => {
      sink.update((state) => withSnapshot(state, page))
      sink.link('live')
    }, fail)
  const handle = (event: FeedEvent) => {
    switch (event.type) {
      case 'ready':
      case 'resync':
        void snapshot()
        break
      case 'receipt':
        sink.update((state) => withReceipt(state, event.receipt))
        sink.arrival(event.receipt)
        break
      case 'settlement':
        sink.update((state) => withSettlement(state, event.settlement))
        break
    }
  }
  try {
    await source.stream(handle, current.signal)
  } catch (error) {
    failure ??= error
  } finally {
    signal.removeEventListener('abort', stop)
  }
  return failure
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
