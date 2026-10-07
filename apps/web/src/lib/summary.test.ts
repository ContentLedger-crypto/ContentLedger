import type { PublisherSummary } from '@contentledger/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type FeedEvent, type PublisherSource } from './api'
import type { Link } from './follow'
import {
  followSummary,
  type Period,
  periodLabel,
  periodWindow,
  SUMMARY_REFRESH_MS,
} from './summary'

const NOW = new Date('2026-10-07T09:30:00.000Z')

describe('periodWindow', () => {
  it.each<[Period, string]>([
    ['7d', '2026-09-30T09:30:00.000Z'],
    ['30d', '2026-09-07T09:30:00.000Z'],
    ['12m', '2025-10-07T09:30:00.000Z'],
  ])('ends now and reaches back %s', (period, from) => {
    expect(periodWindow(period, NOW)).toEqual({ from: new Date(from), to: NOW })
  })

  it('keeps twelve months from a leap day inside the 366 days the gateway allows', () => {
    const leapDay = new Date('2028-02-29T12:00:00.000Z')
    const { from, to } = periodWindow('12m', leapDay)
    expect(Number(to) - Number(from)).toBeLessThanOrEqual(366 * 24 * 60 * 60_000)
    expect(from < to).toBe(true)
  })
})

describe('periodLabel', () => {
  it.each([
    ['2026-10-01T00:00:00Z', '2026-10-07T09:30:00Z', '1 – 7 October 2026'],
    ['2026-09-30T09:30:00Z', '2026-10-07T09:30:00Z', '30 September – 7 October 2026'],
    ['2025-10-07T09:30:00Z', '2026-10-07T09:30:00Z', '7 October 2025 – 7 October 2026'],
  ])('names %s to %s by UTC day', (from, to, label) => {
    expect(periodLabel({ from: new Date(from), to: new Date(to) })).toBe(label)
  })
})

const summaryOf = (count: number): PublisherSummary => ({
  total: BigInt(count) * 1000n,
  fee: BigInt(count) * 100n,
  count,
  byWork: [],
  byConsumer: [],
  flows: [],
  settlement: { inBatch: 0n, accrued: BigInt(count) * 1000n, perRequest: 0n },
  registeredWorks: 1,
})

/** A gateway driven by hand: the stream stays open, each summary read waits to be answered. */
function fakeSource() {
  let emit: (event: FeedEvent) => void = () => {}
  const reads: Array<{
    from: Date
    to: Date
    answer(summary: PublisherSummary): void
    refuse(error: unknown): void
  }> = []
  let streams = 0
  const source: PublisherSource = {
    receipts: async () => ({ items: [], nextCursor: null }),
    stream: (onEvent, signal) => {
      streams += 1
      emit = onEvent
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    },
    summary: ({ from, to }) =>
      new Promise((answer, refuse) => {
        reads.push({ from, to, answer, refuse })
      }),
  }
  return {
    source,
    reads,
    emit: (event: FeedEvent) => emit(event),
    streams: () => streams,
  }
}

const anyReceipt = (): FeedEvent => ({
  type: 'receipt',
  receipt: {
    id: '0'.repeat(64),
    workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
    sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
    consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
    useType: 'train',
    tariff: 2000n,
    paymentMethod: 'escrow',
    acceptedAt: '2026-10-07T09:30:00.000Z',
    settledAt: null,
  },
})

function recordingSink() {
  const shown: number[] = []
  const links: Link[] = []
  let unauthorized = 0
  return {
    sink: {
      summary: (summary: PublisherSummary) => shown.push(summary.count),
      link: (link: Link) => links.push(link),
      unauthorized: () => {
        unauthorized += 1
      },
    },
    shown,
    links,
    unauthorized: () => unauthorized,
  }
}

describe('followSummary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the period ending now once the stream is ready, then shows it live', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    void followSummary(gateway.source, '7d', seen.sink, new AbortController().signal)

    gateway.emit({ type: 'ready' })
    expect(gateway.reads).toHaveLength(1)
    expect(gateway.reads[0]).toMatchObject(periodWindow('7d', NOW))

    gateway.reads[0]?.answer(summaryOf(3))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.shown).toEqual([3])
    expect(seen.links).toEqual(['live'])
  })

  it('folds a burst of arrivals into one read, no sooner than the refresh interval', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    void followSummary(gateway.source, '7d', seen.sink, new AbortController().signal)
    gateway.emit({ type: 'ready' })
    gateway.reads[0]?.answer(summaryOf(1))
    await vi.advanceTimersByTimeAsync(0)

    for (let i = 0; i < 5; i += 1) gateway.emit(anyReceipt())
    gateway.emit({
      type: 'settlement',
      settlement: { batchId: 'a'.repeat(64), settledAt: NOW.toISOString(), receiptIds: [] },
    })
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS - 1)
    expect(gateway.reads).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(gateway.reads).toHaveLength(2)
    expect(gateway.reads[1]?.to).toEqual(new Date(Number(NOW) + SUMMARY_REFRESH_MS))
  })

  it('reads again at once after a resync, whatever is pending', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    void followSummary(gateway.source, '30d', seen.sink, new AbortController().signal)
    gateway.emit({ type: 'ready' })
    gateway.emit(anyReceipt())

    gateway.emit({ type: 'resync' })
    expect(gateway.reads).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 2)
    expect(gateway.reads).toHaveLength(2)
  })

  it('never shows an older read over a newer one that answered first', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    void followSummary(gateway.source, '7d', seen.sink, new AbortController().signal)
    gateway.emit({ type: 'ready' })
    gateway.emit({ type: 'resync' })

    gateway.reads[1]?.answer(summaryOf(2))
    gateway.reads[0]?.answer(summaryOf(1))
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.shown).toEqual([2])
  })

  it('treats a failed read like a dropped stream: opens a new one after a pause', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    void followSummary(gateway.source, '7d', seen.sink, new AbortController().signal)
    gateway.emit({ type: 'ready' })

    gateway.reads[0]?.refuse(new ApiError(429, 'RATE_LIMITED', 5))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.links).toEqual(['reconnecting'])

    await vi.advanceTimersByTimeAsync(4999)
    expect(gateway.streams()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gateway.streams()).toBe(2)
  })

  it('stops for good when the gateway refuses the session', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    const done = followSummary(gateway.source, '7d', seen.sink, new AbortController().signal)
    gateway.emit({ type: 'ready' })

    gateway.reads[0]?.refuse(new ApiError(401, 'UNAUTHORIZED', null))
    await done

    expect(seen.unauthorized()).toBe(1)
    expect(gateway.streams()).toBe(1)
  })

  it('drops a pending read when stopped', async () => {
    const gateway = fakeSource()
    const seen = recordingSink()
    const stop = new AbortController()
    const done = followSummary(gateway.source, '7d', seen.sink, stop.signal)
    gateway.emit({ type: 'ready' })
    gateway.emit(anyReceipt())

    stop.abort()
    await done
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS * 2)

    expect(gateway.reads).toHaveLength(1)
  })
})
