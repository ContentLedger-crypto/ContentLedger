import { describe, expect, it } from 'vitest'
import { CONSUMER, GATEWAY_URL, RECEIPT_IDS, RPC_URL, recorded, replay } from './fixtures/replay.js'
import { rpcNetwork } from './network.js'
import { gatewayPublication } from './publication.js'
import { verifyReceipt } from './verify.js'

const sourcesOver = (fetchImpl: typeof fetch) => ({
  network: rpcNetwork(RPC_URL, fetchImpl),
  publication: gatewayPublication(GATEWAY_URL, fetchImpl),
})

describe('the first live devnet batch, seq 1..4', () => {
  it.each(RECEIPT_IDS)('verifies receipt %s in all four steps', async (id) => {
    expect(await verifyReceipt(id, sourcesOver(replay()))).toEqual({
      outcome: 'verified',
      steps: {
        onchain: { status: 'pass' },
        inclusion: { status: 'pass' },
        chain: { status: 'pass' },
        amounts: { status: 'pass' },
      },
    })
  })

  it('catches one tariff rewritten in the published composition', async () => {
    const { rpc, gateway } = recorded()
    const batch = gateway[`/v1/batches/${CONSUMER}/4`] as { receipts: { tariff: string }[] }
    const first = batch.receipts[0]
    if (!first) throw new Error('composition not recorded')
    first.tariff = '1000'
    expect(await verifyReceipt(RECEIPT_IDS[3], sourcesOver(replay({ rpc, gateway })))).toEqual({
      outcome: 'rejected',
      steps: {
        onchain: { status: 'pass' },
        inclusion: { status: 'pass' },
        chain: { status: 'fail', reason: 'chain-mismatch' },
        amounts: { status: 'skipped' },
      },
    })
  })
})
