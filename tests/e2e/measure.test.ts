import { describe, expect, it } from 'vitest'
import recording from '../../tools/verify-receipt/src/fixtures/devnet-batch-1-4.json'
import {
  costVerdict,
  latencySummary,
  percentile,
  reconcile,
  refusalVerdict,
  rpcVerdict,
  type TokenFlows,
  tokenFlows,
  txCost,
} from './measure.js'

const MINT = 'F2snBajNcBXZ6GheR5LPhMvc9Ai2vG9uGweXrciNM1oF'
// The first live settle_batch on devnet: seq 1..4, four receipts at 2000 + 200 each.
const settle = Object.values(recording.rpc.getTransaction)[0]
const VAULT = '8RcQoscYwVibz9VePmGjKpvH95uqHkqBwxqGQPh7xGw'
const TREASURY = 'HM8EYSNJMxvfrpi1FM31BPpCbgd3p2zbEd9K9re4WgwZ'
const ACME = 'EhVTAeisM7wGmDn4KwmVRSE9bXYfEGif39VyYrUypKVA'
const KYIV = 'H4g3tncAE1YGyHAwCB16SGxghVPK4etZgUE3K3e7tH2b'
const SETTLED_RECEIPTS = [
  { tariff: 2000n, fee: 200n },
  { tariff: 2000n, fee: 200n },
  { tariff: 2000n, fee: 200n },
  { tariff: 8000n, fee: 800n },
]

/** An x402 payment as getTransaction returns it in jsonParsed: account keys are objects. */
function x402Payment(agentAta: string, legs: Record<string, bigint>, fee = 5000) {
  const keys = ['Payer1111111111111111111111111111111111111', agentAta, ...Object.keys(legs)]
  const total = Object.values(legs).reduce((sum, amount) => sum + amount, 0n)
  const balance = (index: number, amount: bigint) => ({
    accountIndex: index,
    mint: MINT,
    uiTokenAmount: { amount: amount.toString(), decimals: 6 },
  })
  return {
    meta: {
      err: null,
      fee,
      preBalances: [1_000_000, 2_039_280, ...Object.keys(legs).map(() => 2_039_280)],
      postBalances: [1_000_000 - fee, 2_039_280, ...Object.keys(legs).map(() => 2_039_280)],
      preTokenBalances: [
        balance(1, 50_000n),
        ...Object.keys(legs).map((_, i) => balance(i + 2, 0n)),
      ],
      postTokenBalances: [
        balance(1, 50_000n - total),
        ...Object.values(legs).map((amount, i) => balance(i + 2, amount)),
      ],
    },
    transaction: {
      message: { accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: true })) },
    },
  }
}

describe('percentile', () => {
  it('takes the nearest rank, so p95 of 100 samples is the fifth worst', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(samples, 95)).toBe(95)
    expect(percentile(samples, 50)).toBe(50)
    expect(percentile(samples, 100)).toBe(100)
  })

  it('does not depend on the order samples arrived in', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20)
  })

  it('refuses an empty sample instead of inventing a latency', () => {
    expect(() => percentile([], 95)).toThrow(/no samples/)
  })
})

describe('latencySummary', () => {
  it('passes under three seconds at p95 and fails at it', () => {
    const fast = Array.from({ length: 20 }, () => 400)
    expect(latencySummary(fast)).toEqual({
      count: 20,
      p50: 400,
      p95: 400,
      max: 400,
      verdict: 'pass',
    })
    const slow = [...Array.from({ length: 18 }, () => 400), 3000, 3000]
    expect(latencySummary(slow).verdict).toBe('fail')
  })
})

