import { randomBytes } from 'node:crypto'
import type { EscrowReceiptBody } from './voucher.js'

/** A draft the agent can sign; the bytes are held so the paid response serves exactly them. */
export interface Offer {
  id: string
  source: string
  body: EscrowReceiptBody
  content: Uint8Array<ArrayBuffer>
  mediaType: string
  cumulativeAfter: bigint
  expiresAt: Date
}

export interface OfferStore {
  put(offer: Omit<Offer, 'id' | 'expiresAt'>): Offer
  get(id: string): Offer | null
  delete(id: string): void
}

export interface OfferStoreOptions {
  ttlMs: number
  /** Ceiling on held content, so unpaid 402s cannot grow the gateway without bound. */
  maxBytes: number
  now: () => Date
}

/**
 * In memory on purpose: a lost offer costs the agent one more 402, never money, since a
 * voucher is only kept once it is recorded in Postgres.
 */
export function offerStore({ ttlMs, maxBytes, now }: OfferStoreOptions): OfferStore {
  const offers = new Map<string, Offer>()
  let heldBytes = 0

  const remove = (id: string) => {
    const offer = offers.get(id)
    if (offer === undefined) return
    offers.delete(id)
    heldBytes -= offer.content.length
  }

  return {
    put(draft) {
      const offer: Offer = {
        ...draft,
        id: randomBytes(16).toString('base64url'),
        expiresAt: new Date(now().getTime() + ttlMs),
      }
      offers.set(offer.id, offer)
      heldBytes += offer.content.length
      // Map iterates in insertion order, so the first key is always the oldest offer.
      for (const oldest of offers.keys()) {
        if (heldBytes <= maxBytes || oldest === offer.id) break
        remove(oldest)
      }
      return offer
    },

    get(id) {
      const offer = offers.get(id)
      if (offer === undefined) return null
      if (offer.expiresAt.getTime() <= now().getTime()) {
        remove(id)
        return null
      }
      return offer
    },

    delete: remove,
  }
}
