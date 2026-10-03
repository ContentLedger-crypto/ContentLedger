import { describe, expect, it } from 'vitest'
import { CONSUMER, GATEWAY_URL, RECEIPT_IDS, recorded, replay, TX_SIG } from './fixtures/replay.js'
import { gatewayPublication } from './publication.js'

const [FIRST, , , PHOTO] = RECEIPT_IDS
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('gatewayPublication', () => {
  it('reads a batch-anchored receipt as its signed body, the batch and the path', async () => {
    const published = await gatewayPublication(GATEWAY_URL, replay()).receipt(PHOTO)
    expect(published?.body).toMatchObject({ seq: 4, tariff: '8000', paymentMethod: 'escrow' })
    expect(published?.body).not.toHaveProperty('hashMatch')
    expect(published?.anchor).toMatchObject({ kind: 'batch', seqTo: 4, txSig: TX_SIG })
    if (published?.anchor.kind !== 'batch') throw new Error('expected a batch anchor')
    expect(published.anchor.path.map(({ hash, side }) => [hex(hash), side])).toEqual([
      ['f1bcf087c87977233182f3333585929479ab614be6a5f365b12080e44053d8f9', 'left'],
      ['508844dae422dbe35b2bc59c523aebb59f95ae2dde06c9008d6d5053a466b26c', 'left'],
    ])
  })

  it('reads a batch composition with its pointer to the previous batch', async () => {
    const batch = await gatewayPublication(GATEWAY_URL, replay()).batch(CONSUMER, 4)
    expect(batch).toMatchObject({ consumer: CONSUMER, seqFrom: 1, seqTo: 4, previous: null })
    expect(
      batch?.receipts.map((receipt) => receipt.paymentMethod === 'escrow' && receipt.seq),
    ).toEqual([1, 2, 3, 4])
  })

  it('answers null for a receipt or a batch the gateway does not know', async () => {
    const publication = gatewayPublication(GATEWAY_URL, replay())
    expect(await publication.receipt('ab'.repeat(32))).toBe(null)
    expect(await publication.batch(CONSUMER, 9)).toBe(null)
  })

  it('reads the pending and payment anchors', async () => {
    const { rpc, gateway } = recorded()
    const answer = gateway[`/v1/receipts/${FIRST}`] as Record<string, unknown>
    gateway[`/v1/receipts/${FIRST}`] = { ...answer, anchor: { kind: 'pending' } }
    const publication = gatewayPublication(GATEWAY_URL, replay({ rpc, gateway }))
    expect((await publication.receipt(FIRST))?.anchor).toEqual({ kind: 'pending' })

    gateway[`/v1/receipts/${FIRST}`] = {
      ...answer,
      anchor: { kind: 'payment', paymentRef: TX_SIG },
    }
    expect((await publication.receipt(FIRST))?.anchor).toEqual({
      kind: 'payment',
      paymentRef: TX_SIG,
    })
  })

  it('refuses a body carrying a field the signed form does not have', async () => {
    const { rpc, gateway } = recorded()
    const answer = gateway[`/v1/receipts/${FIRST}`] as Record<string, unknown>
    gateway[`/v1/receipts/${FIRST}`] = { ...answer, discount: '100' }
    await expect(
      gatewayPublication(GATEWAY_URL, replay({ rpc, gateway })).receipt(FIRST),
    ).rejects.toThrow()
  })

  it('surfaces a gateway failure instead of reading it as absence', async () => {
    const failing: typeof fetch = async () => new Response('boom', { status: 500 })
    await expect(gatewayPublication(GATEWAY_URL, failing).receipt(FIRST)).rejects.toThrow(
      /HTTP 500/,
    )
  })
})
