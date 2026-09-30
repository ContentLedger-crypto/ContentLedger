import { describe, expect, it } from 'vitest'
import { type Offer, offerStore } from './offers.js'
import type { EscrowReceiptBody } from './voucher.js'

const body = { seq: 1 } as unknown as EscrowReceiptBody

const offer = (bytes: number): Omit<Offer, 'id' | 'expiresAt'> => ({
  source: 'https://acme-news.test/a.html',
  body,
  content: new Uint8Array(bytes),
  mediaType: 'text/html',
  cumulativeAfter: 2200n,
})

const clock = (start: number) => {
  let now = start
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) }
}

describe('offerStore', () => {
  it('keeps an offer until its TTL runs out', () => {
    const time = clock(1_790_000_000_000)
    const offers = offerStore({ ttlMs: 60_000, maxBytes: 1_000, now: time.now })
    const stored = offers.put(offer(10))

    expect(stored.expiresAt).toEqual(new Date(1_790_000_060_000))
    time.advance(59_999)
    expect(offers.get(stored.id)).toEqual(stored)
    time.advance(1)
    expect(offers.get(stored.id)).toBeNull()
  })

  it('hands out unguessable ids, one per offer', () => {
    const offers = offerStore({ ttlMs: 60_000, maxBytes: 1_000, now: () => new Date() })
    const a = offers.put(offer(1))
    const b = offers.put(offer(1))
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.id).not.toBe(b.id)
  })

  it('forgets a taken offer', () => {
    const offers = offerStore({ ttlMs: 60_000, maxBytes: 1_000, now: () => new Date() })
    const stored = offers.put(offer(10))
    offers.delete(stored.id)
    expect(offers.get(stored.id)).toBeNull()
  })

  it('evicts the oldest offers once the held bytes exceed the ceiling', () => {
    const offers = offerStore({ ttlMs: 60_000, maxBytes: 100, now: () => new Date() })
    const first = offers.put(offer(40))
    const second = offers.put(offer(40))
    const third = offers.put(offer(40))

    expect(offers.get(first.id)).toBeNull()
    expect(offers.get(second.id)).not.toBeNull()
    expect(offers.get(third.id)).not.toBeNull()
  })

  it('returns null for an id it never issued', () => {
    const offers = offerStore({ ttlMs: 60_000, maxBytes: 100, now: () => new Date() })
    expect(offers.get('nope')).toBeNull()
  })
})
