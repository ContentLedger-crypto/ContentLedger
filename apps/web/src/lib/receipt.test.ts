import { type PublicReceipt, receiptId } from '@contentledger/shared'
import { describe, expect, it } from 'vitest'
import { type PublicationSource, sampleOpening, samplePublication } from './api'
import { readReceipt } from './receipt'

const signal = new AbortController().signal
const TX_SIG =
  'U7kAUVNnP6cCjvyAV9P9i6PqJcmnrHZeP8hmrFhvnXS27F3awFVYB2Acx8FfKUTDAaK9JCEycor6BzmZmxEdrwL7'

async function sampleReceipt(): Promise<PublicReceipt> {
  const receipt = await samplePublication.receipt(sampleOpening.id, signal)
  if (receipt === null) throw new Error('the sample receipt is missing')
  return receipt
}

const serving = (receipt: PublicReceipt | null): PublicationSource => ({
  receipt: async () => receipt,
  batch: samplePublication.batch,
})

describe('readReceipt', () => {
  it('reads a settled receipt with the facts of its batch', async () => {
    const view = await readReceipt(samplePublication, sampleOpening.id, signal)
    if (view.kind !== 'batch') throw new Error(`read as ${view.kind}`)
    expect(view.receipt.id).toBe(sampleOpening.id)
    expect(view.batch).toMatchObject({ seqFrom: 1, seqTo: 42, count: 42 })
    // 14 vouchers at each of 905 + 91, 500 + 50 and 1500 + 150.
    expect(view.batch.charged).toBe(14n * (996n + 550n + 1650n))
    expect(view.batch.chain).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads a pending receipt and an x402 one without asking for a batch', async () => {
    const receipt = await sampleReceipt()
    const noBatch: PublicationSource = {
      receipt: async () => ({ ...receipt, anchor: { kind: 'pending' } }),
      batch: () => Promise.reject(new Error('asked for a batch')),
    }
    expect((await readReceipt(noBatch, receipt.id, signal)).kind).toBe('pending')

    const { seq: _seq, ...issued } = receipt.body as Extract<
      PublicReceipt['body'],
      { paymentMethod: 'escrow' }
    >
    const body = { ...issued, paymentMethod: 'x402' as const, paymentRef: TX_SIG }
    const x402: PublicationSource = {
      ...noBatch,
      receipt: async () => ({
        ...receipt,
        id: receiptId(body),
        body,
        anchor: { kind: 'payment', paymentRef: TX_SIG },
      }),
    }
    expect(await readReceipt(x402, receiptId(body), signal)).toMatchObject({
      kind: 'payment',
      paymentRef: TX_SIG,
    })
  })

  it('says unknown when the gateway has no such receipt', async () => {
    expect(await readReceipt(samplePublication, 'ab'.repeat(32), signal)).toEqual({
      kind: 'unknown',
    })
  })

  it('shows nothing of a body that does not hash to the id asked about', async () => {
    const receipt = await sampleReceipt()
    const altered = serving({ ...receipt, body: { ...receipt.body, tariff: '1' } })
    expect(await readReceipt(altered, receipt.id, signal)).toEqual({ kind: 'tampered' })

    const another = serving(receipt)
    expect(await readReceipt(another, 'cd'.repeat(32), signal)).toEqual({ kind: 'tampered' })
  })

  it('fails when the gateway anchors a receipt to a batch it does not publish', async () => {
    const receipt = await sampleReceipt()
    const orphan: PublicationSource = { receipt: async () => receipt, batch: async () => null }
    await expect(readReceipt(orphan, receipt.id, signal)).rejects.toThrow(/does not publish/)
  })
})
