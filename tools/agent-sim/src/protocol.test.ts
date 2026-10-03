import { createHash } from 'node:crypto'
import { escrowPda } from '@contentledger/chain'
import {
  chainGenesis,
  chainStep,
  type ReceiptBody,
  receiptId,
  receiptLeaf,
  voucherMessage,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  checkDelivery,
  checkOffer,
  type EscrowOffer,
  type Position,
  parsePaymentRequired,
  signVoucher,
} from './protocol.js'

const agent = Keypair.generate()
const escrow = escrowPda(agent.publicKey)[0]
const CONTENT = Buffer.from('<h1>AI Act, explained</h1>')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const WORK = Keypair.generate().publicKey.toBase58()

const body = (seq: number, overrides: Partial<ReceiptBody> = {}) =>
  ({
    consumer: agent.publicKey.toBase58(),
    work: WORK,
    useType: 'train',
    tariff: '2000',
    fee: '200',
    rateLevel: 'domain',
    servedHash: sha256(CONTENT),
    registryHash: sha256(CONTENT),
    acceptedAt: '2026-10-03T12:00:00.000Z',
    paymentMethod: 'escrow',
    seq,
    ...overrides,
  }) as Extract<ReceiptBody, { paymentMethod: 'escrow' }>

const START: Position = { seq: 0n, cumulative: 0n, chain: chainGenesis(escrow.toBytes()) }

const offer = (overrides: Partial<EscrowOffer> = {}): EscrowOffer => ({
  id: 'offer-1',
  body: body(1),
  cumulativeAfter: 2200n,
  expiresAt: new Date('2026-10-03T12:01:00.000Z'),
  ...overrides,
})

const quote = { work: WORK, useType: 'train' as const, tariff: 2000n, fee: 200n, total: 2200n }

const MINT = 'F2snBajNcBXZ6GheR5LPhMvc9Ai2vG9uGweXrciNM1oF'
const PUBLISHER_ATA = 'EhVTAeisM7wGmDn4KwmVRSE9bXYfEGif39VyYrUypKVA'
const PUBLISHER = '7ddMq1eic5MmuNAvoUzBnFo7epc383GAMyoY1atS7PQZ'
const TREASURY_ATA = 'HM8EYSNJMxvfrpi1FM31BPpCbgd3p2zbEd9K9re4WgwZ'

const x402Method = {
  kind: 'x402',
  mint: MINT,
  legs: [
    { payTo: PUBLISHER_ATA, amount: '2000', owner: PUBLISHER },
    { payTo: TREASURY_ATA, amount: '200' },
  ],
}

const x402 = {
  mint: MINT,
  legs: [
    { payTo: PUBLISHER_ATA, amount: 2000n, owner: PUBLISHER },
    { payTo: TREASURY_ATA, amount: 200n },
  ],
}

/** Exactly what the gateway sends: `paymentRequired` in apps/gateway/src/routes/quote.ts. */
const paymentRequired = (
  escrowMethod: Record<string, unknown>,
  reason?: string,
  methods: Record<string, unknown>[] = [x402Method],
) => ({
  error: {
    code: 'PAYMENT_REQUIRED',
    message: 'this work is licensed per request; pay to receive it',
    details: {
      ...(reason && { reason }),
      work: WORK,
      useType: 'train',
      tariff: '2000',
      fee: '200',
      total: '2200',
      currency: 'USDC',
      decimals: 6,
      rateLevel: 'domain',
      methods: [{ kind: 'escrow', program: 'P', amount: '2200', ...escrowMethod }, ...methods],
    },
  },
})

describe('parsePaymentRequired', () => {
  it('reads the quote and the escrow draft', () => {
    const parsed = parsePaymentRequired(
      paymentRequired({
        offer: {
          id: 'offer-1',
          body: body(1),
          cumulativeAfter: '2200',
          expiresAt: '2026-10-03T12:01:00.000Z',
        },
      }),
    )
    expect(parsed).toEqual({ quote, escrow: { offer: offer() }, x402, reason: undefined })
  })

  it('reads why the escrow path is closed', () => {
    expect(parsePaymentRequired(paymentRequired({ unavailable: 'insufficient-funds' }))).toEqual({
      quote,
      escrow: { unavailable: 'insufficient-funds' },
      x402,
      reason: undefined,
    })
  })

  it('reads that the voucher came for an offer the gateway no longer holds', () => {
    const parsed = parsePaymentRequired(
      paymentRequired({ unavailable: 'consumer-required' }, 'offer-expired'),
    )
    expect(parsed?.reason).toBe('offer-expired')
  })

  it('is null for anything else', () => {
    expect(parsePaymentRequired({ error: { code: 'NOT_FOUND', details: {} } })).toBeNull()
    expect(parsePaymentRequired('<html>')).toBeNull()
  })

  it('reads a 402 without x402, as for a free work, as offering none', () => {
    const parsed = parsePaymentRequired(
      paymentRequired({ unavailable: 'insufficient-funds' }, undefined, []),
    )
    expect(parsed?.x402).toBeNull()
  })

  // The escrow offer stays usable: an x402 method the agent cannot read is one it cannot use.
  it('reads an x402 method it cannot make sense of as none, keeping the escrow offer', () => {
    const unreadable = { kind: 'x402', legs: [{ payTo: 'A', amount: '2000' }] }
    const parsed = parsePaymentRequired(
      paymentRequired({ unavailable: 'insufficient-funds' }, undefined, [unreadable]),
    )
    expect(parsed).toMatchObject({ escrow: { unavailable: 'insufficient-funds' }, x402: null })
    expect(parsePaymentRequired('<html>')).toBeNull()
  })
})

