import { describe, expect, it } from 'vitest'
import {
  publisherReceiptSchema,
  publisherSummarySchema,
  receiptsPageSchema,
  settlementEventSchema,
} from './publisher.js'

const wireReceipt = {
  id: 'bd4fc50240c281804fab6e470b98483e4b1c6d73e228c13474a81485128e127b',
  workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
  sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
  consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
  useType: 'inference',
  tariff: '905',
  paymentMethod: 'escrow',
  acceptedAt: '2026-09-03T14:50:41.000Z',
  settledAt: '2026-09-03T14:51:00.000Z',
}

const wireSummary = {
  total: '483900',
  fee: '48390',
  count: 420,
  byWork: [
    {
      workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
      sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
      count: 420,
      total: '483900',
    },
  ],
  byConsumer: [
    {
      consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
      count: 420,
      total: '483900',
      paymentMethods: ['escrow', 'x402'],
    },
  ],
  flows: [
    {
      consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
      workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
      count: 420,
      total: '483900',
    },
  ],
  settlement: { inBatch: '400000', accrued: '3900', perRequest: '80000' },
  registeredWorks: 5,
}

describe('receiptsPageSchema', () => {
  it('turns wire money into bigint and keeps everything else as served', () => {
    const page = receiptsPageSchema.parse({ items: [wireReceipt], nextCursor: 'opaque' })
    expect(page.items[0]).toEqual({ ...wireReceipt, tariff: 905n })
    expect(page.nextCursor).toBe('opaque')
  })

  it('accepts an unsettled receipt and the last page', () => {
    const page = receiptsPageSchema.parse({
      items: [{ ...wireReceipt, settledAt: null }],
      nextCursor: null,
    })
    expect(page.items[0]?.settledAt).toBeNull()
    expect(page.nextCursor).toBeNull()
  })

  it('accepts a receipt paid per request', () => {
    const page = receiptsPageSchema.parse({
      items: [{ ...wireReceipt, paymentMethod: 'x402' }],
      nextCursor: null,
    })
    expect(page.items[0]?.paymentMethod).toBe('x402')
  })

  it('rejects a payment method the ledger does not know', () => {
    const result = receiptsPageSchema.safeParse({
      items: [{ ...wireReceipt, paymentMethod: 'card' }],
      nextCursor: null,
    })
    expect(result.success).toBe(false)
  })

  it('accepts an empty page', () => {
    expect(receiptsPageSchema.parse({ items: [], nextCursor: null }).items).toEqual([])
  })

  it('rejects money sent as a number, which loses precision past 2^53', () => {
    const result = receiptsPageSchema.safeParse({
      items: [{ ...wireReceipt, tariff: 905 }],
      nextCursor: null,
    })
    expect(result.success).toBe(false)
  })

  it('rejects identifiers and instants in a form the gateway never emits', () => {
    for (const broken of [
      { id: wireReceipt.id.toUpperCase() },
      { consumer: '0OIl-not-base58' },
      { useType: 'scrape' },
      { acceptedAt: '2026-09-03T14:50:41Z' },
      { settledAt: '2026-09-03' },
    ]) {
      const result = receiptsPageSchema.safeParse({
        items: [{ ...wireReceipt, ...broken }],
        nextCursor: null,
      })
      expect(result.success, JSON.stringify(broken)).toBe(false)
    }
  })
})

describe('publisherSummarySchema', () => {
  it('parses every amount into bigint', () => {
    const summary = publisherSummarySchema.parse(wireSummary)
    expect(summary.total).toBe(483_900n)
    expect(summary.fee).toBe(48_390n)
    expect(summary.byWork[0]?.total).toBe(483_900n)
    expect(summary.byConsumer[0]?.total).toBe(483_900n)
    expect(summary.flows[0]?.total).toBe(483_900n)
    expect(summary.settlement).toEqual({ inBatch: 400_000n, accrued: 3_900n, perRequest: 80_000n })
    expect(summary.registeredWorks).toBe(5)
  })

  it('accepts a period with nothing taken', () => {
    const empty = publisherSummarySchema.parse({
      ...wireSummary,
      total: '0',
      fee: '0',
      count: 0,
      byWork: [],
      byConsumer: [],
      flows: [],
      settlement: { inBatch: '0', accrued: '0', perRequest: '0' },
    })
    expect(empty.byConsumer).toEqual([])
  })

  it('rejects a consumer that paid by no method, or by one the ledger does not know', () => {
    const consumer = wireSummary.byConsumer[0]
    for (const paymentMethods of [[], ['card']]) {
      const result = publisherSummarySchema.safeParse({
        ...wireSummary,
        byConsumer: [{ ...consumer, paymentMethods }],
      })
      expect(result.success, JSON.stringify(paymentMethods)).toBe(false)
    }
  })

  it('rejects a summary without the settlement split', () => {
    const { settlement: _, ...partial } = wireSummary
    expect(publisherSummarySchema.safeParse(partial).success).toBe(false)
  })

  it('keeps an unread chain distinct from zero registered works', () => {
    expect(
      publisherSummarySchema.parse({ ...wireSummary, registeredWorks: null }).registeredWorks,
    ).toBeNull()
    expect(
      publisherSummarySchema.parse({ ...wireSummary, registeredWorks: 0 }).registeredWorks,
    ).toBe(0)
  })

  it('rejects a negative or fractional count', () => {
    expect(publisherSummarySchema.safeParse({ ...wireSummary, count: -1 }).success).toBe(false)
    expect(publisherSummarySchema.safeParse({ ...wireSummary, count: 1.5 }).success).toBe(false)
  })
})

describe('stream events', () => {
  it('a receipt event carries the same shape as a /receipts item', () => {
    expect(publisherReceiptSchema.parse(wireReceipt).tariff).toBe(905n)
  })

  it('a settlement event names the batch and only receipt ids', () => {
    const event = settlementEventSchema.parse({
      batchId: '2b8febf3f2cc3b7bcde03d97f17f1c30f3e97d4674b3623c2eb4111ff48416da',
      settledAt: '2026-09-03T14:51:00.000Z',
      receiptIds: [wireReceipt.id],
    })
    expect(event.receiptIds).toEqual([wireReceipt.id])
  })

  it('rejects a settlement without a settlement time', () => {
    const result = settlementEventSchema.safeParse({
      batchId: '2b8febf3f2cc3b7bcde03d97f17f1c30f3e97d4674b3623c2eb4111ff48416da',
      settledAt: null,
      receiptIds: [],
    })
    expect(result.success).toBe(false)
  })
})
