import { z } from 'zod'
import { usdcAmountSchema, useTypeSchema } from './money.js'
import { base58KeySchema, hex256Schema, utcInstantSchema } from './voucher.js'

const countSchema = z.number().int().min(0)
const paymentMethodSchema = z.enum(['escrow', 'x402'])

export const publisherReceiptSchema = z.object({
  id: hex256Schema,
  workId: base58KeySchema,
  sourceId: z.string(),
  consumer: base58KeySchema,
  useType: useTypeSchema,
  tariff: usdcAmountSchema,
  paymentMethod: paymentMethodSchema,
  acceptedAt: utcInstantSchema,
  /** When the money moved: the batch for escrow, the payment itself for x402. */
  settledAt: utcInstantSchema.nullable(),
})

export const receiptsPageSchema = z.object({
  items: z.array(publisherReceiptSchema),
  nextCursor: z.string().nullable(),
})

export const publisherSummarySchema = z.object({
  /** What the publisher receives: the rates, without the fee charged on top of them. */
  total: usdcAmountSchema,
  fee: usdcAmountSchema,
  count: countSchema,
  byWork: z.array(
    z.object({
      workId: base58KeySchema,
      sourceId: z.string(),
      count: countSchema,
      total: usdcAmountSchema,
    }),
  ),
  byConsumer: z.array(
    z.object({
      consumer: base58KeySchema,
      count: countSchema,
      total: usdcAmountSchema,
      paymentMethods: z.array(paymentMethodSchema).min(1),
    }),
  ),
  /** One per consumer and work that met in the period. */
  flows: z.array(
    z.object({
      consumer: base58KeySchema,
      workId: base58KeySchema,
      count: countSchema,
      total: usdcAmountSchema,
    }),
  ),
  /** Splits `total` by where the money stands now, not where it stood at the period's end. */
  settlement: z.object({
    inBatch: usdcAmountSchema,
    accrued: usdcAmountSchema,
    perRequest: usdcAmountSchema,
  }),
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
