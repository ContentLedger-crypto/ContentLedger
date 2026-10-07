import { acceptedAtColumns, domains, receipts, works } from '@contentledger/db'
import type { publisherReceiptSchema, publisherSummarySchema } from '@contentledger/shared'
import { and, asc, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionWallet } from '../routes/auth.js'
import type { Database } from '../store.js'

export const PAGE_SIZE = 50

const CURSOR = /^(.+)_([0-9a-f]{64})$/

const cursor = z.string().transform((value, ctx) => {
  const match = CURSOR.exec(value)
  try {
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { acceptedAt: acceptedAtColumns(match[1]).acceptedAt, id: match[2] }
    }
  } catch {
    // acceptedAtColumns throws on a canonical-looking day that does not exist.
  }
  ctx.addIssue({ code: 'custom', message: 'invalid cursor' })
  return z.NEVER
})

// Strict, so a `host` or `wallet` a client hopes will narrow or widen the view is refused
// loudly rather than dropped: the session wallet is the only scope.
export const receiptsParams = z.strictObject({ cursor: cursor.optional() })

const instant = z.iso.datetime().transform((value) => new Date(value))

// A year and a leap day: enough for any calendar year, short enough that one request
// cannot make the database aggregate a publisher's whole history.
const MAX_PERIOD_MS = 366 * 24 * 60 * 60_000

export const summaryParams = z
  .strictObject({ from: instant, to: instant })
  .refine(({ from, to }) => from < to, { message: 'from must precede to' })
  .refine(({ from, to }) => Number(to) - Number(from) <= MAX_PERIOD_MS, {
    message: 'period longer than 366 days',
  })

export type ReceiptsParams = z.output<typeof receiptsParams>
export type SummaryParams = z.output<typeof summaryParams>

/**
 * Only `owner` signs changes to a domain; `payout_owner` is written by whoever registers it
 * and never proves control, so letting it in would show one publisher another's receipts.
 */
const ownedBy = (wallet: SessionWallet) =>
  and(eq(works.host, domains.host), eq(domains.owner, wallet))

const receiptFields = {
  id: receipts.id,
  workId: receipts.workId,
  sourceId: works.sourceId,
  consumer: receipts.consumer,
  useType: receipts.useType,
  tariff: receipts.tariff,
  paymentMethod: receipts.paymentMethod,
  acceptedAt: receipts.acceptedAt,
  settledAt: receipts.settledAt,
}

export async function listReceipts(db: Database, wallet: SessionWallet, params: ReceiptsParams) {
  const after = params.cursor
  const rows = await db
    .select(receiptFields)
    .from(receipts)
    .innerJoin(works, eq(receipts.workId, works.id))
    .innerJoin(domains, ownedBy(wallet))
    .where(
      after &&
        sql`(${receipts.acceptedTs}, ${receipts.id}) < (${after.acceptedAt}::timestamptz, ${after.id})`,
    )
    .orderBy(desc(receipts.acceptedTs), desc(receipts.id))
    .limit(PAGE_SIZE + 1)

  const items = rows.slice(0, PAGE_SIZE)
  const last = items.at(-1)
  const nextCursor =
    rows.length > PAGE_SIZE && last !== undefined ? `${last.acceptedAt}_${last.id}` : null
  return { items, nextCursor }
}

// One grouped read at the finest grain any table on the summary needs; the tables are
// folded from it, so their totals cannot disagree with one another.
export async function summarize(db: Database, wallet: SessionWallet, { from, to }: SummaryParams) {
  const rows = await db
    .select({
      workId: works.id,
      sourceId: works.sourceId,
      consumer: receipts.consumer,
      paymentMethod: receipts.paymentMethod,
      settled: sql<boolean>`${receipts.settledAt} is not null`,
      count: sql<number>`count(*)::int`,
      total: sql<string>`sum(${receipts.tariff})::text`,
      fee: sql<string>`sum(${receipts.fee})::text`,
    })
    .from(receipts)
    .innerJoin(works, eq(receipts.workId, works.id))
    .innerJoin(domains, ownedBy(wallet))
    .where(and(gte(receipts.acceptedTs, from), lt(receipts.acceptedTs, to)))
    .groupBy(
      works.id,
      works.sourceId,
      receipts.consumer,
      receipts.paymentMethod,
      sql`${receipts.settledAt} is not null`,
    )

  return summaryOf(rows.map((row) => ({ ...row, total: BigInt(row.total), fee: BigInt(row.fee) })))
}

