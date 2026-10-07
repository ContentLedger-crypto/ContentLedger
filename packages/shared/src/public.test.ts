import { describe, expect, it } from 'vitest'
import { publicBatchSchema, publicReceiptSchema } from './public.js'

const TX_SIG =
  'U7kAUVNnP6cCjvyAV9P9i6PqJcmnrHZeP8hmrFhvnXS27F3awFVYB2Acx8FfKUTDAaK9JCEycor6BzmZmxEdrwL7'
const CONSUMER = 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T'

const body = {
  consumer: CONSUMER,
  work: '2hDmkNfqjBbCWDLM4XG1Rjp3trPYNuGCSJV25dnaDucT',
  useType: 'inference',
  tariff: '905',
  fee: '91',
  rateLevel: 'work',
  servedHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
  registryHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
  acceptedAt: '2026-09-03T14:50:41.000Z',
  paymentMethod: 'escrow',
  seq: 1742,
} as const

const batchAnchor = {
  kind: 'batch',
  consumer: CONSUMER,
  seqTo: 1742,
  root: '2b8febf3f2cc3b7bcde03d97f17f1c30f3e97d4674b3623c2eb4111ff48416da',
  txSig: TX_SIG,
  settledAt: '2026-09-03T14:51:00.000Z',
  path: [
    { hash: '84cf0501f86a94c50718204d966badc623ff87330f3a5cf2159be9c323a9aad7', side: 'left' },
  ],
}

const wireReceipt = {
  id: 'f3c564b7d2455de487166eecde3a1571a53a6fba57658386350ae82dad53fd29',
  ...body,
  hashMatch: true,
  anchor: batchAnchor,
}

describe('publicReceiptSchema', () => {
  it('cuts the signed body out from beside the id, the match and the anchor', () => {
    const receipt = publicReceiptSchema.parse(wireReceipt)
    expect(receipt).toEqual({
      id: wireReceipt.id,
      hashMatch: true,
      anchor: batchAnchor,
      body,
    })
  })

  it('reads the pending and payment anchors', () => {
    expect(
      publicReceiptSchema.parse({ ...wireReceipt, anchor: { kind: 'pending' } }).anchor,
    ).toEqual({ kind: 'pending' })
    const { seq: _seq, ...issued } = body
    const x402 = { ...issued, paymentMethod: 'x402', paymentRef: TX_SIG }
    const receipt = publicReceiptSchema.parse({
      id: wireReceipt.id,
      ...x402,
      hashMatch: true,
      anchor: { kind: 'payment', paymentRef: TX_SIG },
    })
    expect(receipt.body).toEqual(x402)
    expect(receipt.anchor).toEqual({ kind: 'payment', paymentRef: TX_SIG })
  })

  it('refuses a body carrying a field the signed form does not have', () => {
    expect(() => publicReceiptSchema.parse({ ...wireReceipt, discount: '100' })).toThrow()
  })

  it('refuses an anchor of a kind it does not know, or a path step that is not a digest', () => {
    expect(() =>
      publicReceiptSchema.parse({ ...wireReceipt, anchor: { kind: 'promised' } }),
    ).toThrow()
    expect(() =>
      publicReceiptSchema.parse({
        ...wireReceipt,
        anchor: { ...batchAnchor, path: [{ hash: 'ABC', side: 'left' }] },
      }),
    ).toThrow()
  })
})

describe('publicBatchSchema', () => {
  const wireBatch = {
    consumer: CONSUMER,
    seqFrom: 1742,
    seqTo: 1742,
    root: batchAnchor.root,
    chain: 'baf3324d17be332cd5eefa21d8235b00c0151d46a86cf1995b04444dbf7f7d1c',
    txSig: TX_SIG,
    publishedAt: '2026-09-03T14:51:00.000Z',
    previous: { seqTo: 1741, txSig: TX_SIG },
    receipts: [body],
  }

  it('reads a composition with its pointer to the previous batch', () => {
    expect(publicBatchSchema.parse(wireBatch)).toEqual(wireBatch)
    expect(publicBatchSchema.parse({ ...wireBatch, previous: null }).previous).toBe(null)
  })

  it('refuses a composition holding a body that is not a signed one', () => {
    expect(() =>
      publicBatchSchema.parse({ ...wireBatch, receipts: [{ ...body, hashMatch: true }] }),
    ).toThrow()
  })
})
