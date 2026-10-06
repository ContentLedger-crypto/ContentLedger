import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  authApiFor,
  CONSUMER_TOTALS,
  dataModeOf,
  EDGES,
  receipts,
  subscribeReceipts,
  summary,
} from './api'

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

describe('dataModeOf', () => {
  it('reads the gateway through the dev server’s proxy when nothing is set in development', () => {
    expect(dataModeOf({ DEV: true, VITE_API_URL: '' })).toEqual({ kind: 'gateway', apiUrl: '' })
  })

  it('shows the preview when a production build names no gateway', () => {
    expect(dataModeOf({ DEV: false })).toEqual({ kind: 'preview' })
    expect(dataModeOf({ DEV: false, VITE_API_URL: '  ' })).toEqual({ kind: 'preview' })
  })

  it('reads the named gateway', () => {
    expect(dataModeOf({ DEV: false, VITE_API_URL: 'https://gw.example:8443' })).toEqual({
      kind: 'gateway',
      apiUrl: 'https://gw.example:8443',
    })
  })

  it.each(['https://gw.example/', 'https://gw.example/api', 'gw.example'])(
    'refuses %s, which is not an origin',
    (url) => {
      expect(() => dataModeOf({ DEV: false, VITE_API_URL: url })).toThrow(/VITE_API_URL/)
    },
  )
})

describe('authApiFor', () => {
  const challenge = {
    input: {
      domain: 'localhost:5173',
      address: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
      statement: 'Sign in to the ContentLedger publisher dashboard.',
      uri: 'http://localhost:5173',
      version: '1',
      chainId: 'solana:devnet',
      nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      issuedAt: '2026-10-07T12:00:00.000Z',
      expirationTime: '2026-10-07T12:05:00.000Z',
    },
    message: 'text',
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })

  it('posts JSON to the gateway and reads the answer through the shared contract', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, challenge))
    const api = authApiFor('https://gw.example', fetcher)

    expect(await api.challenge(challenge.input.address)).toEqual(challenge)
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://gw.example/v1/auth/challenge')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ wallet: challenge.input.address })
  })

  it('carries the refusal code, and the wait the gateway asks for', async () => {
    const refusing = authApiFor('', async () =>
      json(429, { error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfter: 9 } } }),
    )
    await expect(refusing.verify({ wallet: 'w', nonce: 'n', signature: 's' })).rejects.toEqual(
      new ApiError(429, 'RATE_LIMITED', 9),
    )
  })

  it('names the status when the refusal has no body it recognises', async () => {
    const api = authApiFor('', async () => new Response('Bad Gateway', { status: 502 }))
    await expect(api.challenge('w')).rejects.toEqual(new ApiError(502, null, null))
  })

  it('rejects an answer that breaks the contract instead of trusting it', async () => {
    const api = authApiFor('', async () => json(200, { token: 'short', expiresAt: 'soon' }))
    await expect(api.verify({ wallet: 'w', nonce: 'n', signature: 's' })).rejects.toThrow()
  })
})
