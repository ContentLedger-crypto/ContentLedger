import { errorChain } from '../errors.js'
import type { SessionWallet } from '../routes/auth.js'
import type { Database } from '../store.js'
import { issuedReceipt, type ReceiptItem, settledReceipts } from './queries.js'

export type FeedEvent =
  | { type: 'receipt'; receipt: ReceiptItem }
  | { type: 'settlement'; batchId: string; settledAt: Date; receiptIds: string[] }
  /** Events may have been lost; the dashboard re-reads its snapshot. */
  | { type: 'resync' }

export interface Feed {
  subscribe(wallet: SessionWallet, listener: (event: FeedEvent) => void): () => void
  /** Never rejects: the receipt is already committed and the agent must still get it. */
  receiptIssued(id: string): Promise<void>
  batchSettled(batchId: string): Promise<void>
  resync(): void
}

/**
 * Events name a receipt or a batch, and the owner is looked up after commit: routing by
 * the snapshot the gateway priced from could disagree with what the publisher queries
 * show, since an older snapshot does not overwrite a newer mirror row.
 */
export function publisherFeed(db: Database, log: (message: string) => void = console.error): Feed {
  const listeners = new Map<string, Set<(event: FeedEvent) => void>>()

  const deliver = (wallet: string, event: FeedEvent) => {
    for (const listener of listeners.get(wallet) ?? []) listener(event)
  }

  const guarded = async (what: string, work: () => Promise<void>) => {
    if (listeners.size === 0) return
    try {
      await work()
    } catch (error) {
      log(`feed: ${what} not delivered: ${errorChain(error)}`)
    }
  }

  return {
    subscribe(wallet, listener) {
      const own = listeners.get(wallet) ?? new Set()
      own.add(listener)
      listeners.set(wallet, own)
      return () => {
        own.delete(listener)
        if (own.size === 0 && listeners.get(wallet) === own) listeners.delete(wallet)
      }
    },

    receiptIssued: (id) =>
      guarded(`receipt ${id}`, async () => {
        for (const { owner, ...receipt } of await issuedReceipt(db, id)) {
          deliver(owner, { type: 'receipt', receipt })
        }
      }),

    batchSettled: (batchId) =>
      guarded(`batch ${batchId}`, async () => {
        const byOwner = new Map<string, { settledAt: Date; receiptIds: string[] }>()
        for (const { owner, id, settledAt } of await settledReceipts(db, batchId)) {
          if (settledAt === null) continue
          const entry = byOwner.get(owner) ?? { settledAt, receiptIds: [] }
          entry.receiptIds.push(id)
          byOwner.set(owner, entry)
        }
        for (const [owner, settled] of byOwner) {
          deliver(owner, { type: 'settlement', batchId, ...settled })
        }
      }),

    resync() {
      for (const wallet of listeners.keys()) deliver(wallet, { type: 'resync' })
    },
  }
}
