import { createHash } from 'node:crypto'
import {
  associatedTokenAddress,
  awaitSignature,
  type WatchOptions,
  x402ProofMessage,
} from '@contentledger/chain'
import { receiptId, USDC_DECIMALS, type UseType } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token'
import {
  type Connection,
  type Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { type Delivery, parseReceipt, type Quote, type X402Method } from './protocol.js'

/** A signed payment transaction, kept so it can be sent again and redeemed after a crash. */
export interface PreparedPayment {
  signature: string
  /** The signed transaction, base64. */
  transaction: string
  blockhash: string
  lastValidBlockHeight: number
}

/** What the payment was for: enough to present it again and to check what comes back. */
export interface PendingPayment extends PreparedPayment {
  source: string
  use: UseType
  work: string
  tariff: string
  fee: string
}

export type Landing = 'landed' | 'failed' | 'expired'

export interface PaymentRail {
  prepare(instructions: readonly TransactionInstruction[]): Promise<PreparedPayment>
  /** Sends, or sends again, and resolves once the cluster has decided. */
  land(payment: PreparedPayment): Promise<Landing>
}

export type PaymentProblem = 'terms-mismatch' | 'leg-account-mismatch'

/**
 * The agent pays exactly what the 402 quoted, to accounts it can check itself: a leg that
 * names its owner must be that owner's account for this mint. The owner is named only
 * where the account may not exist yet, so creating it is idempotent — a payer before
 * this one may already have.
 */
export function paymentInstructions(
  payer: PublicKey,
  method: X402Method,
  quote: Quote,
): { ok: true; instructions: TransactionInstruction[] } | { ok: false; problem: PaymentProblem } {
  const destinations = new Set(method.legs.map((leg) => leg.payTo))
  const total = method.legs.reduce((sum, leg) => sum + leg.amount, 0n)
  if (
    total !== quote.total ||
    destinations.size !== method.legs.length ||
    method.legs.some((leg) => leg.amount <= 0n)
  ) {
    return { ok: false, problem: 'terms-mismatch' }
  }

  const mint = new PublicKey(method.mint)
  const source = associatedTokenAddress(payer, mint)
  const instructions: TransactionInstruction[] = []
  for (const leg of method.legs) {
    const destination = new PublicKey(leg.payTo)
    if (leg.owner !== undefined) {
      const owner = new PublicKey(leg.owner)
      if (!associatedTokenAddress(owner, mint).equals(destination)) {
        return { ok: false, problem: 'leg-account-mismatch' }
      }
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(payer, destination, owner, mint),
      )
    }
    instructions.push(
      createTransferCheckedInstruction(source, mint, destination, payer, leg.amount, USDC_DECIMALS),
    )
  }
  return { ok: true, instructions }
}

/** A transaction signature is public once it lands; the proof ties it to this payer. */
export function paymentProof(payer: Keypair, signature: string): string {
  const proof = ed25519.sign(x402ProofMessage(signature), payer.secretKey.subarray(0, 32))
  return utils.bytes.bs58.encode(proof)
}

/**
 * The gateway sets `acceptedAt` when it redeems the payment, so the agent cannot know the
 * receipt's id in advance; it holds every field it does know, and the bytes, to account.
 */
export function checkX402Delivery(
  bytes: Uint8Array,
  receiptHeader: string | undefined,
  payment: PendingPayment,
  consumer: string,
): Delivery {
  const receipt = parseReceipt(receiptHeader)
  if (receipt === null) return { ok: false, reason: 'receipt-missing' }
  const { id, hashMatch, ...body } = receipt
  if (
    body.paymentMethod !== 'x402' ||
    body.paymentRef !== payment.signature ||
    body.consumer !== consumer ||
    body.work !== payment.work ||
    body.useType !== payment.use ||
    body.tariff !== payment.tariff ||
    body.fee !== payment.fee ||
    receiptId(body) !== id
  ) {
    return { ok: false, reason: 'receipt-mismatch' }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== body.servedHash) {
    return { ok: false, reason: 'served-hash-mismatch' }
  }
  return { ok: true, receipt }
}

type RailConnection = Pick<
  Connection,
  'getLatestBlockhash' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'
>

/**
 * `confirmed`, the commitment the gateway reads payments at. Sending again is harmless:
 * the cluster deduplicates by signature, and that is what lets a payment journaled before
 * a crash be landed afterwards instead of lost.
 */
export function rpcPaymentRail(
  connection: RailConnection,
  payer: Keypair,
  // The request waits on this: `confirmed` arrives in about a second.
  watch: WatchOptions = { pollMs: 400 },
): PaymentRail {
  return {
    async prepare(instructions) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
      tx.add(...instructions).sign(payer)
      if (tx.signature === null) throw new Error('payment transaction was not signed')
      return {
        signature: utils.bytes.bs58.encode(tx.signature),
        transaction: tx.serialize().toString('base64'),
        blockhash,
        lastValidBlockHeight,
      }
    },

    async land({ signature, transaction, lastValidBlockHeight }) {
      try {
        await connection.sendRawTransaction(Buffer.from(transaction, 'base64'), {
          preflightCommitment: 'confirmed',
        })
      } catch (error) {
        // Already landed, or sent again past a blockhash this node no longer knows: the
        // confirmation below decides. Any other refusal is preflight saying it cannot land.
        const decidedBelow = /already been processed|blockhash not found/i.test(String(error))
        if (!decidedBelow) {
          if (error instanceof SendTransactionError) return 'failed'
          throw error
        }
      }
      const { status } = await awaitSignature(
        connection,
        { signature, lastValidBlockHeight, commitment: 'confirmed' },
        watch,
      )
      return status
    },
  }
}