describe('tokenFlows', () => {
  it('reads what each account of the mint gained or lost in a real settle_batch', () => {
    expect(tokenFlows(settle, MINT)).toEqual(
      new Map([
        [VAULT, -15_400n],
        [ACME, 6_000n],
        [KYIV, 8_000n],
        [TREASURY, 1_400n],
      ]),
    )
  })

  it('reads jsonParsed account keys and ignores other mints', () => {
    const payment = x402Payment('AgentAta111111111111111111111111111111111111', {
      Publisher111111111111111111111111111111111: 2_001n,
      [TREASURY]: 201n,
    })
    payment.meta.postTokenBalances.push({
      accountIndex: 0,
      mint: 'OtherMint1111111111111111111111111111111111',
      uiTokenAmount: { amount: '7', decimals: 0 },
    })
    expect(tokenFlows(payment, MINT)).toEqual(
      new Map([
        ['AgentAta111111111111111111111111111111111111', -2_202n],
        ['Publisher111111111111111111111111111111111', 2_001n],
        [TREASURY, 201n],
      ]),
    )
  })

  it('leaves out accounts of the mint whose balance did not move', () => {
    const payment = x402Payment('AgentAta111111111111111111111111111111111111', { [TREASURY]: 1n })
    payment.meta.preTokenBalances.push({
      accountIndex: 0,
      mint: MINT,
      uiTokenAmount: { amount: '5', decimals: 6 },
    })
    payment.meta.postTokenBalances.push({
      accountIndex: 0,
      mint: MINT,
      uiTokenAmount: { amount: '5', decimals: 6 },
    })
    expect([...tokenFlows(payment, MINT).keys()]).not.toContain(
      'Payer1111111111111111111111111111111111111',
    )
  })

  it('finds accounts a v0 transaction loaded from a lookup table, writable before readonly', () => {
    const payment = x402Payment('AgentAta111111111111111111111111111111111111', {
      [TREASURY]: 1n,
    })
    const loaded = {
      ...payment,
      meta: {
        ...payment.meta,
        loadedAddresses: {
          writable: ['Loaded1111111111111111111111111111111111111'],
          readonly: [],
        },
        preTokenBalances: [
          ...payment.meta.preTokenBalances,
          { accountIndex: 3, mint: MINT, uiTokenAmount: { amount: '0', decimals: 6 } },
        ],
        postTokenBalances: [
          ...payment.meta.postTokenBalances,
          { accountIndex: 3, mint: MINT, uiTokenAmount: { amount: '4', decimals: 6 } },
        ],
      },
    }
    expect(tokenFlows(loaded, MINT).get('Loaded1111111111111111111111111111111111111')).toBe(4n)
  })

  it('rejects something that is not a transaction', () => {
    expect(() => tokenFlows({ meta: null }, MINT)).toThrow()
  })
})

describe('txCost', () => {
  it('separates the network fee from rent the payer put into new accounts', () => {
    // The first batch of a consumer also creates its SettlementLog ring and two payout ATAs.
    expect(txCost(settle)).toEqual({ feeLamports: 10_000, rentLamports: 52_638_960 })
  })

  it('reports no rent when the payer paid only the fee', () => {
    const payment = x402Payment('AgentAta111111111111111111111111111111111111', { [TREASURY]: 1n })
    expect(txCost(payment)).toEqual({ feeLamports: 5_000, rentLamports: 0 })
  })
})

