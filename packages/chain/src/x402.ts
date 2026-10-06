import { usdcAmountSchema } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

/** Legacy SPL Token only: Token-2022 fee and hook extensions skim the transfer. */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const PROOF_TAG = new TextEncoder().encode('CLDGR:x402:v1')
const SIGNATURE_BYTES = 64

const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

// Multisig transfers expose `multisigAuthority` instead of `authority`, so they fall
// through here: there is no single key that could sign the payer proof.
const tokenTransfer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transfer'),
    info: z.object({ destination: base58Key, authority: base58Key, amount: usdcAmountSchema }),
  }),
  z.object({
    type: z.literal('transferChecked'),
    info: z.object({
      destination: base58Key,
      authority: base58Key,
      tokenAmount: z.object({ amount: usdcAmountSchema }),
    }),
  }),
])

// Instructions of programs the node cannot decode come without `parsed`.
const rpcInstruction = z.object({ programId: z.string(), parsed: z.unknown().optional() })

/**
 * The part of a `getTransaction` answer in `encoding: 'jsonParsed'` that the check reads,
 * spelled out rather than taken from `@solana/web3.js` 1.x: that client rejects version 1
 * transactions outright, and a payer's wallet chooses the version, not the gateway.
 * Fields a newer version adds pass through untouched.
 */
export const x402TransactionSchema = z.object({
  /** Unix seconds; `null` when the node has no estimate for the block. */
  blockTime: z.number().int().nullable(),
  meta: z
    .object({
      err: z.unknown(),
      innerInstructions: z.array(z.object({ instructions: z.array(rpcInstruction) })).nullish(),
    })
    .nullable(),
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({ instructions: z.array(rpcInstruction) }),
  }),
})

export type X402Transaction = z.infer<typeof x402TransactionSchema>

export interface X402Leg {
  /** Token account, not wallet: the recipient ATA or `Config::treasury_ata`. */
  destination: string
  amount: bigint
}

export interface X402Expectation {
  signature: string
  legs: readonly X402Leg[]
  /** Ed25519 signature by the payer over `x402ProofMessage(signature)`. */
  proof: Uint8Array
}

export type X402Rejection =
  | 'not_found'
  | 'failed'
  | 'signature_mismatch'
  | 'ambiguous_payer'
  | 'leg_mismatch'
  | 'proof_invalid'

export type X402Verdict =
  | { ok: true; payer: string; paidAt: Date | null }
  | { ok: false; reason: X402Rejection }

/**
 * A transaction signature is public the moment it lands, so presenting it proves
 * nothing about who is asking. The proof binds the request to the payer's key;
 * without it anyone watching the chain could redeem someone else's payment first.
 */
export function x402ProofMessage(signature: string): Uint8Array {
  const raw = utils.bytes.bs58.decode(signature)
  if (raw.length !== SIGNATURE_BYTES) {
    throw new RangeError(`expected a ${SIGNATURE_BYTES}-byte transaction signature`)
  }
  const message = new Uint8Array(PROOF_TAG.length + SIGNATURE_BYTES)
  message.set(PROOF_TAG)
  message.set(raw, PROOF_TAG.length)
  return message
}

/**
 * Replay (FR-009) is not checked here: whether a signature was already redeemed is
 * state, and it lives with whoever stores receipts.
 */
export function verifyX402Payment(
  tx: X402Transaction | null,
  expected: X402Expectation,
): X402Verdict {
  const owed = expectedLegs(expected.legs)
  if (tx === null) return { ok: false, reason: 'not_found' }
  if (tx.meta === null || tx.meta.err !== null) return { ok: false, reason: 'failed' }
  if (tx.transaction.signatures[0] !== expected.signature) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  const paid = new Map<string, bigint>()
  const payers = new Set<string>()
  for (const { destination, authority, amount } of legTransfers(tx, owed)) {
    paid.set(destination, (paid.get(destination) ?? 0n) + amount)
    payers.add(authority)
  }

  const [payer, ...others] = payers
  if (others.length > 0) return { ok: false, reason: 'ambiguous_payer' }
  if (payer === undefined) return { ok: false, reason: 'leg_mismatch' }
  // Exact, not at-least: an overpayment would leave the receipt's tariff and the
  // money actually received disagreeing, which is what SC-005 forbids.
  for (const [destination, amount] of owed) {
    if ((paid.get(destination) ?? 0n) !== amount) return { ok: false, reason: 'leg_mismatch' }
  }

  if (!proofHolds(expected, payer)) return { ok: false, reason: 'proof_invalid' }
  const paidAt = tx.blockTime === null ? null : new Date(tx.blockTime * 1000)
  return { ok: true, payer, paidAt }
}

function expectedLegs(legs: readonly X402Leg[]): Map<string, bigint> {
  if (legs.length === 0) throw new RangeError('an x402 payment needs at least one leg')
  const owed = new Map<string, bigint>()
  for (const { destination, amount } of legs) {
    if (owed.has(destination)) throw new RangeError(`duplicate leg destination ${destination}`)
    if (amount < 0n) throw new RangeError(`negative leg amount ${amount}`)
    owed.set(destination, amount)
  }
  if ([...owed.values()].every((amount) => amount === 0n)) {
    throw new RangeError('a zero total needs no payment')
  }
  return owed
}

function* legTransfers(tx: X402Transaction, owed: Map<string, bigint>) {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions)
  for (const ix of [...tx.transaction.message.instructions, ...inner]) {
    const transfer = asTokenTransfer(ix)
    if (transfer !== null && owed.has(transfer.destination)) yield transfer
  }
}

function asTokenTransfer(ix: z.infer<typeof rpcInstruction>) {
  if (ix.programId !== TOKEN_PROGRAM_ID) return null
  const parsed = tokenTransfer.safeParse(ix.parsed)
  if (!parsed.success) return null
  const { info } = parsed.data
  const amount = 'amount' in info ? info.amount : info.tokenAmount.amount
  return { destination: info.destination, authority: info.authority, amount }
}

function proofHolds({ signature, proof }: X402Expectation, payer: string): boolean {
  try {
    return ed25519.verify(proof, x402ProofMessage(signature), new PublicKey(payer).toBytes())
  } catch {
    return false
  }
}
