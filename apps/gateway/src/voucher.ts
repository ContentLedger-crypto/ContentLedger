import { escrowPda } from '@contentledger/chain'
import {
  chainStep,
  type ReceiptBody,
  receiptLeaf,
  usdcAmountSchema,
  type Voucher,
  voucherMessage,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

/** The last voucher accepted from an agent, or its escrow genesis before the first one. */
export interface VoucherPosition {
  readonly seq: bigint
  readonly cumulative: bigint
  readonly chain: Uint8Array
}

export interface PresentedVoucher extends Voucher {
  readonly signature: Uint8Array
}

export type EscrowReceiptBody = Extract<ReceiptBody, { paymentMethod: 'escrow' }>

export type VoucherRejection =
  | 'escrow-mismatch'
  | 'bad-signature'
  | 'replayed'
  | 'seq-gap'
  | 'body-mismatch'
  | 'amount-mismatch'
  | 'chain-mismatch'

export type VoucherVerdict =
  | { ok: true; position: VoucherPosition }
  | { ok: false; reason: VoucherRejection }

const SIGNATURE_BYTES = 64

const publicKey = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .transform((value, ctx) => {
    try {
      return new PublicKey(value).toBytes()
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a 32-byte public key' })
      return z.NEVER
    }
  })

const signature = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
  .transform((value, ctx) => {
    const bytes = Uint8Array.from(utils.bytes.bs58.decode(value))
    if (bytes.length !== SIGNATURE_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'not a 64-byte signature' })
      return z.NEVER
    }
    return bytes
  })

const voucherHeaderSchema = z.strictObject({
  escrow: publicKey,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  cumulative: usdcAmountSchema,
  chain: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .transform((hex) => Uint8Array.from(Buffer.from(hex, 'hex'))),
  sig: signature,
})

/** `X-ContentLedger-Voucher`: base64url of `{ escrow, seq, cumulative, chain, sig }`. */
export function parseVoucherHeader(header: string): PresentedVoucher | null {
  // Buffer skips characters outside the alphabet instead of failing.
  if (!/^[A-Za-z0-9_-]+$/.test(header)) return null
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = voucherHeaderSchema.safeParse(json)
  if (!parsed.success) return null
  const { escrow, seq, cumulative, chain, sig } = parsed.data
  return { escrow, seq: BigInt(seq), cumulative, chain, signature: sig }
}

/**
 * `body` is the draft the gateway offered in the 402, so the agent could chain over
 * the exact bytes that become the receipt. `previous` must come from durable storage:
 * an in-memory position would forget accepted vouchers on restart and take them again.
 */
export function verifyVoucher(
  voucher: PresentedVoucher,
  body: EscrowReceiptBody,
  previous: VoucherPosition,
): VoucherVerdict {
  const consumer = new PublicKey(body.consumer)
  const [escrow] = escrowPda(consumer)
  if (!escrow.equals(new PublicKey(voucher.escrow))) {
    return { ok: false, reason: 'escrow-mismatch' }
  }
  // Before the position checks: only the agent itself learns why its voucher is out of
  // sequence, not whoever tampered with it.
  if (!ed25519.verify(voucher.signature, voucherMessage(voucher), consumer.toBytes())) {
    return { ok: false, reason: 'bad-signature' }
  }
  if (voucher.seq <= previous.seq) return { ok: false, reason: 'replayed' }
  if (voucher.seq !== previous.seq + 1n) return { ok: false, reason: 'seq-gap' }
  if (voucher.seq !== BigInt(body.seq)) return { ok: false, reason: 'body-mismatch' }

  const charged = BigInt(body.tariff) + BigInt(body.fee)
  if (voucher.cumulative - previous.cumulative !== charged) {
    return { ok: false, reason: 'amount-mismatch' }
  }
  const chain = chainStep(previous.chain, receiptLeaf(body))
  if (!equalBytes(chain, voucher.chain)) return { ok: false, reason: 'chain-mismatch' }

  return { ok: true, position: { seq: voucher.seq, cumulative: voucher.cumulative, chain } }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
