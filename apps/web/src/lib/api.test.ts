import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMER_TOTALS, EDGES, receipts, subscribeReceipts, summary } from './api'

const sum = (amounts: readonly bigint[]) => amounts.reduce((total, amount) => total + amount, 0n)

describe('served data', () => {
  it('arrives through the shared contract, money as bigint', () => {
    expect(typeof receipts.items[0]?.tariff).toBe('bigint')
    expect(summary.total).toBe(4_246_900n)
  })

  it('adds up the same however the period is cut', () => {
    expect(sum(summary.byWork.map((work) => work.total))).toBe(summary.total)
    expect(sum(CONSUMER_TOTALS.map((consumer) => consumer.amount))).toBe(summary.total)
    expect(sum(EDGES.map((edge) => edge.amount))).toBe(summary.total)
    expect(CONSUMER_TOTALS.reduce((n, consumer) => n + consumer.requests, 0)).toBe(summary.count)
    expect(EDGES.reduce((n, edge) => n + edge.requests, 0)).toBe(summary.count)
  })

  it('draws every edge between an agent and a work the period knows', () => {
    const agents = new Set(CONSUMER_TOTALS.map((consumer) => consumer.consumer))
    const works = new Set(summary.byWork.map((work) => work.workId))
    for (const edge of EDGES) {
      expect(agents.has(edge.consumer)).toBe(true)
      expect(works.has(edge.workId)).toBe(true)
    }
  })
})

describe('subscribeReceipts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers arrivals one at a time through the contract, then falls silent', () => {
    const seen: bigint[] = []
    subscribeReceipts((receipt) => seen.push(receipt.tariff))

    vi.advanceTimersByTime(3999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([905n])

    vi.runAllTimers()
    expect(seen).toHaveLength(6)
    vi.advanceTimersByTime(60_000)
    expect(seen).toHaveLength(6)
  })

  it('stops delivering once unsubscribed', () => {
    const seen: string[] = []
    const unsubscribe = subscribeReceipts((receipt) => seen.push(receipt.id))
    vi.advanceTimersByTime(4000)
    unsubscribe()
    vi.runAllTimers()
    expect(seen).toHaveLength(1)
  })
})
