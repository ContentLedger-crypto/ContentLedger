import { createHash } from 'node:crypto'
import { escrowPda, verifyX402Payment, type X402Rejection } from '@contentledger/chain'
import type { ReceiptBody, UseType } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { apiError } from '../errors.js'
import { checkFunds } from '../escrow.js'
import type { Offer, OfferStore } from '../offers.js'
import type { ContentOrigin } from '../origin.js'
import type { PaymentReader } from '../payments.js'
import type { RateLimiter } from '../rate-limit.js'
import type { PaidRegistryReader, RegistrySnapshot, SlottedRegistrySnapshot } from '../registry.js'
import {
  type Database,
  loadPosition,
  type RegistryMirror,
  recordEscrowIssuance,
  recordX402Issuance,
  type X402ReceiptBody,
} from '../store.js'
import {
  type EscrowReceiptBody,
  type PresentedVoucher,
  parseVoucherHeader,
  verifyVoucher,
} from '../voucher.js'
import { paymentRequired, type Quote, quoteFor, quoteQuery, x402Legs } from './quote.js'

export interface ContentDeps {
  registry: PaidRegistryReader
  db: Database
  origin: ContentOrigin
  offers: OfferStore
  payments: PaymentReader
  now: () => Date
  limits: ContentLimits
}

export interface ContentLimits {
  addressOf: (c: Context) => string
  /** Every request, by client address. */
  requests: RateLimiter
  /** Drafts that fetch from the corpus before anything is paid, by address and escrow. */
  drafts: RateLimiter
}

const CONSUMER = 'X-ContentLedger-Consumer'
const VOUCHER = 'X-ContentLedger-Voucher'
const OFFER = 'X-ContentLedger-Offer'
const RECEIPT = 'X-ContentLedger-Receipt'
const PAYMENT = 'X-ContentLedger-Payment'
const PAYMENT_PROOF = 'X-ContentLedger-Payment-Proof'

