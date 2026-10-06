import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { clientAddress, tokenBucket } from './rate-limit.js'

describe('tokenBucket', () => {
  const bucket = (clock: { ms: number }, maxKeys = 100) =>
    tokenBucket({ capacity: 3, perSecond: 2, now: () => clock.ms, maxKeys })

  it('lets a burst of its capacity through and refuses the next one', () => {
    const clock = { ms: 0 }
    const limiter = bucket(clock)
    expect([1, 2, 3].map(() => limiter.take('a').ok)).toEqual([true, true, true])
    expect(limiter.take('a')).toEqual({ ok: false, retryAfter: 1 })
  })

  it('refills at its rate, never above its capacity', () => {
    const clock = { ms: 0 }
    const limiter = bucket(clock)
    for (let i = 0; i < 3; i += 1) limiter.take('a')
    clock.ms = 500
    expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
    clock.ms = 3_600_000
    expect([1, 2, 3, 4].map(() => limiter.take('a').ok)).toEqual([true, true, true, false])
  })

  it('names the wait until one whole token is back, rounded up to a second', () => {
    const clock = { ms: 0 }
    const limiter = tokenBucket({ capacity: 1, perSecond: 0.25, now: () => clock.ms })
    limiter.take('a')
    clock.ms = 1_000
    expect(limiter.take('a')).toEqual({ ok: false, retryAfter: 3 })
  })

  it('keeps keys apart', () => {
    const clock = { ms: 0 }
    const limiter = bucket(clock)
    for (let i = 0; i < 3; i += 1) limiter.take('a')
    expect(limiter.take('a').ok).toBe(false)
    expect(limiter.take('b').ok).toBe(true)
  })

  // Memory is bounded by key count, not by how many addresses ever called.
  it('forgets the least recently seen key beyond its key limit', () => {
    const clock = { ms: 0 }
    const limiter = bucket(clock, 2)
    for (let i = 0; i < 3; i += 1) limiter.take('a')
    limiter.take('b')
    limiter.take('c')
    expect(limiter.take('a').ok).toBe(true)
  })

  it('keeps a key it keeps seeing, however many others pass by', () => {
    const clock = { ms: 0 }
    const limiter = bucket(clock, 2)
    for (let i = 0; i < 3; i += 1) limiter.take('a')
    limiter.take('b')
    limiter.take('a')
    limiter.take('c')
    expect(limiter.take('a').ok).toBe(false)
  })
})

describe('clientAddress', () => {
  const SOCKET = '10.0.0.9'
  const addressOf = async (trustedHops: number, forwardedFor?: string) => {
    const app = new Hono().get('/', (c) => c.text(clientAddress(trustedHops, () => SOCKET)(c)))
    const headers: Record<string, string> = forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}
    return (await app.request('/', { headers })).text()
  }

  // Without a trusted proxy in front, the header is whatever the client chose to send.
  it('takes the socket and ignores X-Forwarded-For when no proxy is trusted', async () => {
    expect(await addressOf(0, '203.0.113.7')).toBe(SOCKET)
  })

  it('takes the entry the trusted proxy appended, not the ones the client wrote', async () => {
    expect(await addressOf(1, '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
  })

  it('counts trusted hops from the right', async () => {
    expect(await addressOf(2, '6.6.6.6,203.0.113.7 , 198.51.100.2')).toBe('203.0.113.7')
  })

  it('falls back to the socket when the header is shorter than the trusted chain', async () => {
    expect(await addressOf(2, '203.0.113.7')).toBe(SOCKET)
    expect(await addressOf(1)).toBe(SOCKET)
  })
})
