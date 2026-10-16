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

const licenceStatusSchema = z.enum(['active', 'suspended'])

export const publisherDomainsSchema = z.object({
  domains: z.array(
    z.object({
      address: base58KeySchema,
      host: z.string(),
      rateTrain: usdcAmountSchema,
      rateInference: usdcAmountSchema,
      status: licenceStatusSchema,
      works: countSchema,
    }),
  ),
})

export const registrationRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('domain'),
    host: z.string().max(253),
    rateTrain: usdcAmountSchema,
    rateInference: usdcAmountSchema,
  }),
  z.strictObject({
    kind: z.literal('work'),
    source: z.string().max(2048),
    /** `null` — the work takes the domain's rate for this use. */
    rateTrain: usdcAmountSchema.nullable(),
    rateInference: usdcAmountSchema.nullable(),
  }),
])

export const registrationRefusalSchema = z.enum([
  'host-not-canonical',
  'source-not-canonical',
  'domain-taken',
  'domain-missing',
  'domain-not-yours',
  'source-taken',
  'source-unreachable',
])

export const preparedRegistrationSchema = z.object({
  /** Base64 of a transaction the session wallet pays for and is still to sign. */
  transaction: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected base64'),
  /** The domain or work account the transaction creates. */
  address: base58KeySchema,
  lastValidBlockHeight: z.number().int().min(0),
})

export const registrationStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }),
  z.object({ state: z.literal('confirmed') }),
  /** Past its blockhash and never landed: signing it again cannot help, preparing anew can. */
  z.object({ state: z.literal('expired') }),
  z.object({
    state: z.literal('failed'),
    reason: z.enum(['already-registered', 'unauthorized', 'host-not-canonical', 'rejected']),
  }),
])

export type PublisherReceipt = z.output<typeof publisherReceiptSchema>
export type ReceiptsPage = z.output<typeof receiptsPageSchema>
export type PublisherSummary = z.output<typeof publisherSummarySchema>
export type SettlementEvent = z.output<typeof settlementEventSchema>
export type PublisherDomains = z.output<typeof publisherDomainsSchema>
export type RegistrationRequest = z.output<typeof registrationRequestSchema>
export type RegistrationRefusal = z.output<typeof registrationRefusalSchema>
export type PreparedRegistration = z.output<typeof preparedRegistrationSchema>
export type RegistrationStatus = z.output<typeof registrationStatusSchema>
