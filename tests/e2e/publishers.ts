import { percentile, type TokenFlows, type Verdict } from './measure.js'

/** SC-003. */
export const ARRIVAL_BUDGET_MS = 5_000
/** SC-004. */
export const PUBLISHERS = 3

/** A receipt the run's agent was given, and the publisher whose work it paid for. */
export interface Issued {
  id: string
  owner: string
  acceptedAt: string
  tariff: bigint
}

/** Publisher → receipt id → when its row appeared in that publisher's window, epoch ms. */
export type Sightings = ReadonlyMap<string, ReadonlyMap<string, number>>

const byOwner = (issued: readonly Issued[]) => {
  const groups = new Map<string, Issued[]>()
  for (const receipt of issued)
    groups.set(receipt.owner, [...(groups.get(receipt.owner) ?? []), receipt])
  return groups
}

const spread = (samples: readonly number[]) =>
  samples.length === 0
    ? null
    : {
        count: samples.length,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        max: percentile(samples, 100),
      }

/**
 * SC-003, timed on one clock: the gateway stamps acceptedAt and the browser notes the row on
 * the same machine, so a row seen before it was accepted means the clocks are not one.
 */
export function arrivalVerdict(issued: readonly Issued[], seen: Sightings) {
  const byPublisher: Record<
    string,
    {
      issued: number
      appeared: number
      missing: string[]
      p50?: number
      p95?: number
      max?: number
    }
  > = {}
  const all: number[] = []
  let early = 0
  let late = false
  for (const [owner, receipts] of byOwner(issued)) {
    const window = seen.get(owner) ?? new Map<string, number>()
    const delays: number[] = []
    const missing: string[] = []
    for (const receipt of receipts) {
      const seenAt = window.get(receipt.id)
      if (seenAt === undefined) {
        missing.push(receipt.id)
        continue
      }
      const delay = seenAt - Date.parse(receipt.acceptedAt)
      if (delay < 0) early += 1
      delays.push(delay)
    }
    const summary = spread(delays)
    if (summary !== null && summary.p95 >= ARRIVAL_BUDGET_MS) late = true
    byPublisher[owner] = { issued: receipts.length, appeared: delays.length, missing, ...summary }
    all.push(...delays)
  }

  const measured = { budgetMs: ARRIVAL_BUDGET_MS, byPublisher, all: spread(all) }
  if (issued.length === 0) {
    return { ...measured, verdict: 'unmeasured' as Verdict, why: 'no receipt was issued' }
  }
  if (early > 0) {
    return {
      ...measured,
      verdict: 'unmeasured' as Verdict,
      why: `${early} rows appeared before it was accepted: the browser and the gateway do not share a clock`,
    }
  }
  const missing = Object.values(byPublisher).some((p) => p.missing.length > 0)
  const why = missing ? 'a receipt never reached its window' : late ? 'p95 over budget' : null
  return { ...measured, verdict: (why === null ? 'pass' : 'fail') as Verdict, why }
}

/**
 * SC-004. A window may also show the publisher's rows from before the run; those are its own
 * only if its own listing has them, and the listing is held to the hosts it owns.
 */
export function isolationVerdict(args: {
  hosts: ReadonlyMap<string, ReadonlySet<string>>
  issued: readonly Issued[]
  windows: ReadonlyMap<string, ReadonlySet<string>>
  listed: ReadonlyMap<string, readonly { id: string; sourceId: string }[]>
}) {
  const issuedTo = new Map(args.issued.map((r) => [r.id, r.owner]))
  const byPublisher: Record<
    string,
    {
      foreignInWindow: string[]
      foreignListed: string[]
      missingInWindow: string[]
      missingListed: string[]
    }
  > = {}
  let foreignRows = 0
  let complete = 0
  for (const [owner, owned] of args.hosts) {
    const listing = args.listed.get(owner) ?? []
    const window = args.windows.get(owner) ?? new Set<string>()
    const foreignListed = listing
      .filter((row) => !owned.has(new URL(row.sourceId).hostname))
      .map((row) => row.id)
    const ownListed = new Set(
      listing.map((row) => row.id).filter((id) => !foreignListed.includes(id)),
    )
    const foreignInWindow = [...window].filter((id) => {
      const to = issuedTo.get(id)
      return to === undefined ? !ownListed.has(id) : to !== owner
    })
    const own = args.issued.filter((r) => r.owner === owner).map((r) => r.id)
    const missingInWindow = own.filter((id) => !window.has(id))
    const missingListed = own.filter((id) => !ownListed.has(id))
    byPublisher[owner] = { foreignInWindow, foreignListed, missingInWindow, missingListed }
    foreignRows += foreignInWindow.length + foreignListed.length
    if (missingInWindow.length === 0 && missingListed.length === 0) complete += 1
  }

  const publishers = args.hosts.size
  return {
    publishers,
    complete,
    foreignRows,
    byPublisher,
    verdict: (publishers >= PUBLISHERS && complete === publishers && foreignRows === 0
      ? 'pass'
      : 'fail') as Verdict,
  }
}

/**
 * The M2 demo's claim that the totals agree with the ledger, per publisher: the run's own
 * receipts, the dashboard's figure for this agent, and what the chain moved to the payout
 * account in the run's own transactions. Other agents' takings stay out of all three.
 */
export function takingsVerdict(args: {
  consumer: string
  issued: readonly Issued[]
  summaries: ReadonlyMap<
    string,
    { byConsumer: readonly { consumer: string; count: number; total: bigint }[] }
  >
  payouts: ReadonlyMap<string, string>
  flows: readonly TokenFlows[]
}) {
  const byPublisher: Record<
    string,
    {
      receipts: number
      charged: bigint
      dashboard: { count: number; total: bigint }
      onChain: bigint
    }
  > = {}
  let agree = true
  for (const [owner, payout] of args.payouts) {
    const own = args.issued.filter((r) => r.owner === owner)
    const charged = own.reduce((total, r) => total + r.tariff, 0n)
    const row = args.summaries.get(owner)?.byConsumer.find((c) => c.consumer === args.consumer)
    const dashboard = { count: row?.count ?? 0, total: row?.total ?? 0n }
    const onChain = args.flows.reduce((total, flows) => total + (flows.get(payout) ?? 0n), 0n)
    byPublisher[owner] = { receipts: own.length, charged, dashboard, onChain }
    if (dashboard.count !== own.length || dashboard.total !== charged || onChain !== charged)
      agree = false
  }
  return { byPublisher, verdict: (agree ? 'pass' : 'fail') as Verdict }
}
