import { describe, expect, it } from 'vitest'
import recorded from './fixtures/mainnet-pyth-sol-usd.json'
import { PYTH_SOL_USD, readSolUsd, solUsdOf } from './price.js'

const PUBLISHED = new Date(1_791_195_294 * 1000)
const SECONDS = 1000

function withData(mutate: (data: Buffer) => void) {
  const data = Buffer.from(recorded.result.value.data[0] as string, 'base64')
  mutate(data)
  return {
    ...recorded,
    result: {
      ...recorded.result,
      value: { ...recorded.result.value, data: [data.toString('base64'), 'base64'] },
    },
  }
}

describe('solUsdOf', () => {
  it('reads the price, its confidence and publish time from a real Pyth account', () => {
    expect(solUsdOf(recorded, new Date(PUBLISHED.getTime() + 30 * SECONDS))).toEqual({
      usd: 120.63785291,
      confidenceUsd: 0.01136874,
      publishedAt: PUBLISHED.toISOString(),
      ageSeconds: 30,
      slot: 453_549_328,
      account: PYTH_SOL_USD.account,
      source: 'Pyth SOL/USD price update account on Solana mainnet',
    })
  })

  it('refuses an account the Pyth receiver does not own', () => {
    const forged = {
      ...recorded,
      result: {
        ...recorded.result,
        value: { ...recorded.result.value, owner: '11111111111111111111111111111111' },
      },
    }
    expect(solUsdOf(forged, PUBLISHED)).toEqual({ unavailable: 'not-a-pyth-account' })
  })

  it('refuses an update with only partial guardian verification', () => {
    const partial = withData((data) => {
      data[40] = 0
    })
    expect(solUsdOf(partial, PUBLISHED)).toEqual({ unavailable: 'partially-verified' })
  })

  it('refuses a feed other than SOL/USD', () => {
    const other = withData((data) => {
      data[41] = 0
    })
    expect(solUsdOf(other, PUBLISHED)).toEqual({ unavailable: 'other-feed' })
  })

  it('refuses a price older than an hour', () => {
    expect(solUsdOf(recorded, new Date(PUBLISHED.getTime() + 3601 * SECONDS))).toEqual({
      unavailable: 'stale',
    })
  })

  it('reports an RPC answer without the account as unavailable', () => {
    expect(
      solUsdOf({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: null } }, PUBLISHED),
    ).toEqual({
      unavailable: 'no-account',
    })
    expect(solUsdOf({ error: { code: -32005 } }, PUBLISHED)).toEqual({ unavailable: 'rpc-error' })
  })
})

describe('readSolUsd', () => {
  it('asks a mainnet node for the account and reads the answer', async () => {
    const asked: unknown[] = []
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(recorded))
    }) as typeof fetch
    const price = await readSolUsd(fetchStub, PUBLISHED)
    expect(price).toMatchObject({ usd: 120.63785291 })
    expect(asked).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [PYTH_SOL_USD.account, { encoding: 'base64', commitment: 'confirmed' }],
      },
    ])
  })

  it('turns a network failure into an unmeasured price, not a crash', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await readSolUsd(down, PUBLISHED)).toEqual({ unavailable: 'rpc-error' })
  })
})
