import { describe, expect, it } from 'vitest'
import {
  changeRequestSchema,
  preparedRegistrationSchema,
  publisherDomainsSchema,
  publisherReceiptSchema,
  publisherSummarySchema,
  publisherWorksSchema,
  receiptsPageSchema,
  registrationRequestSchema,
  registrationStatusSchema,
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

describe('registration', () => {
  it('reads a domain request with both rates as base units', () => {
    const request = registrationRequestSchema.parse({
      kind: 'domain',
      host: 'tide-notes.test',
      rateTrain: '2000',
      rateInference: '0',
    })
    expect(request).toEqual({
      kind: 'domain',
      host: 'tide-notes.test',
      rateTrain: 2000n,
      rateInference: 0n,
    })
  })

  it('keeps an inherited work rate distinct from a free one', () => {
    const request = registrationRequestSchema.parse({
      kind: 'work',
      source: 'https://tide-notes.test/a.html',
      rateTrain: null,
      rateInference: '0',
    })
    expect(request).toMatchObject({ rateTrain: null, rateInference: 0n })
  })

  it('rejects a domain without a rate, since a domain has nothing to inherit from', () => {
    const result = registrationRequestSchema.safeParse({
      kind: 'domain',
      host: 'tide-notes.test',
      rateTrain: null,
      rateInference: '500',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an absent work rate rather than reading it as inherited', () => {
    const result = registrationRequestSchema.safeParse({
      kind: 'work',
      source: 'https://tide-notes.test/a.html',
      rateTrain: '100',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown kind, an extra field and a rate that is not base units', () => {
    const domain = { kind: 'domain', host: 'tide-notes.test', rateTrain: '1', rateInference: '1' }
    for (const body of [
      { ...domain, kind: 'publisher' },
      { ...domain, owner: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T' },
      { ...domain, rateTrain: '0.5' },
      { ...domain, rateTrain: '-1' },
    ]) {
      expect(registrationRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })

  it('names why a landed transaction failed, and nothing else alongside', () => {
    expect(
      registrationStatusSchema.parse({ state: 'failed', reason: 'already-registered' }),
    ).toEqual({ state: 'failed', reason: 'already-registered' })
    expect(registrationStatusSchema.safeParse({ state: 'failed' }).success).toBe(false)
    expect(registrationStatusSchema.safeParse({ state: 'landed' }).success).toBe(false)
  })

  it('reads a prepared transaction and refuses one that is not base64', () => {
    const prepared = {
      transaction: 'AQAAAA==',
      address: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
      lastValidBlockHeight: 412_000_150,
    }
    expect(preparedRegistrationSchema.parse(prepared)).toEqual(prepared)
    expect(
      preparedRegistrationSchema.safeParse({ ...prepared, transaction: 'not base64!' }).success,
    ).toBe(false)
  })

  it("lists a wallet's domains with their rates and the number of works under each", () => {
    const listing = publisherDomainsSchema.parse({
      domains: [
        {
          address: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
          host: 'tide-notes.test',
          rateTrain: '2000',
          rateInference: '500',
          status: 'suspended',
          works: 0,
        },
      ],
    })
    expect(listing.domains[0]).toMatchObject({ rateTrain: 2000n, status: 'suspended', works: 0 })
  })
})

describe('changes', () => {
  const DOMAIN = 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp'
  const WORK = 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T'

  it('reads a domain change with both rates and the status it should end with', () => {
    expect(
      changeRequestSchema.parse({
        kind: 'domain',
        domain: DOMAIN,
        rateTrain: '3000',
        rateInference: '0',
        status: 'suspended',
      }),
    ).toEqual({
      kind: 'domain',
      domain: DOMAIN,
      rateTrain: 3000n,
      rateInference: 0n,
      status: 'suspended',
    })
  })

  it('keeps a work going back to the domain rate distinct from a free one', () => {
    const change = changeRequestSchema.parse({
      kind: 'work',
      work: WORK,
      rateTrain: null,
      rateInference: '0',
      status: 'active',
    })
    expect(change).toMatchObject({ rateTrain: null, rateInference: 0n })
  })

  it('rejects a partial change, since an absent field cannot say "leave it" apart from "clear it"', () => {
    for (const body of [
      { kind: 'work', work: WORK, rateTrain: null, rateInference: null },
      { kind: 'work', work: WORK, rateTrain: null, status: 'active' },
      { kind: 'domain', domain: DOMAIN, rateTrain: null, rateInference: '0', status: 'active' },
    ]) {
      expect(changeRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })

  it('rejects a host or source in place of an address, an extra field and an unknown status', () => {
    for (const body of [
      {
        kind: 'domain',
        domain: 'tide-notes.test',
        rateTrain: '1',
        rateInference: '1',
        status: 'active',
      },
      {
        kind: 'domain',
        domain: DOMAIN,
        rateTrain: '1',
        rateInference: '1',
        status: 'active',
        owner: WORK,
      },
      { kind: 'work', work: WORK, rateTrain: null, rateInference: null, status: 'paused' },
    ]) {
      expect(changeRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })

  it("lists a wallet's works with their own rates, and a source only where one is known", () => {
    const listing = publisherWorksSchema.parse({
      works: [
        {
          address: WORK,
          domain: DOMAIN,
          source: 'https://tide-notes.test/2026/neap-tides.html',
          rateTrain: '2500',
          rateInference: null,
          status: 'active',
        },
        {
          address: DOMAIN,
          domain: DOMAIN,
          source: null,
          rateTrain: null,
          rateInference: null,
          status: 'suspended',
        },
      ],
    })
    expect(listing.works[0]).toMatchObject({ rateTrain: 2500n, rateInference: null })
    expect(listing.works[1]?.source).toBeNull()
  })
})
