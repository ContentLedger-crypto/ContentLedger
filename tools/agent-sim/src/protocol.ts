import { createHash } from 'node:crypto'
import { escrowPda } from '@contentledger/chain'
import {
  chainStep,
  type ReceiptBody,
  receiptBodySchema,
  receiptId,
  receiptLeaf,
  type UseType,
  usdcAmountSchema,
  useTypeSchema,
  voucherMessage,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import type { Keypair } from '@solana/web3.js'
import { z } from 'zod'

export type EscrowBody = Extract<ReceiptBody, { paymentMethod: 'escrow' }>

/** What this agent has signed so far: the next voucher extends exactly this. */
export interface Position {
  seq: bigint
  cumulative: bigint
  chain: Uint8Array
}

const escrowBodySchema = receiptBodySchema.options[0]

const offerSchema = z.object({
  id: z.string().min(1),
  body: escrowBodySchema,
  cumulativeAfter: usdcAmountSchema,
  expiresAt: z.iso.datetime().transform((iso) => new Date(iso)),
})

export type EscrowOffer = z.infer<typeof offerSchema>

const paymentRequiredSchema = z.object({
  error: z.object({
    code: z.literal('PAYMENT_REQUIRED'),
    details: z.object({
      reason: z.literal('offer-expired').optional(),
      work: z.string(),
      useType: useTypeSchema,
      tariff: usdcAmountSchema,
      fee: usdcAmountSchema,
      total: usdcAmountSchema,
      methods: z.array(z.looseObject({ kind: z.string() })),
    }),
  }),
})

const escrowMethodSchema = z.union([
  z.object({ kind: z.literal('escrow'), offer: offerSchema }),
  z.object({ kind: z.literal('escrow'), unavailable: z.string() }),
])

export interface Quote {
  work: string
  useType: UseType
  tariff: bigint
  fee: bigint
  total: bigint
}

export interface PaymentRequired {
  quote: Quote
  escrow: { offer: EscrowOffer } | { unavailable: string }
  reason: 'offer-expired' | undefined
}

export function parsePaymentRequired(json: unknown): PaymentRequired | null {
  const parsed = paymentRequiredSchema.safeParse(json)
  if (!parsed.success) return null
  const { reason, methods, work, useType, tariff, fee, total } = parsed.data.error.details
  const method = escrowMethodSchema.safeParse(methods.find((m) => m.kind === 'escrow'))
  if (!method.success) return null
  const escrow =
    'offer' in method.data ? { offer: method.data.offer } : { unavailable: method.data.unavailable }
  return { quote: { work, useType, tariff, fee, total }, escrow, reason }
}

export type OfferProblem =
  | 'consumer-mismatch'
  | 'seq-mismatch'
  | 'terms-mismatch'
  | 'cumulative-mismatch'

/**
 * The agent signs a chain over this body, so it signs for everything in it: the draft
 * must be its own, continue its own history, and carry the price the 402 quoted.
 */
export function checkOffer(
  offer: EscrowOffer,
  quote: Quote,
  position: Position,
  consumer: string,
  use: UseType,
): OfferProblem | null {
  const { body } = offer
  if (body.consumer !== consumer) return 'consumer-mismatch'
  if (BigInt(body.seq) !== position.seq + 1n) return 'seq-mismatch'
  if (
    body.work !== quote.work ||
    body.useType !== use ||
    quote.useType !== use ||
    BigInt(body.tariff) !== quote.tariff ||
    BigInt(body.fee) !== quote.fee ||
    quote.tariff + quote.fee !== quote.total
  ) {
    return 'terms-mismatch'
  }
  if (offer.cumulativeAfter !== position.cumulative + quote.total) return 'cumulative-mismatch'
  return null
}

export interface SignedVoucher {
  header: string
  next: Position
  receiptId: string
}

export function signVoucher(agent: Keypair, position: Position, offer: EscrowOffer): SignedVoucher {
  const escrow = escrowPda(agent.publicKey)[0]
  const seq = position.seq + 1n
  const chain = chainStep(position.chain, receiptLeaf(offer.body))
  const cumulative = offer.cumulativeAfter
  const message = voucherMessage({ escrow: escrow.toBytes(), seq, cumulative, chain })
  const sig = ed25519.sign(message, agent.secretKey.subarray(0, 32))
  const header = Buffer.from(
    JSON.stringify({
      escrow: escrow.toBase58(),
      seq: Number(seq),
      cumulative: cumulative.toString(),
      chain: Buffer.from(chain).toString('hex'),
      sig: utils.bytes.bs58.encode(sig),
    }),
  ).toString('base64url')
  return { header, next: { seq, cumulative, chain }, receiptId: receiptId(offer.body) }
}

export type Receipt = EscrowBody & { id: string; hashMatch: boolean }

export type Delivery =
  | { ok: true; receipt: Receipt }
  | { ok: false; reason: 'receipt-missing' | 'receipt-mismatch' | 'served-hash-mismatch' }

/** FR-011a: the agent hashes what it received instead of taking the receipt's word. */
export function checkDelivery(
  bytes: Uint8Array,
  receiptHeader: string | undefined,
  offered: EscrowBody,
  offeredId: string,
): Delivery {
  const receipt = parseReceipt(receiptHeader)
  if (receipt === null) return { ok: false, reason: 'receipt-missing' }
  const { id, hashMatch, ...body } = receipt
  if (id !== offeredId || receiptId(body) !== offeredId || receiptId(offered) !== offeredId) {
    return { ok: false, reason: 'receipt-mismatch' }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== body.servedHash) {
    return { ok: false, reason: 'served-hash-mismatch' }
  }
  return { ok: true, receipt: { id, hashMatch, ...body } }
}

function parseReceipt(header: string | undefined): Receipt | null {
  if (header === undefined) return null
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const { id, hashMatch, ...rest } = json as Record<string, unknown>
  const body = escrowBodySchema.safeParse(rest)
  if (!body.success || typeof id !== 'string' || typeof hashMatch !== 'boolean') return null
  return { ...body.data, id, hashMatch }
}
