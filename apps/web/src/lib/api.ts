import {
  type PublisherReceipt,
  publisherReceiptSchema,
  publisherSummarySchema,
  receiptsPageSchema,
} from '@contentledger/shared'
import { INCOMING, INCOMING_INTERVAL_MS, RECEIPTS, SESSION_WALLET, SUMMARY } from './mock'

/**
 * The one module the dashboard reads data from. What the gateway serves passes through
 * the shared contract here exactly as a live response will; what it does not serve yet
 * is re-exported below as it is, until the task that serves it.
 */

export const sessionWallet = SESSION_WALLET

export const receipts = receiptsPageSchema.parse(RECEIPTS)

export const summary = publisherSummarySchema.parse(SUMMARY)

export function subscribeReceipts(onReceipt: (receipt: PublisherReceipt) => void): () => void {
  const timers = INCOMING.map((wire, index) =>
    setTimeout(
      () => onReceipt(publisherReceiptSchema.parse(wire)),
      INCOMING_INTERVAL_MS * (index + 1),
    ),
  )
  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}

export {
  CONSUMER_TOTALS,
  type ConsumerTotal,
  EDGES,
  type Edge,
  INCLUSION_PATH,
  PERIOD_LABEL,
  PERIOD_PAID_BY_AGENTS,
  PERIOD_PROTOCOL_FEE,
  RECEIPT,
  SETTLEMENT,
  VERIFY_STEPS,
} from './mock'
