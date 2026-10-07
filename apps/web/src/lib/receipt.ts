import { type PublicAnchor, type PublicReceipt, receiptId } from '@contentledger/shared'
import type { PublicationSource } from './api'

type BatchAnchor = Extract<PublicAnchor, { kind: 'batch' }>

export interface BatchFacts {
  readonly seqFrom: number
  readonly seqTo: number
  readonly count: number
  readonly chain: string
  /** Rates and fees together: what the agent's vouchers debited across the whole batch. */
  readonly charged: bigint
}

/**
 * `tampered`: what the gateway served does not hash to the id that was asked about, so
 * not one field of it can be shown as this receipt.
 */
export type ReceiptView =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'tampered' }
  | { readonly kind: 'pending'; readonly receipt: PublicReceipt }
  | { readonly kind: 'payment'; readonly receipt: PublicReceipt; readonly paymentRef: string }
  | {
      readonly kind: 'batch'
      readonly receipt: PublicReceipt
      readonly anchor: BatchAnchor
      readonly batch: BatchFacts
    }

export async function readReceipt(
  source: PublicationSource,
  id: string,
  signal: AbortSignal,
): Promise<ReceiptView> {
  const receipt = await source.receipt(id, signal)
  if (receipt === null) return { kind: 'unknown' }
  if (receiptId(receipt.body) !== id) return { kind: 'tampered' }

  const { anchor } = receipt
  if (anchor.kind === 'pending') return { kind: 'pending', receipt }
  if (anchor.kind === 'payment') return { kind: 'payment', receipt, paymentRef: anchor.paymentRef }

  const batch = await source.batch(anchor.consumer, anchor.seqTo, signal)
  if (batch === null) {
    throw new Error(`the gateway anchors ${id} to batch ${anchor.seqTo}, which it does not publish`)
  }
  return {
    kind: 'batch',
    receipt,
    anchor,
    batch: {
      seqFrom: batch.seqFrom,
      seqTo: batch.seqTo,
      count: batch.receipts.length,
      chain: batch.chain,
      charged: batch.receipts.reduce(
        (total, body) => total + BigInt(body.tariff) + BigInt(body.fee),
        0n,
      ),
    },
  }
}
