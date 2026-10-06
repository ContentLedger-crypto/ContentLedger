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
  total: '4246900',
  count: 3536,
  byWork: [
    {
      workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
      sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
      count: 420,
      total: '483900',
    },
  ],
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
  it('parses totals into bigint', () => {
    const summary = publisherSummarySchema.parse(wireSummary)
    expect(summary.total).toBe(4_246_900n)
    expect(summary.byWork[0]?.total).toBe(483_900n)
    expect(summary.registeredWorks).toBe(5)
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
