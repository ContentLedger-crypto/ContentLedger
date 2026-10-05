import { z } from 'zod'

/**
 * Pyth's sponsored SOL/USD push feed on Solana mainnet. Hermes, the HTTP route to the same
 * prices, needs an API key since August 2026; the account needs none, and it is what
 * programs on Solana read — guardian-verified, so its word rests on chain data only.
 */
export const PYTH_SOL_USD = {
  account: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
  receiver: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
  feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  rpc: 'https://api.mainnet-beta.solana.com',
} as const

const PRICE_UPDATE_V2 = '22f123639d7ef4cd'
const MAX_AGE_SECONDS = 3600

export interface SolUsd {
  usd: number
  confidenceUsd: number
  publishedAt: string
  ageSeconds: number
  slot: number
  account: string
  source: string
}

export type Unavailable = {
  unavailable:
    | 'rpc-error'
    | 'no-account'
    | 'not-a-pyth-account'
    | 'partially-verified'
    | 'other-feed'
    | 'stale'
}

const answerSchema = z.object({
  result: z.object({
    value: z
      .object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) })
      .nullable(),
  }),
})

export function solUsdOf(answer: unknown, now: Date): SolUsd | Unavailable {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) return { unavailable: 'rpc-error' }
  const account = parsed.data.result.value
  if (account === null) return { unavailable: 'no-account' }
  const data = Buffer.from(account.data[0], 'base64')
  if (
    account.owner !== PYTH_SOL_USD.receiver ||
    data.subarray(0, 8).toString('hex') !== PRICE_UPDATE_V2
  ) {
    return { unavailable: 'not-a-pyth-account' }
  }
  // PriceUpdateV2: discriminator, write authority, then VerificationLevel — Partial carries
  // a signature count after its tag, Full does not.
  let offset = 8 + 32
  if (data[offset] !== 1) return { unavailable: 'partially-verified' }
  offset += 1
  if (data.subarray(offset, offset + 32).toString('hex') !== PYTH_SOL_USD.feedId) {
    return { unavailable: 'other-feed' }
  }
  offset += 32
  const price = data.readBigInt64LE(offset)
  const conf = data.readBigUInt64LE(offset + 8)
  const exponent = data.readInt32LE(offset + 16)
  const publishTime = Number(data.readBigInt64LE(offset + 20))
  const slot = Number(data.readBigUInt64LE(offset + 52))
  const ageSeconds = Math.round(now.getTime() / 1000 - publishTime)
  if (ageSeconds > MAX_AGE_SECONDS) return { unavailable: 'stale' }
  const scale = (value: bigint) => Number(value) * 10 ** exponent
  return {
    usd: scale(price),
    confidenceUsd: scale(conf),
    publishedAt: new Date(publishTime * 1000).toISOString(),
    ageSeconds,
    slot,
    account: PYTH_SOL_USD.account,
    source: 'Pyth SOL/USD price update account on Solana mainnet',
  }
}

export async function readSolUsd(fetchFn: typeof fetch, now: Date): Promise<SolUsd | Unavailable> {
  try {
    const res = await fetchFn(PYTH_SOL_USD.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [PYTH_SOL_USD.account, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    })
    return solUsdOf(await res.json(), now)
  } catch {
    return { unavailable: 'rpc-error' }
  }
}
