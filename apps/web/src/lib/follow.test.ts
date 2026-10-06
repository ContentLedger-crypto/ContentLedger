import type { PublisherReceipt, ReceiptsPage } from '@contentledger/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type FeedEvent, type FeedSource } from './api'
import { EMPTY_FEED, type FeedState } from './feed'
import { followFeed, type Link, retryDelayMs } from './follow'

const receipt = (n: number): PublisherReceipt => ({
  id: n.toString(16).padStart(64, '0'),
  workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
  sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
  consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
  useType: 'train',
  tariff: 2000n,
  paymentMethod: 'escrow',
  acceptedAt: `2026-10-07T10:00:${n.toString().padStart(2, '0')}.000Z`,
  settledAt: null,
})

interface OpenStream {
  emit(event: FeedEvent): void
  end(): void
  fail(error: unknown): void
}

/** A gateway the test drives by hand: each stream it opens waits for the test to end it. */
function fakeSource(pages: Array<ReceiptsPage | Error> = []) {
  const streams: OpenStream[] = []
  const refusals: unknown[] = []
  const source: FeedSource = {
    receipts: async () => {
      const next = pages.shift() ?? { items: [], nextCursor: null }
      if (next instanceof Error) throw next
      return next
    },
    stream: (onEvent, signal) => {
      const refusal = refusals.shift()
      if (refusal !== undefined) return Promise.reject(refusal)
      return new Promise((resolve, reject) => {
        streams.push({ emit: onEvent, end: resolve, fail: reject })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }
  return { source, streams, refuseNextStream: (error: unknown) => refusals.push(error) }
}

function recordingSink() {
  const seen = {
    state: EMPTY_FEED as FeedState,
    links: [] as Link[],
    arrivals: [] as string[],
    unauthorized: 0,
  }
  return {
    seen,
    sink: {
      update: (change: (state: FeedState) => FeedState) => {
        seen.state = change(seen.state)
      },
      link: (link: Link) => seen.links.push(link),
      arrival: (r: PublisherReceipt) => seen.arrivals.push(r.id),
      unauthorized: () => {
        seen.unauthorized += 1
      },
    },
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('followFeed', () => {
  let controller: AbortController
  beforeEach(() => {
    vi.useFakeTimers()
    controller = new AbortController()
  })
  afterEach(() => {
    controller.abort()
    vi.useRealTimers()
  })

  it('reads the snapshot once the stream is ready, then takes what streams in', async () => {
    const { source, streams } = fakeSource([{ items: [receipt(1)], nextCursor: null }])
    const { sink, seen } = recordingSink()
    void followFeed(source, sink, controller.signal)
    await settle()

    streams[0]?.emit({ type: 'ready' })
    await settle()
    expect(seen.links).toEqual(['live'])
    expect(seen.state.loaded).toBe(true)

    streams[0]?.emit({ type: 'receipt', receipt: receipt(2) })
    expect(seen.state.rows.map((row) => row.id)).toEqual([receipt(2).id, receipt(1).id])
    expect(seen.arrivals).toEqual([receipt(2).id])
  })

  it('reopens the stream after a drop, waiting longer while it keeps dropping', async () => {
    const { source, streams } = fakeSource()
    const { sink, seen } = recordingSink()
    void followFeed(source, sink, controller.signal)
    await settle()

    streams[0]?.fail(new TypeError('network'))
    await settle()
    expect(seen.links).toEqual(['reconnecting'])
    await vi.advanceTimersByTimeAsync(999)
    expect(streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(2)

    streams[1]?.end()
    await vi.advanceTimersByTimeAsync(1999)
    expect(streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(3)
  })

  it('starts the pause over when the stream that dropped had been up for a while', async () => {
    const { source, streams } = fakeSource()
    const { sink } = recordingSink()
    void followFeed(source, sink, controller.signal)
    await settle()
    streams[0]?.end()
    await vi.advanceTimersByTimeAsync(1000)

    await vi.advanceTimersByTimeAsync(61_000)
    streams[1]?.end()
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(3)
  })

  it('ends the attempt when the snapshot cannot be read, and tries again', async () => {
    const { source, streams } = fakeSource([new ApiError(503, null, null)])
    const { sink, seen } = recordingSink()
    void followFeed(source, sink, controller.signal)
    await settle()

    streams[0]?.emit({ type: 'ready' })
    await settle()
    expect(seen.links).toEqual(['reconnecting'])
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]?.emit({ type: 'ready' })
    await settle()
    expect(seen.links).toEqual(['reconnecting', 'live'])
  })

  it('waits as long as a refusal asks', async () => {
    const { source, streams, refuseNextStream } = fakeSource()
    refuseNextStream(new ApiError(429, 'RATE_LIMITED', 7))
    const { sink } = recordingSink()
    void followFeed(source, sink, controller.signal)
    await vi.advanceTimersByTimeAsync(6999)
    expect(streams).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(1)
  })

  it('gives up on a refused session, from the stream or from the snapshot', async () => {
    const fromStream = fakeSource()
    fromStream.refuseNextStream(new ApiError(401, 'UNAUTHORIZED', null))
    const first = recordingSink()
    await followFeed(fromStream.source, first.sink, controller.signal)
    expect(first.seen.unauthorized).toBe(1)

    const fromSnapshot = fakeSource([new ApiError(401, 'UNAUTHORIZED', null)])
    const second = recordingSink()
    const followed = followFeed(fromSnapshot.source, second.sink, controller.signal)
    await settle()
    fromSnapshot.streams[0]?.emit({ type: 'ready' })
    await followed
    expect(second.seen.unauthorized).toBe(1)
    expect(fromSnapshot.streams).toHaveLength(1)
  })

  it('stops for good when aborted', async () => {
    const { source, streams } = fakeSource()
    const { sink, seen } = recordingSink()
    const followed = followFeed(source, sink, controller.signal)
    await settle()
    controller.abort()
    await followed
    await vi.advanceTimersByTimeAsync(60_000)
    expect(streams).toHaveLength(1)
    expect(seen.links).toEqual([])
  })
})

describe('retryDelayMs', () => {
  it('doubles from a second up to half a minute', () => {
    expect([0, 1, 2, 5, 6, 20].map((attempt) => retryDelayMs(attempt, null))).toEqual([
      1000, 2000, 4000, 30_000, 30_000, 30_000,
    ])
  })

  it('waits as long as the gateway asked when that is longer', () => {
    expect(retryDelayMs(0, 12)).toBe(12_000)
    expect(retryDelayMs(5, 2)).toBe(30_000)
  })
})