type PaymentMethod = ReceiptItem['paymentMethod']

interface SummaryCell {
  workId: string
  sourceId: string
  consumer: string
  paymentMethod: PaymentMethod
  settled: boolean
  count: number
  total: bigint
  fee: bigint
}

interface Tally {
  count: number
  total: bigint
}

export function summaryOf(cells: SummaryCell[]) {
  const byWork = new Map<string, Tally & { workId: string; sourceId: string }>()
  const byConsumer = new Map<string, Tally & { consumer: string; methods: Set<PaymentMethod> }>()
  const flows = new Map<string, Tally & { consumer: string; workId: string; sourceId: string }>()
  const settlement = { inBatch: 0n, accrued: 0n, perRequest: 0n }
  let fee = 0n

  for (const cell of cells) {
    const { workId, sourceId, consumer } = cell
    add(byWork, workId, cell, () => ({ workId, sourceId, ...NONE }))
    add(byConsumer, consumer, cell, () => ({ consumer, methods: new Set(), ...NONE })).methods.add(
      cell.paymentMethod,
    )
    add(flows, `${consumer}~${workId}`, cell, () => ({ consumer, workId, sourceId, ...NONE }))
    fee += cell.fee
    const standing =
      cell.paymentMethod === 'x402' ? 'perRequest' : cell.settled ? 'inBatch' : 'accrued'
    settlement[standing] += cell.total
  }

  const works = [...byWork.values()].sort((a, b) => compare(a.sourceId, b.sourceId))
  return {
    total: works.reduce((sum, work) => sum + work.total, 0n),
    fee,
    count: works.reduce((sum, work) => sum + work.count, 0),
    byWork: works,
    byConsumer: [...byConsumer.values()]
      .sort((a, b) => compare(b.total, a.total) || compare(a.consumer, b.consumer))
      .map(({ methods, ...consumer }) => ({
        ...consumer,
        paymentMethods: [...methods].sort(compare),
      })),
    flows: [...flows.values()]
      .sort((a, b) => compare(a.consumer, b.consumer) || compare(a.sourceId, b.sourceId))
      .map(({ sourceId: _, ...flow }) => flow),
    settlement,
  }
}

const NONE: Tally = { count: 0, total: 0n }

function add<T extends Tally>(tallies: Map<string, T>, key: string, cell: Tally, empty: () => T) {
  const tally = tallies.get(key) ?? empty()
  tally.count += cell.count
  tally.total += cell.total
  tallies.set(key, tally)
  return tally
}

const compare = <T extends string | bigint>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0)

export type ReceiptItem = Awaited<ReturnType<typeof listReceipts>>['items'][number]

export const receiptJson = (item: ReceiptItem) =>
  ({
    ...item,
    tariff: item.tariff.toString(),
    settledAt: item.settledAt?.toISOString() ?? null,
  }) satisfies z.input<typeof publisherReceiptSchema>

const money = <T extends { total: bigint }>(tally: T) => ({
  ...tally,
  total: tally.total.toString(),
})

export const summaryJson = (
  summary: Awaited<ReturnType<typeof summarize>>,
  registeredWorks: number | null,
) =>
  ({
    total: summary.total.toString(),
    fee: summary.fee.toString(),
    count: summary.count,
    byWork: summary.byWork.map(money),
    byConsumer: summary.byConsumer.map(money),
    flows: summary.flows.map(money),
    settlement: {
      inBatch: summary.settlement.inBatch.toString(),
      accrued: summary.settlement.accrued.toString(),
      perRequest: summary.settlement.perRequest.toString(),
    },
    registeredWorks,
  }) satisfies z.input<typeof publisherSummarySchema>

/**
 * The receipts a live event is about, each with the one wallet allowed to see it: the
 * same join as the queries above, so the stream cannot show what the API would hide.
 */
function receiptsWithOwner(db: Database, where: SQL) {
  return db
    .select({ ...receiptFields, owner: domains.owner })
    .from(receipts)
    .innerJoin(works, eq(receipts.workId, works.id))
    .innerJoin(domains, eq(works.host, domains.host))
    .where(where)
    .orderBy(asc(receipts.acceptedTs), asc(receipts.id))
}

export const issuedReceipt = (db: Database, id: string) =>
  receiptsWithOwner(db, eq(receipts.id, id))

export const settledReceipts = (db: Database, batchId: string) =>
  receiptsWithOwner(db, eq(receipts.batchId, batchId))
