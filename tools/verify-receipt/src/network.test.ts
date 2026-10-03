import { describe, expect, it } from 'vitest'
import { ESCROW, RPC_URL, recorded, replay, SETTLEMENT_LOG, TX_SIG } from './fixtures/replay.js'
import { parseSettlement, rpcNetwork } from './network.js'

const ACME_WORK = 'H69CyFEZVcbDZjTm39iekacEouzxcf2YFPPJL7CXRTpJ'
const PHOTO_WORK = 'wBwqZZUyEEXo9jntmeFitdUmgW5bnNW2togkTwurKze'
const ACME_DOMAIN = '7vqG2p2fP1H5UD8afPCvco4BDpLyViHPFNc4ofUvjdkn'
const PHOTO_DOMAIN = 'JhJTQU1S4S6S7r2wzYf3TiLhVcPBmG5gAA1SQKqUcEM'
const ROOT = '23048cac860f086b8bb0355f62adf17d58345e7eabdd9fda99b00dbaffb9a8e1'
const CHAIN = 'c97b79363e1bf4246777a316507d1eab6eb7c54d4411cbec360226d69b671fdd'

interface TokenBalance {
  accountIndex: number
  uiTokenAmount: { amount: string }
}

const SETTLED = {
  succeeded: true,
  escrow: ESCROW,
  seq: 4n,
  chain: CHAIN,
  root: ROOT,
  legs: [
    { domain: ACME_DOMAIN, tariff: 6_000n },
    { domain: PHOTO_DOMAIN, tariff: 8_000n },
  ],
  vaultDebit: 15_400n,
  treasuryCredit: 1_400n,
}

const recordedTransaction = () => {
  const transaction = recorded().rpc.getTransaction?.[TX_SIG]
  if (transaction === undefined) throw new Error('settlement transaction not recorded')
  return transaction as {
    meta: { err: unknown }
    transaction: { message: { instructions: { programIdIndex: number }[] } }
  }
}

describe('parseSettlement', () => {
  it('reads the first live devnet settlement', () => {
    expect(parseSettlement(recordedTransaction())).toEqual(SETTLED)
  })

  it('marks a transaction the cluster rejected as not succeeded', () => {
    const failed = recordedTransaction()
    failed.meta.err = { InstructionError: [1, { Custom: 6012 }] }
    expect(parseSettlement(failed)).toEqual({ ...SETTLED, succeeded: false })
  })

  it('finds no settlement in a transaction without settle_batch', () => {
    const other = recordedTransaction()
    const ED25519_PROGRAM_INDEX = 12
    other.transaction.message.instructions = other.transaction.message.instructions.filter(
      (instruction) => instruction.programIdIndex === ED25519_PROGRAM_INDEX,
    )
    expect(parseSettlement(other)).toBe(null)
  })

  it('refuses an answer that is not a transaction', () => {
    expect(() => parseSettlement({ meta: null })).toThrow()
  })
})

describe('rpcNetwork', () => {
  it('reads a settlement by its signature', async () => {
    expect(await rpcNetwork(RPC_URL, replay()).settlement(TX_SIG)).toEqual(SETTLED)
  })

  it('answers null for a signature the node does not have', async () => {
    expect(await rpcNetwork(RPC_URL, replay()).settlement('1'.repeat(88))).toBe(null)
  })

  it('reads the ring of an escrow', async () => {
    const ring = await rpcNetwork(RPC_URL, replay()).ring(ESCROW)
    expect(ring).toHaveLength(1)
    expect(ring[0]).toMatchObject({ seqEnd: 4n, root: ROOT, chain: CHAIN })
  })

  it('reads an escrow that never settled as an empty ring', async () => {
    const { rpc, gateway } = recorded()
    rpc.getAccountInfo = { [SETTLEMENT_LOG]: { context: { slot: 1 }, value: null } }
    expect(await rpcNetwork(RPC_URL, replay({ rpc, gateway })).ring(ESCROW)).toEqual([])
  })

  it('does not take a ring the program does not own', async () => {
    const { rpc, gateway } = recorded()
    const account = rpc.getAccountInfo?.[SETTLEMENT_LOG] as { value: { owner: string } }
    account.value.owner = '11111111111111111111111111111111'
    expect(await rpcNetwork(RPC_URL, replay({ rpc, gateway })).ring(ESCROW)).toEqual([])
  })

  it('maps each work to its domain', async () => {
    const domains = await rpcNetwork(RPC_URL, replay()).workDomains([ACME_WORK, PHOTO_WORK])
    expect(domains).toEqual(
      new Map([
        [ACME_WORK, ACME_DOMAIN],
        [PHOTO_WORK, PHOTO_DOMAIN],
      ]),
    )
  })

  it('leaves out a work that does not exist or that the program does not own', async () => {
    const { rpc, gateway } = recorded()
    const key = `${ACME_WORK},${PHOTO_WORK}`
    const answer = rpc.getMultipleAccounts?.[key] as { value: ({ owner: string } | null)[] }
    const photo = answer.value[1]
    if (!photo) throw new Error('photo work not recorded')
    photo.owner = '11111111111111111111111111111111'
    answer.value[0] = null
    const domains = await rpcNetwork(RPC_URL, replay({ rpc, gateway })).workDomains([
      ACME_WORK,
      PHOTO_WORK,
    ])
    expect(domains).toEqual(new Map())
  })

  it('reads the treasury credit as a difference, not as its balance after', async () => {
    const { rpc, gateway } = recorded()
    const TREASURY_INDEX = 6
    const transaction = rpc.getTransaction?.[TX_SIG]
    if (transaction === undefined) throw new Error('settlement transaction not recorded')
    const { meta } = transaction as { meta: Record<string, TokenBalance[]> }
    for (const [list, amount] of [
      ['preTokenBalances', '500'],
      ['postTokenBalances', '1900'],
    ] as const) {
      const entry = meta[list]?.find((balance) => balance.accountIndex === TREASURY_INDEX)
      if (!entry) throw new Error('treasury balance not recorded')
      entry.uiTokenAmount.amount = amount
    }
    const settlement = await rpcNetwork(RPC_URL, replay({ rpc, gateway })).settlement(TX_SIG)
    expect(settlement?.treasuryCredit).toBe(1_400n)
  })

  it('surfaces an RPC error instead of reading it as absence', async () => {
    const failing: typeof fetch = async () =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } })
    await expect(rpcNetwork(RPC_URL, failing).settlement(TX_SIG)).rejects.toThrow(/rate limited/)
  })

  it('surfaces an HTTP failure', async () => {
    const failing: typeof fetch = async () => new Response('busy', { status: 429 })
    await expect(rpcNetwork(RPC_URL, failing).ring(ESCROW)).rejects.toThrow(/HTTP 429/)
  })
})