describe('checkOffer', () => {
  const consumer = agent.publicKey.toBase58()

  it('accepts a draft that continues this agent’s own history at the quoted price', () => {
    expect(checkOffer(offer(), quote, START, consumer, 'train')).toBeNull()
  })

  // The agent signs the chain over this body: whatever is wrong in it, it would own.
  it.each([
    ['for another agent', offer({ body: body(1, { consumer: WORK }) }), 'consumer-mismatch'],
    ['out of sequence', offer({ body: body(2) }), 'seq-mismatch'],
    ['for another use', offer({ body: body(1, { useType: 'inference' }) }), 'terms-mismatch'],
    ['for another work', offer({ body: body(1, { work: consumer }) }), 'terms-mismatch'],
    ['at another tariff', offer({ body: body(1, { tariff: '2001' }) }), 'terms-mismatch'],
    ['at another fee', offer({ body: body(1, { fee: '201' }) }), 'terms-mismatch'],
    [
      'with a cumulative it does not add up to',
      offer({ cumulativeAfter: 2201n }),
      'cumulative-mismatch',
    ],
  ] as const)('refuses a draft %s', (_, draft, reason) => {
    expect(checkOffer(draft, quote, START, consumer, 'train')).toBe(reason)
  })

  it('refuses a quote whose total is not tariff plus fee', () => {
    expect(checkOffer(offer(), { ...quote, total: 2100n }, START, consumer, 'train')).toBe(
      'terms-mismatch',
    )
  })
})

describe('signVoucher', () => {
  it('chains over the draft and signs what settle_batch rebuilds', () => {
    const signed = signVoucher(agent, START, offer())
    const chain = chainStep(START.chain, receiptLeaf(body(1)))

    expect(signed.next).toEqual({ seq: 1n, cumulative: 2200n, chain })
    expect(signed.receiptId).toBe(receiptId(body(1)))
    const header = JSON.parse(Buffer.from(signed.header, 'base64url').toString('utf8'))
    expect(header).toEqual({
      escrow: escrow.toBase58(),
      seq: 1,
      cumulative: '2200',
      chain: Buffer.from(chain).toString('hex'),
      sig: header.sig,
    })
    const message = voucherMessage({ escrow: escrow.toBytes(), seq: 1n, cumulative: 2200n, chain })
    expect(
      ed25519.verify(utils.bytes.bs58.decode(header.sig), message, agent.publicKey.toBytes()),
    ).toBe(true)
  })
})

describe('checkDelivery', () => {
  const draft = body(1)
  const id = receiptId(draft)
  const header = (receipt: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(receipt)).toString('base64url')

  it('accepts the bytes the receipt hashed and the receipt that was offered', () => {
    expect(checkDelivery(CONTENT, header({ id, ...draft, hashMatch: true }), draft, id)).toEqual({
      ok: true,
      receipt: { id, ...draft, hashMatch: true },
    })
  })

  // FR-011a: the agent recomputes the hash itself rather than trusting the receipt.
  it('catches bytes that are not the ones the receipt names', () => {
    const outcome = checkDelivery(
      Buffer.from('something else'),
      header({ id, ...draft, hashMatch: true }),
      draft,
      id,
    )
    expect(outcome).toEqual({ ok: false, reason: 'served-hash-mismatch' })
  })

  it('catches a receipt other than the draft it signed', () => {
    const other = body(1, { acceptedAt: '2026-10-03T12:00:01.000Z' })
    const outcome = checkDelivery(
      CONTENT,
      header({ id: receiptId(other), ...other, hashMatch: true }),
      draft,
      id,
    )
    expect(outcome).toEqual({ ok: false, reason: 'receipt-mismatch' })
  })

  it('catches a missing or malformed receipt', () => {
    expect(checkDelivery(CONTENT, undefined, draft, id)).toEqual({
      ok: false,
      reason: 'receipt-missing',
    })
    expect(checkDelivery(CONTENT, 'not json', draft, id)).toEqual({
      ok: false,
      reason: 'receipt-missing',
    })
  })
})
