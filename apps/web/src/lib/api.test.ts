import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  authApiFor,
  CONSUMER_TOTALS,
  dataModeOf,
  EDGES,
  type FeedEvent,
  publisherApiFor,
  sampleFeed,
  summary,
} from './api'

const sum = (amounts: readonly bigint[]) => amounts.reduce((total, amount) => total + amount, 0n)

describe('served data', () => {
  it('arrives through the shared contract, money as bigint', async () => {
    const page = await sampleFeed.receipts(null, new AbortController().signal)
    expect(typeof page.items[0]?.tariff).toBe('bigint')
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

describe('sampleFeed.stream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is ready at once, delivers arrivals one at a time, then falls silent', () => {
    const seen: string[] = []
    void sampleFeed.stream(
      (event) => seen.push(event.type === 'receipt' ? event.receipt.tariff.toString() : event.type),
      new AbortController().signal,
    )
    expect(seen).toEqual(['ready'])

    vi.advanceTimersByTime(3999)
    expect(seen).toEqual(['ready'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['ready', '905'])

    vi.runAllTimers()
    expect(seen).toHaveLength(7)
    vi.advanceTimersByTime(60_000)
    expect(seen).toHaveLength(7)
  })

  it('stops delivering once aborted, and ends with the abort', async () => {
    const seen: FeedEvent[] = []
    const controller = new AbortController()
    const ended = sampleFeed.stream((event) => seen.push(event), controller.signal)
    vi.advanceTimersByTime(4000)
    controller.abort()
    vi.runAllTimers()
    expect(seen).toHaveLength(2)
    await expect(ended).rejects.toThrow()
  })
})

describe('publisherApiFor', () => {
  const wireReceipt = {
    id: 'bd4fc50240c281804fab6e470b98483e4b1c6d73e228c13474a81485128e127b',
    workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
    sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
    consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
    useType: 'inference',
    tariff: '905',
    paymentMethod: 'x402',
    acceptedAt: '2026-10-07T10:00:02.000Z',
    settledAt: '2026-10-07T10:00:00.000Z',
  }
  const signal = new AbortController().signal

  const sse = (text: string, status = 200) =>
    new Response(new TextEncoder().encode(text), {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    })

  it('reads a page with the session token, passing the cursor it was handed', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [wireReceipt], nextCursor: null })),
    )
    const api = publisherApiFor('https://gw.example', 'tok', fetcher)

    const page = await api.receipts('2026-10-07T10:00:02.000Z_ab+c', signal)
    expect(page.items[0]?.tariff).toBe(905n)
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe(
      'https://gw.example/v1/publisher/receipts?cursor=2026-10-07T10%3A00%3A02.000Z_ab%2Bc',
    )
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
    expect(init?.signal).toBe(signal)
  })

  it('asks for the first page without a cursor', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [], nextCursor: null })),
    )
    await publisherApiFor('', 'tok', fetcher).receipts(null, signal)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/v1/publisher/receipts')
  })

  it('carries a refused session as a 401', async () => {
    const api = publisherApiFor(
      '',
      'tok',
      async () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'x' } }), {
          status: 401,
        }),
    )
    await expect(api.receipts(null, signal)).rejects.toEqual(
      new ApiError(401, 'UNAUTHORIZED', null),
    )
    await expect(api.stream(() => {}, signal)).rejects.toEqual(
      new ApiError(401, 'UNAUTHORIZED', null),
    )
  })

  it('turns the stream into events through the shared contract, skipping unknown ones', async () => {
    const settlement = {
      batchId: 'a'.repeat(64),
      settledAt: '2026-10-07T10:05:00.000Z',
      receiptIds: [wireReceipt.id],
    }
    const fetcher = vi.fn<typeof fetch>(async () =>
      sse(
        [
          'event: ready\ndata: {}\n\n',
          ': ping\n\n',
          `event: receipt\ndata: ${JSON.stringify(wireReceipt)}\n\n`,
          'event: later\ndata: {}\n\n',
          `event: settlement\ndata: ${JSON.stringify(settlement)}\n\n`,
          'event: resync\ndata: {}\n\n',
        ].join(''),
      ),
    )
    const events: FeedEvent[] = []

    await publisherApiFor('', 'tok', fetcher).stream((event) => events.push(event), signal)

    expect(events.map((event) => event.type)).toEqual(['ready', 'receipt', 'settlement', 'resync'])
    expect(events[1]).toMatchObject({ receipt: { tariff: 905n, paymentMethod: 'x402' } })
    expect(events[2]).toEqual({ type: 'settlement', settlement })
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('/v1/publisher/stream')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('ends with an error when an event breaks the contract', async () => {
    const api = publisherApiFor('', 'tok', async () =>
      sse('event: receipt\ndata: {"id":"short"}\n\n'),
    )
    await expect(api.stream(() => {}, signal)).rejects.toThrow()
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
