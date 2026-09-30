import {
  associatedTokenAddress,
  type Config,
  type Domain,
  domainPda,
  PROGRAM_ID,
  type Work,
  workPda,
} from '@contentledger/chain'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type { RegistryReader, RegistrySnapshot } from '../registry.js'
import type { EscrowReceiptBody } from '../voucher.js'
import { paymentRequired, quoteFor, quoteRoutes, x402Legs } from './quote.js'

const MINT = 'F2snBajNcBXZ6GheR5LPhMvc9Ai2vG9uGweXrciNM1oF'
const TREASURY_ATA = 'HM8EYSNJMxvfrpi1FM31BPpCbgd3p2zbEd9K9re4WgwZ'
const OWNER = '7ddMq1eic5MmuNAvoUzBnFo7epc383GAMyoY1atS7PQZ'
const SEPARATE_PAYOUT = 'FKoKPEnGHQsawTzHpWCvWj1WxAtwFCbZqZEWV4D3JoLM'
const SOURCE = 'https://acme-news.test/2026/ai-act-explained.html'

const ataOf = (owner: string) =>
  associatedTokenAddress(new PublicKey(owner), new PublicKey(MINT)).toBase58()

const config: Config = {
  authority: '2nfDE4vfx7aBkjucAJzo7tegmkbMzJ52ambqoguHkgsm',
  treasuryAta: TREASURY_ATA,
  mint: MINT,
  protocolFeeBps: 1000,
  nodeShareBps: 0,
  voucherGraceS: 900n,
  paused: false,
  bump: 255,
}

const domainAddress = domainPda('acme-news.test')[0].toBase58()

const domain = (overrides: Partial<Domain> = {}): Domain => ({
  owner: OWNER,
  payoutOwner: OWNER,
  host: 'acme-news.test',
  rateTrain: 2000n,
  rateInference: 500n,
  status: 'active',
  bump: 254,
  ...overrides,
})

const work = (overrides: Partial<Work> = {}): Work => ({
  domain: domainAddress,
  sourceHash: '11'.repeat(32),
  contentHash: '22'.repeat(32),
  rateTrain: null,
  rateInference: null,
  status: 'active',
  attestedBy: 0,
  bump: 253,
  ...overrides,
})

const snapshot = (
  parts: { domain?: Domain | null; work?: Work | null; config?: Config } = {},
): RegistrySnapshot => {
  const d = parts.domain === undefined ? domain() : parts.domain
  const w = parts.work === undefined ? work() : parts.work
  return {
    config: parts.config ?? config,
    domain: d === null ? null : { address: domainAddress, account: d },
    work: w === null ? null : { address: workPda(SOURCE)[0].toBase58(), account: w },
  }
}

const quoted = (outcome: ReturnType<typeof quoteFor>) => {
  if (outcome.kind !== 'quoted') throw new Error(`expected a quote, got ${outcome.kind}`)
  return outcome.quote
}

describe('quoteFor', () => {
  it('prices a work at its domain rate and names tariff and fee separately', () => {
    const quote = quoted(quoteFor(snapshot(), 'train'))
    expect(quote).toMatchObject({
      work: workPda(SOURCE)[0].toBase58(),
      useType: 'train',
      tariff: 2000n,
      fee: 200n,
      total: 2200n,
      rateLevel: 'domain',
      recipient: OWNER,
      verified: false,
    })
  })

  it('takes the work override and records that level', () => {
    const quote = quoted(quoteFor(snapshot({ work: work({ rateTrain: 9000n }) }), 'train'))
    expect(quote).toMatchObject({ tariff: 9000n, fee: 900n, total: 9900n, rateLevel: 'work' })
  })

  it('rounds the fee up on a tariff that does not divide evenly', () => {
    const quote = quoted(quoteFor(snapshot({ domain: domain({ rateInference: 1n }) }), 'inference'))
    expect(quote).toMatchObject({ tariff: 1n, fee: 1n, total: 2n })
  })

  it('pays the payout wallet, not the owner, when they differ', () => {
    const quote = quoted(
      quoteFor(snapshot({ domain: domain({ payoutOwner: SEPARATE_PAYOUT }) }), 'train'),
    )
    expect(quote.recipient).toBe(SEPARATE_PAYOUT)
    expect(x402Legs(quote)).toEqual([
      { destination: 'H4g3tncAE1YGyHAwCB16SGxghVPK4etZgUE3K3e7tH2b', amount: 2000n },
      { destination: TREASURY_ATA, amount: 200n },
    ])
  })

  it('marks a work verified once an attestor has attested it', () => {
    const quote = quoted(quoteFor(snapshot({ work: work({ attestedBy: 1 }) }), 'train'))
    expect(quote.verified).toBe(true)
  })

  it.each([
    ['domain-suspended', { domain: domain({ status: 'suspended' }) }],
    ['work-suspended', { work: work({ status: 'suspended' }) }],
  ] as const)('refuses to price a %s work', (reason, parts) => {
    expect(quoteFor(snapshot(parts), 'train')).toEqual({ kind: 'unlicensed', reason })
  })

  it.each([
    ['work-missing', { work: null }],
    ['domain-missing', { domain: null }],
    ['work-under-other-domain', { work: work({ domain: PROGRAM_ID.toBase58() }) }],
  ] as const)('treats %s as unregistered', (reason, parts) => {
    expect(quoteFor(snapshot(parts), 'train')).toEqual({ kind: 'unregistered', reason })
  })

  it('refuses to quote while the node share is non-zero', () => {
    expect(() => quoteFor(snapshot({ config: { ...config, nodeShareBps: 500 } }), 'train')).toThrow(
      /node share/,
    )
  })
})

