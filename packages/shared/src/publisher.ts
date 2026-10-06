import { z } from 'zod'
import { usdcAmountSchema, useTypeSchema } from './money.js'
import { base58KeySchema, hex256Schema, utcInstantSchema } from './voucher.js'

const countSchema = z.number().int().min(0)

export const publisherReceiptSchema = z.object({
  id: hex256Schema,
  workId: base58KeySchema,
  sourceId: z.string(),
  consumer: base58KeySchema,
  useType: useTypeSchema,
  tariff: usdcAmountSchema,
  paymentMethod: z.enum(['escrow', 'x402']),
  acceptedAt: utcInstantSchema,
  /** When the money moved: the batch for escrow, the payment itself for x402. */
  settledAt: utcInstantSchema.nullable(),
})

export const receiptsPageSchema = z.object({
  items: z.array(publisherReceiptSchema),
  nextCursor: z.string().nullable(),
})

export const publisherSummarySchema = z.object({
  total: usdcAmountSchema,
  count: countSchema,
  byWork: z.array(
    z.object({
      workId: base58KeySchema,
      sourceId: z.string(),
      count: countSchema,
      total: usdcAmountSchema,
    }),
  ),
  /** `null` — the chain was not read, which is not the same as "nothing registered". */
  registeredWorks: countSchema.nullable(),
})

export const settlementEventSchema = z.object({
  batchId: hex256Schema,
  settledAt: utcInstantSchema,
  receiptIds: z.array(hex256Schema),
})

export type PublisherReceipt = z.output<typeof publisherReceiptSchema>
export type ReceiptsPage = z.output<typeof receiptsPageSchema>
export type PublisherSummary = z.output<typeof publisherSummarySchema>
export type SettlementEvent = z.output<typeof settlementEventSchema>
