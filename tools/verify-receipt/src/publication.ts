import { type MerklePath, type ReceiptBody, receiptBodySchema } from '@contentledger/shared'
import { z } from 'zod'

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

const seqNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
const hex256 = z.string().regex(/^[0-9a-f]{64}$/)

const anchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('payment'), paymentRef: signature }),
  z.object({
    kind: z.literal('batch'),
    seqTo: seqNumber,
    txSig: signature,
    path: z.array(
      z.object({
        hash: hex256.transform((hex) => new Uint8Array(Buffer.from(hex, 'hex'))),
        side: z.enum(['left', 'right']),
      }),
    ),
  }),
])

// The body sits beside `id`, `hashMatch` and `anchor` in one object; it is cut out and
// held to the strict signed form, so a field the payer never signed cannot ride along.
const receiptAnswer = z.looseObject({ id: hex256, hashMatch: z.boolean(), anchor: anchorSchema })

// `root` and `chain` are served too, and deliberately not read: those come from the network.
const batchAnswer = z.object({
  consumer: z.string(),
  seqFrom: seqNumber,
  seqTo: seqNumber,
  previous: z.object({ seqTo: seqNumber, txSig: signature }).nullable(),
  receipts: z.array(receiptBodySchema),
})

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
      const { id: _id, hashMatch: _hashMatch, anchor, ...body } = receiptAnswer.parse(raw)
      return { body: receiptBodySchema.parse(body), anchor }
    },

    async batch(consumer, seqTo) {
      const raw = await get(`/v1/batches/${consumer}/${seqTo}`)
      return raw === null ? null : batchAnswer.parse(raw)
    },
  }
}
