import { describe, expect, it } from 'vitest'
import { rpcPayments } from './payments.js'

const RPC = 'https://rpc.test/?api-key=secret'
const SIGNATURE = '5'.repeat(88)

const tx = {
  version: 1,
  blockTime: 1_790_936_668,
  meta: { err: null, innerInstructions: [] },
  transaction: {
    signatures: [SIGNATURE],
    message: { instructions: [], transactionConfig: {} },
  },
}

function rpcAnswering(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(body), { status })
  }
  return { payments: rpcPayments(RPC, fetchImpl), calls }
}

describe('rpcPayments', () => {
  it('asks for the parsed transaction at confirmed, up to version 1', async () => {
    const { payments, calls } = rpcAnswering({ jsonrpc: '2.0', id: 1, result: tx })
    expect(await payments.transaction(SIGNATURE)).toMatchObject({
      blockTime: 1_790_936_668,
      transaction: { signatures: [SIGNATURE] },
    })
    expect(calls).toEqual([
      {
        url: RPC,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            SIGNATURE,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
          ],
        },
      },
    ])
  })

  it('returns null for a transaction the node does not have', async () => {
    const { payments } = rpcAnswering({ jsonrpc: '2.0', id: 1, result: null })
    expect(await payments.transaction(SIGNATURE)).toBeNull()
  })

  it('throws on an RPC error rather than reading it as a missing payment', async () => {
    const { payments } = rpcAnswering({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32015, message: 'Transaction version (2) is not supported' },
    })
    await expect(payments.transaction(SIGNATURE)).rejects.toThrow(/-32015/)
  })

  it('throws on an HTTP failure without naming the endpoint', async () => {
    const { payments } = rpcAnswering({}, 429)
    const failure = payments.transaction(SIGNATURE)
    await expect(failure).rejects.toThrow(/429/)
    await expect(failure).rejects.not.toThrow(/secret/)
  })

  it('throws on an answer that is not a transaction', async () => {
    const { payments } = rpcAnswering({ jsonrpc: '2.0', id: 1, result: { meta: null } })
    await expect(payments.transaction(SIGNATURE)).rejects.toThrow()
  })
})
