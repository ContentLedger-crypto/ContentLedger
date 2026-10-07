import {
  type MerklePath,
  publicBatchSchema,
  publicReceiptSchema,
  type ReceiptBody,
} from '@contentledger/shared'

export type PublishedAnchor =
  | { kind: 'pending' }
  | { kind: 'payment'; paymentRef: string }
  | { kind: 'batch'; seqTo: number; txSig: string; path: MerklePath }

export interface PublishedReceipt {
  body: ReceiptBody
  anchor: PublishedAnchor
}

export interface PublishedBatch {
  consumer: string
  seqFrom: number
  seqTo: number
  previous: { seqTo: number; txSig: string } | null
  receipts: ReceiptBody[]
}

/** What the gateway says. Nothing here is believed until the network agrees with it. */
export interface Publication {
  receipt(id: string): Promise<PublishedReceipt | null>
  batch(consumer: string, seqTo: number): Promise<PublishedBatch | null>
}

const hexBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))

export function gatewayPublication(baseUrl: string, fetchImpl: typeof fetch = fetch): Publication {
  async function get(path: string): Promise<unknown> {
    const response = await fetchImpl(new URL(path, baseUrl).toString())
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`)
    return response.json()
  }

  return {
    async receipt(id) {
      const raw = await get(`/v1/receipts/${id}`)
      if (raw === null) return null
      const { body, anchor } = publicReceiptSchema.parse(raw)
      if (anchor.kind !== 'batch') return { body, anchor }
      const { seqTo, txSig, path } = anchor
      const steps = path.map(({ hash, side }) => ({ hash: hexBytes(hash), side }))
      return { body, anchor: { kind: 'batch', seqTo, txSig, path: steps } }
    },

    // `root` and `chain` are served too, and deliberately not read: those come from the network.
    async batch(consumer, seqTo) {
      const raw = await get(`/v1/batches/${consumer}/${seqTo}`)
      if (raw === null) return null
      const batch = publicBatchSchema.parse(raw)
      return {
        consumer: batch.consumer,
        seqFrom: batch.seqFrom,
        seqTo: batch.seqTo,
        previous: batch.previous,
        receipts: batch.receipts,
      }
    },
  }
}
