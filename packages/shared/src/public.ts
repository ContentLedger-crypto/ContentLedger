import { z } from 'zod'
import {
  base58KeySchema,
  base58SignatureSchema,
  hex256Schema,
  receiptBodySchema,
  seqSchema,
  utcInstantSchema,
} from './voucher.js'

// What the public endpoints (FR-013b) serve, before anyone has checked a word of it.

export const publicAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('payment'), paymentRef: base58SignatureSchema }),
  z.object({
    kind: z.literal('batch'),
    consumer: base58KeySchema,
    seqTo: seqSchema,
    root: hex256Schema,
    txSig: base58SignatureSchema,
    settledAt: utcInstantSchema,
    path: z.array(z.object({ hash: hex256Schema, side: z.enum(['left', 'right']) })),
  }),
])

// The body sits beside `id`, `hashMatch` and `anchor` in one object; it is cut out and
// held to the strict signed form, so a field the payer never signed cannot ride along.
export const publicReceiptSchema = z
  .looseObject({})
  .transform(({ id, hashMatch, anchor, ...body }) => ({ id, hashMatch, anchor, body }))
  .pipe(
    z.object({
      id: hex256Schema,
      hashMatch: z.boolean(),
      anchor: publicAnchorSchema,
      body: receiptBodySchema,
    }),
  )

export const publicBatchSchema = z.object({
  consumer: base58KeySchema,
  seqFrom: seqSchema,
  seqTo: seqSchema,
  root: hex256Schema,
  chain: hex256Schema,
  txSig: base58SignatureSchema,
  publishedAt: utcInstantSchema,
  previous: z.object({ seqTo: seqSchema, txSig: base58SignatureSchema }).nullable(),
  receipts: z.array(receiptBodySchema),
})

// The newest settled batch: where it is, not what is in it. Its composition is the
// batch endpoint's, its truth the transaction's.
export const publicLatestBatchSchema = z.object({
  consumer: base58KeySchema,
  seqTo: seqSchema,
  txSig: base58SignatureSchema,
  publishedAt: utcInstantSchema,
  receipts: z.number().int().positive(),
})

export type PublicAnchor = z.output<typeof publicAnchorSchema>
export type PublicReceipt = z.output<typeof publicReceiptSchema>
export type PublicBatch = z.output<typeof publicBatchSchema>