describe('reconcile', () => {
  const payers = new Set([VAULT, 'AgentAta111111111111111111111111111111111111'])

  it('finds zero discrepancy when payouts equal what receipts charged, fee and tariff apart', () => {
    const payment = x402Payment('AgentAta111111111111111111111111111111111111', {
      Publisher111111111111111111111111111111111: 2_001n,
      [TREASURY]: 201n,
    })
    const result = reconcile({
      charged: [...SETTLED_RECEIPTS, { tariff: 2_001n, fee: 201n }],
      flows: [tokenFlows(settle, MINT), tokenFlows(payment, MINT)],
      payers,
      treasury: TREASURY,
    })
    expect(result).toEqual({
      charged: 17_602n,
      paidOut: 17_602n,
      payerOutflow: 17_602n,
      tariffs: { charged: 16_001n, paidOut: 16_001n },
      fees: { charged: 1_601n, paidOut: 1_601n },
      discrepancy: 0n,
      verdict: 'pass',
    })
  })

  it('fails on a single base unit missing from the payouts', () => {
    const result = reconcile({
      charged: [...SETTLED_RECEIPTS, { tariff: 1n, fee: 0n }],
      flows: [tokenFlows(settle, MINT)],
      payers,
      treasury: TREASURY,
    })
    expect(result.discrepancy).toBe(1n)
    expect(result.verdict).toBe('fail')
  })

  it('fails when the total matches but the treasury took a publisher unit', () => {
    const shifted: TokenFlows = new Map([
      [VAULT, -15_400n],
      [ACME, 5_999n],
      [KYIV, 8_000n],
      [TREASURY, 1_401n],
    ])
    const result = reconcile({
      charged: SETTLED_RECEIPTS,
      flows: [shifted],
      payers,
      treasury: TREASURY,
    })
    expect(result.discrepancy).toBe(0n)
    expect(result.fees).toEqual({ charged: 1_400n, paidOut: 1_401n })
    expect(result.verdict).toBe('fail')
  })

  it('fails when a transaction creates or destroys tokens of the mint', () => {
    const minted: TokenFlows = new Map([
      [VAULT, -15_400n],
      [ACME, 6_000n],
      [KYIV, 8_001n],
      [TREASURY, 1_400n],
    ])
    expect(
      reconcile({ charged: SETTLED_RECEIPTS, flows: [minted], payers, treasury: TREASURY }).verdict,
    ).toBe('fail')
  })

  it('fails when one transaction mints what another burns, though the totals agree', () => {
    const minting: TokenFlows = new Map([
      [VAULT, -2_200n],
      [ACME, 2_001n],
      [TREASURY, 200n],
    ])
    const burning: TokenFlows = new Map([
      [VAULT, -13_200n],
      [ACME, 3_999n],
      [KYIV, 8_000n],
      [TREASURY, 1_200n],
    ])
    expect(
      reconcile({
        charged: SETTLED_RECEIPTS,
        flows: [minting, burning],
        payers,
        treasury: TREASURY,
      }).verdict,
    ).toBe('fail')
  })

  it('fails when a publisher account pays out instead of being paid', () => {
    const clawedBack: TokenFlows = new Map([
      [VAULT, -15_400n],
      [ACME, 6_000n],
      [KYIV, 8_001n],
      ['Elsewhere11111111111111111111111111111111111', -1n],
      [TREASURY, 1_400n],
    ])
    expect(
      reconcile({ charged: SETTLED_RECEIPTS, flows: [clawedBack], payers, treasury: TREASURY })
        .verdict,
    ).toBe('fail')
  })
})

describe('costVerdict', () => {
  it('names the SOL price at which a request reaches a tenth of a cent', () => {
    expect(costVerdict(5_000, 150)).toEqual({
      lamportsPerRequest: 5_000,
      breakEvenUsdPerSol: 200,
      costUsd: 0.00075,
      verdict: 'pass',
    })
    expect(costVerdict(5_000, 250).verdict).toBe('fail')
  })

  it('still gives the break-even when no live price could be had', () => {
    expect(costVerdict(200, null)).toEqual({
      lamportsPerRequest: 200,
      breakEvenUsdPerSol: 5_000,
      costUsd: null,
      verdict: 'unmeasured',
    })
  })
})

describe('refusalVerdict', () => {
  const refused = (kind: string) => ({ kind, status: 400, delivered: false })

  it('passes at fifty refusals out of fifty', () => {
    expect(refusalVerdict(Array.from({ length: 50 }, () => refused('replayed-voucher')))).toEqual({
      attempts: 50,
      delivered: 0,
      byKind: { 'replayed-voucher': 50 },
      verdict: 'pass',
    })
  })

  it('fails on one delivery, and on fewer than fifty attempts', () => {
    const one = [
      ...Array.from({ length: 59 }, () => refused('no-proof')),
      { kind: 'forged', status: 200, delivered: true },
    ]
    expect(refusalVerdict(one).verdict).toBe('fail')
    expect(refusalVerdict(Array.from({ length: 49 }, () => refused('no-proof'))).verdict).toBe(
      'fail',
    )
  })
})

describe('rpcVerdict', () => {
  it('counts only the product lanes against the free month, the harness apart', () => {
    const result = rpcVerdict(
      {
        gateway: {
          calls: { getMultipleAccounts: 2_000, getTransaction: 120 },
          wsConnections: 0,
          wsBytes: 0,
        },
        settler: { calls: { sendTransaction: 20 }, wsConnections: 3, wsBytes: 250_000 },
        agent: { calls: { getLatestBlockhash: 1 }, wsConnections: 1, wsBytes: 1_000 },
        harness: { calls: { getTransaction: 500 }, wsConnections: 0, wsBytes: 0 },
      },
      ['gateway', 'settler', 'agent'],
      1_000,
    )
    expect(result).toMatchObject({
      credits: { gateway: 2_120, settler: 29, agent: 4, harness: 500 },
      productCredits: 2_153,
      creditsPerRequest: 2.153,
      sessionsPerFreeMonth: 464,
      verdict: 'pass',
    })
  })
})
