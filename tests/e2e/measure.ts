import { z } from 'zod'
import { creditsOf, type LaneUsage } from './rpc-meter.js'

export type Verdict = 'pass' | 'fail' | 'unmeasured'

/** SC-002. */
export const LATENCY_BUDGET_MS = 3_000
/** SC-001: a tenth of a cent. */
export const COST_BUDGET_USD = 0.001
/** SC-006. */
export const MIN_REFUSAL_ATTEMPTS = 50
/** SC-008: Helius Free. */
export const FREE_MONTHLY_CREDITS = 1_000_000

const LAMPORTS_PER_SOL = 1_000_000_000

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('no samples to take a percentile of')
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(rank, 1) - 1] as number
}

export function latencySummary(samplesMs: readonly number[]) {
  const p95 = percentile(samplesMs, 95)
  return {
    count: samplesMs.length,
    p50: percentile(samplesMs, 50),
    p95,
    max: percentile(samplesMs, 100),
    verdict: (p95 < LATENCY_BUDGET_MS ? 'pass' : 'fail') as Verdict,
  }
}

const tokenBalance = z.object({
  accountIndex: z.number().int(),
  mint: z.string(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
})

const accountKey = z.union([
  z.string(),
  z.object({ pubkey: z.string() }).transform((k) => k.pubkey),
])

const txSchema = z.object({
  meta: z.object({
    fee: z.number().int(),
    preBalances: z.array(z.number()),
    postBalances: z.array(z.number()),
    preTokenBalances: z.array(tokenBalance),
    postTokenBalances: z.array(tokenBalance),
    loadedAddresses: z
      .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
      .optional(),
  }),
  transaction: z.object({ message: z.object({ accountKeys: z.array(accountKey) }) }),
})

/** Token account → what it gained (positive) or lost in one transaction, for one mint. */
export type TokenFlows = Map<string, bigint>

export function tokenFlows(transaction: unknown, mint: string): TokenFlows {
  const { meta, transaction: tx } = txSchema.parse(transaction)
  // A v0 transaction appends its loaded addresses after the static keys, writable first.
  const keys = [
    ...tx.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ]
  const flows: TokenFlows = new Map()
  const add = (index: number, amount: bigint) => {
    const key = keys[index]
    if (key === undefined)
      throw new Error(`token balance names account ${index}, which is not there`)
    flows.set(key, (flows.get(key) ?? 0n) + amount)
  }
  // An account the transaction created has no balance before it, which reads as zero.
  for (const b of meta.preTokenBalances)
    if (b.mint === mint) add(b.accountIndex, -BigInt(b.uiTokenAmount.amount))
  for (const b of meta.postTokenBalances)
    if (b.mint === mint) add(b.accountIndex, BigInt(b.uiTokenAmount.amount))
  for (const [key, amount] of flows) if (amount === 0n) flows.delete(key)
  return flows
}

/** What the fee payer spent: the network fee, and apart from it rent locked in new accounts. */
export function txCost(transaction: unknown): { feeLamports: number; rentLamports: number } {
  const { meta } = txSchema.parse(transaction)
  const spent = (meta.preBalances[0] ?? 0) - (meta.postBalances[0] ?? 0)
  return { feeLamports: meta.fee, rentLamports: spent - meta.fee }
}

/**
 * SC-005 over the money that moved, not over balances: other agents settle into the same
 * publisher accounts during a run, so only this run's own transactions are summed.
 */
export function reconcile(args: {
  charged: readonly { tariff: bigint; fee: bigint }[]
  flows: readonly TokenFlows[]
  /** The escrow vault and the agent's own token account: where the money left from. */
  payers: ReadonlySet<string>
  treasury: string
}) {
  const sum = (values: Iterable<bigint>) => {
    let total = 0n
    for (const value of values) total += value
    return total
  }
  const tariffsCharged = sum(args.charged.map((c) => c.tariff))
  const feesCharged = sum(args.charged.map((c) => c.fee))
  let paidOut = 0n
  let payerOutflow = 0n
  let feesPaid = 0n
  let conserved = true
  for (const flows of args.flows) {
    if (sum(flows.values()) !== 0n) conserved = false
    for (const [account, amount] of flows) {
      if (args.payers.has(account)) payerOutflow -= amount
      else if (amount < 0n) conserved = false
      else paidOut += amount
      if (account === args.treasury) feesPaid += amount
    }
  }
  const charged = tariffsCharged + feesCharged
  const discrepancy = charged - paidOut
  const verdict: Verdict =
    conserved && discrepancy === 0n && payerOutflow === charged && feesPaid === feesCharged
      ? 'pass'
      : 'fail'
  return {
    charged,
    paidOut,
    payerOutflow,
    tariffs: { charged: tariffsCharged, paidOut: paidOut - feesPaid },
    fees: { charged: feesCharged, paidOut: feesPaid },
    discrepancy,
    verdict,
  }
}

export function costVerdict(lamportsPerRequest: number, solUsd: number | null) {
  const breakEvenUsdPerSol = (COST_BUDGET_USD * LAMPORTS_PER_SOL) / lamportsPerRequest
  if (solUsd === null) {
    return {
      lamportsPerRequest,
      breakEvenUsdPerSol,
      costUsd: null,
      verdict: 'unmeasured' as Verdict,
    }
  }
  const costUsd = (lamportsPerRequest / LAMPORTS_PER_SOL) * solUsd
  return {
    lamportsPerRequest,
    breakEvenUsdPerSol,
    costUsd,
    verdict: (costUsd < COST_BUDGET_USD ? 'pass' : 'fail') as Verdict,
  }
}

export interface Attempt {
  kind: string
  status: number
  delivered: boolean
}

export function refusalVerdict(attempts: readonly Attempt[]) {
  const byKind: Record<string, number> = {}
  for (const { kind } of attempts) byKind[kind] = (byKind[kind] ?? 0) + 1
  const delivered = attempts.filter((a) => a.delivered).length
  return {
    attempts: attempts.length,
    delivered,
    byKind,
    verdict: (attempts.length >= MIN_REFUSAL_ATTEMPTS && delivered === 0
      ? 'pass'
      : 'fail') as Verdict,
  }
}

export function rpcVerdict(
  usage: Readonly<Record<string, LaneUsage>>,
  productLanes: readonly string[],
  requests: number,
) {
  const credits: Record<string, number> = {}
  for (const [lane, laneUsage] of Object.entries(usage)) credits[lane] = creditsOf(laneUsage)
  const productCredits = productLanes.reduce((sum, lane) => sum + (credits[lane] ?? 0), 0)
  return {
    credits,
    productCredits,
    creditsPerRequest: productCredits / requests,
    sessionsPerFreeMonth: Math.floor(FREE_MONTHLY_CREDITS / productCredits),
    verdict: (productCredits < FREE_MONTHLY_CREDITS ? 'pass' : 'fail') as Verdict,
  }
}