const consumerKey = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .transform((value, ctx) => {
    try {
      return new PublicKey(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a 32-byte public key' })
      return z.NEVER
    }
  })

const signatureBytes = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
  .refine((value) => utils.bytes.bs58.decode(value).length === 64)

const x402Payment = z.object({
  signature: signatureBytes,
  proof: signatureBytes.transform((value) => utils.bytes.bs58.decode(value)),
})

const X402_REJECTIONS: Record<X402Rejection, string> = {
  not_found: 'payment-not-found',
  failed: 'payment-failed',
  signature_mismatch: 'signature-mismatch',
  ambiguous_payer: 'ambiguous-payer',
  leg_mismatch: 'leg-mismatch',
  proof_invalid: 'proof-invalid',
}

// 400, never 402: a stock x402 client answers a 402 by paying, and this payment has
// already been made.
const paymentRejected = (c: Context, reason: string) =>
  c.json(apiError('INVALID_INPUT', 'payment rejected', { reason }), 400)

function tooMany(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json(apiError('RATE_LIMITED', 'too many requests', { retryAfter }), 429)
}

type Refusal = { status: 403 | 404; body: ReturnType<typeof apiError> }

function refusal(snapshot: RegistrySnapshot, use: UseType): { quote: Quote } | Refusal {
  const outcome = quoteFor(snapshot, use)
  switch (outcome.kind) {
    case 'unregistered':
      return {
        status: 404,
        body: apiError('NOT_FOUND', 'work is not registered', { reason: outcome.reason }),
      }
    case 'unlicensed':
      return {
        status: 403,
        body: apiError('NOT_LICENSED', 'the owner has withdrawn this licence', {
          reason: outcome.reason,
        }),
      }
    case 'quoted':
      return { quote: outcome.quote }
  }
}

export function contentRoutes(deps: ContentDeps): Hono {
  const { registry, db, origin, offers, payments, now, limits } = deps
  const app = new Hono()

  app.get('/v1/content', async (c) => {
    const allowed = limits.requests.take(limits.addressOf(c))
    if (!allowed.ok) return tooMany(c, allowed.retryAfter)

    const query = quoteQuery.safeParse(c.req.query())
    if (!query.success) {
      return c.json(
        apiError('INVALID_INPUT', 'invalid content request', {
          issues: z.flattenError(query.error),
        }),
        400,
      )
    }
    const { source, use } = query.data

    const consumerHeader = c.req.header(CONSUMER)
    const consumer = consumerHeader === undefined ? null : consumerKey.safeParse(consumerHeader)
    if (consumer !== null && !consumer.success) {
      return c.json(apiError('INVALID_INPUT', `${CONSUMER} is not a public key`, {}), 400)
    }
    const payer = consumer?.data ?? null

    const voucherHeader = c.req.header(VOUCHER)
    const paymentHeader = c.req.header(PAYMENT)
    if (paymentHeader !== undefined) {
      if (voucherHeader !== undefined) return paymentRejected(c, 'two-payment-methods')
      const payment = x402Payment.safeParse({
        signature: paymentHeader,
        proof: c.req.header(PAYMENT_PROOF),
      })
      if (!payment.success) return paymentRejected(c, 'malformed-payment')
      return redeem(c, source, use, payer, payment.data)
    }
    if (voucherHeader === undefined) return offer(c, source, use, payer)

    const voucher = parseVoucherHeader(voucherHeader)
    if (voucher === null) {
      return c.json(
        apiError('INVALID_INPUT', 'voucher rejected', { reason: 'malformed-voucher' }),
        400,
      )
    }
    const held = offers.get(c.req.header(OFFER) ?? '')
    if (held === null || held.source !== source || held.body.useType !== use) {
      // The voucher is dropped unrecorded, so its seq stays free for the fresh draft.
      return offer(c, source, use, payer, 'offer-expired')
    }
    return settle(c, source, use, voucher, held)
  })

  async function offer(
    c: Context,
    source: string,
    use: UseType,
    payer: PublicKey | null,
    reason?: 'offer-expired',
  ) {
    if (payer === null) {
      const verdict = refusal(await registry.read(source), use)
      if ('status' in verdict) return c.json(verdict.body, verdict.status)
      return c.json(
        paymentRequired(verdict.quote, { unavailable: 'consumer-required' }, reason),
        402,
      )
    }

    const snapshot = await registry.readWithEscrow(source, escrowPda(payer)[0])
    const verdict = refusal(snapshot, use)
    if ('status' in verdict) return c.json(verdict.body, verdict.status)
    const { quote } = verdict

    const position = snapshot.escrow && (await loadPosition(db, snapshot.escrow))
    // Checked before the corpus is touched: a draft costs a fetch, and a payer who cannot
    // pay must not be able to make the gateway do that work.
    const funds = checkFunds(snapshot.escrow, (position?.cumulative ?? 0n) + quote.total)
    if (!funds.ok || !position) {
      const unavailable = funds.ok ? 'escrow-missing' : funds.reason
      return c.json(paymentRequired(quote, { unavailable }, reason), 402)
    }

    const allowed = limits.drafts.take(`${limits.addressOf(c)} ${payer.toBase58()}`)
    if (!allowed.ok) return tooMany(c, allowed.retryAfter)

    const served = await origin.fetch(source)
    const body: EscrowReceiptBody = {
      consumer: payer.toBase58(),
      work: quote.work,
      useType: use,
      tariff: quote.tariff.toString(),
      fee: quote.fee.toString(),
      rateLevel: quote.rateLevel,
      servedHash: sha256Hex(served.bytes),
      registryHash: registeredWork(snapshot).account.contentHash,
      acceptedAt: now().toISOString(),
      paymentMethod: 'escrow',
      seq: Number(position.seq + 1n),
    }
    const stored = offers.put({
      source,
      body,
      content: served.bytes,
      mediaType: served.mediaType,
      cumulativeAfter: position.cumulative + quote.total,
    })
    return c.json(paymentRequired(quote, { offer: stored }, reason), 402)
  }

  async function settle(
    c: Context,
    source: string,
    use: UseType,
    voucher: PresentedVoucher,
    held: Offer,
  ) {
    const snapshot = await registry.readWithEscrow(source, new PublicKey(voucher.escrow))
    // Only the licence is re-checked: the price is the one in force when the offer was
    // made, which is the moment the receipt names (acceptedAt, FR-004).
    const verdict = refusal(snapshot, use)
    if ('status' in verdict) return c.json(verdict.body, verdict.status)

    const escrow = snapshot.escrow
    if (escrow === null) {
      return c.json(paymentRequired(verdict.quote, { unavailable: 'escrow-missing' }), 402)
    }
    const accepted = verifyVoucher(voucher, held.body, await loadPosition(db, escrow))
    if (!accepted.ok) {
      return c.json(apiError('INVALID_INPUT', 'voucher rejected', { reason: accepted.reason }), 400)
    }
    const funds = checkFunds(escrow, voucher.cumulative)
    if (!funds.ok) {
      return c.json(paymentRequired(verdict.quote, { unavailable: funds.reason }), 402)
    }

    const recorded = await recordEscrowIssuance(
      db,
      held.body,
      voucher,
      mirrorOf(snapshot, source, held.mediaType, held.content.length),
    )
    if (!recorded.ok) {
      return c.json(apiError('INVALID_INPUT', 'voucher rejected', { reason: recorded.reason }), 400)
    }
    offers.delete(held.id)
    return deliver(c, recorded.receiptId, held.body, held.content, held.mediaType)
  }

  /**
   * The price is the one in force now: an x402 payment is presented after it is made, so
   * there is no earlier offer to hold a price from, and acceptedAt is this moment (FR-004).
   */
  async function redeem(
    c: Context,
    source: string,
    use: UseType,
    consumer: PublicKey | null,
    payment: z.infer<typeof x402Payment>,
  ) {
    const snapshot = await registry.read(source)
    const verdict = refusal(snapshot, use)
    if ('status' in verdict) return c.json(verdict.body, verdict.status)
    const { quote } = verdict

    const legs = x402Legs(quote)
    if (legs.length === 0) return paymentRejected(c, 'x402-not-offered')
    const paid = verifyX402Payment(await payments.transaction(payment.signature), {
      signature: payment.signature,
      legs,
      proof: payment.proof,
    })
    if (!paid.ok) return paymentRejected(c, X402_REJECTIONS[paid.reason])
    if (consumer !== null && consumer.toBase58() !== paid.payer) {
      return paymentRejected(c, 'consumer-mismatch')
    }

    // Recorded only after the fetch: an origin failure leaves the payment unredeemed,
    // so the agent can present it again.
    const served = await origin.fetch(source)
    const body: X402ReceiptBody = {
      consumer: paid.payer,
      work: quote.work,
      useType: use,
      tariff: quote.tariff.toString(),
      fee: quote.fee.toString(),
      rateLevel: quote.rateLevel,
      servedHash: sha256Hex(served.bytes),
      registryHash: registeredWork(snapshot).account.contentHash,
      acceptedAt: now().toISOString(),
      paymentMethod: 'x402',
      paymentRef: payment.signature,
    }
    const recorded = await recordX402Issuance(
      db,
      body,
      mirrorOf(snapshot, source, served.mediaType, served.bytes.length),
    )
    if (!recorded.ok) return paymentRejected(c, recorded.reason)
    return deliver(c, recorded.receiptId, body, served.bytes, served.mediaType)
  }

  return app
}

function deliver(
  c: Context,
  receiptId: string,
  body: ReceiptBody,
  content: Uint8Array<ArrayBuffer>,
  mediaType: string,
) {
  const receipt = { id: receiptId, ...body, hashMatch: body.servedHash === body.registryHash }
  return c.body(content, 200, {
    'Content-Type': mediaType,
    [RECEIPT]: Buffer.from(JSON.stringify(receipt)).toString('base64url'),
  })
}

function mirrorOf(
  snapshot: SlottedRegistrySnapshot,
  source: string,
  mediaType: string,
  byteLen: number,
): RegistryMirror {
  if (snapshot.domain === null) throw new Error('quoted without a domain account')
  return {
    slot: snapshot.slot,
    source,
    domain: snapshot.domain,
    work: registeredWork(snapshot),
    mediaType,
    byteLen,
  }
}

function registeredWork(snapshot: RegistrySnapshot) {
  if (snapshot.work === null) throw new Error('quoted without a work account')
  return snapshot.work
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