describe('paymentRequired', () => {
  it('offers both methods with tariff and fee as separate amounts', () => {
    const quote = quoted(quoteFor(snapshot(), 'train'))
    expect(paymentRequired(quote, { unavailable: 'consumer-required' })).toEqual({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: expect.any(String),
        details: {
          work: workPda(SOURCE)[0].toBase58(),
          useType: 'train',
          tariff: '2000',
          fee: '200',
          total: '2200',
          currency: 'USDC',
          decimals: 6,
          rateLevel: 'domain',
          methods: [
            {
              kind: 'escrow',
              program: PROGRAM_ID.toBase58(),
              amount: '2200',
              unavailable: 'consumer-required',
            },
            {
              kind: 'x402',
              legs: [
                { payTo: ataOf(OWNER), amount: '2000' },
                { payTo: TREASURY_ATA, amount: '200' },
              ],
            },
          ],
        },
      },
    })
  })

  it('offers only a zero escrow voucher for a free work, so the issuance still gets a receipt', () => {
    const quote = quoted(quoteFor(snapshot({ domain: domain({ rateTrain: 0n }) }), 'train'))
    expect(x402Legs(quote)).toEqual([])
    expect(
      paymentRequired(quote, { unavailable: 'consumer-required' }).error.details,
    ).toMatchObject({
      tariff: '0',
      fee: '0',
      total: '0',
      methods: [{ kind: 'escrow', program: PROGRAM_ID.toBase58(), amount: '0' }],
    })
  })

  it('carries the draft to sign, with money as strings and the expiry as ISO time', () => {
    const quote = quoted(quoteFor(snapshot(), 'train'))
    const body = { seq: 3 } as unknown as EscrowReceiptBody
    const details = paymentRequired(
      quote,
      {
        offer: {
          id: 'offer-id',
          body,
          cumulativeAfter: 6600n,
          expiresAt: new Date('2026-09-30T10:01:00.000Z'),
        },
      },
      'offer-expired',
    ).error.details
    expect(details.reason).toBe('offer-expired')
    expect(details.methods[0]).toEqual({
      kind: 'escrow',
      program: PROGRAM_ID.toBase58(),
      amount: '2200',
      offer: {
        id: 'offer-id',
        body,
        cumulativeAfter: '6600',
        expiresAt: '2026-09-30T10:01:00.000Z',
      },
    })
  })

  it('drops a zero fee leg instead of asking for an empty transfer', () => {
    const free = { ...config, protocolFeeBps: 0 }
    const quote = quoted(quoteFor(snapshot({ config: free }), 'train'))
    expect(x402Legs(quote)).toEqual([{ destination: ataOf(OWNER), amount: 2000n }])
  })
})

describe('GET /v1/quote', () => {
  const reader = (result: RegistrySnapshot | Error) => {
    const calls: string[] = []
    const registry: RegistryReader = {
      read: async (source) => {
        calls.push(source)
        if (result instanceof Error) throw result
        return result
      },
    }
    return { calls, app: createApp(quoteRoutes(registry)) }
  }
  const url = (source: string, use = 'train') =>
    `/v1/quote?source=${encodeURIComponent(source)}&use=${use}`

  it('returns the quote with amounts as base-unit strings', async () => {
    const { app } = reader(snapshot())
    const res = await app.request(url(SOURCE))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      work: workPda(SOURCE)[0].toBase58(),
      useType: 'train',
      tariff: '2000',
      fee: '200',
      total: '2200',
      currency: 'USDC',
      decimals: 6,
      rateLevel: 'domain',
      recipient: OWNER,
      escrowProgram: PROGRAM_ID.toBase58(),
      verified: false,
    })
  })

  it.each([
    ['an unknown use type', url(SOURCE, 'scrape')],
    ['a missing use type', `/v1/quote?source=${encodeURIComponent(SOURCE)}`],
    ['a missing source', '/v1/quote?use=train'],
    ['a non-https source', url('http://acme-news.test/2026/ai-act-explained.html')],
    ['a source with a port', url('https://acme-news.test:443/2026/ai-act-explained.html')],
    ['a source with an upper-case host', url('https://Acme-News.test/2026/ai-act-explained.html')],
  ])('rejects %s without touching the registry', async (_, path) => {
    const { app, calls } = reader(snapshot())
    const res = await app.request(path)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(calls).toEqual([])
  })

  it('answers 404 for an unregistered work', async () => {
    const { app } = reader(snapshot({ work: null }))
    const res = await app.request(url(SOURCE))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: 'NOT_FOUND', details: { reason: 'work-missing' } },
    })
  })

  it('answers 403 for a work whose licence is withdrawn', async () => {
    const { app } = reader(snapshot({ domain: domain({ status: 'suspended' }) }))
    const res = await app.request(url(SOURCE))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: 'NOT_LICENSED', details: { reason: 'domain-suspended' } },
    })
  })

  it('answers 500 without leaking the cause when the registry is unreachable', async () => {
    const { app } = reader(
      new Error('429 Too Many Requests from https://rpc.example/?api-key=secret'),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request(url(SOURCE))
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'INTERNAL' } })
    expect(body).not.toContain('secret')
    const line = String(logged.mock.calls[0]?.[0])
    expect(line).toContain('429 Too Many Requests')
    expect(line).toContain('api-key=***')
    expect(line).not.toContain('secret')
    logged.mockRestore()
  })
})
