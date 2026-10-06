import { acceptedAtColumns, domains, receipts, works } from '@contentledger/db'
import type { publisherReceiptSchema } from '@contentledger/shared'
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

export async function summarize(db: Database, wallet: SessionWallet, { from, to }: SummaryParams) {
  const rows = await db
    .select({
      workId: works.id,
      sourceId: works.sourceId,
      count: sql<number>`count(*)::int`,
      total: sql<string>`sum(${receipts.tariff})::text`,
    })
    .from(receipts)
    .innerJoin(works, eq(receipts.workId, works.id))
    .innerJoin(domains, ownedBy(wallet))
    .where(and(gte(receipts.acceptedTs, from), lt(receipts.acceptedTs, to)))
    .groupBy(works.id, works.sourceId)
    .orderBy(asc(works.sourceId))

  const byWork = rows.map((row) => ({ ...row, total: BigInt(row.total) }))
  return {
    total: byWork.reduce((sum, work) => sum + work.total, 0n),
    count: byWork.reduce((sum, work) => sum + work.count, 0),
    byWork,
  }
}

export type ReceiptItem = Awaited<ReturnType<typeof listReceipts>>['items'][number]

export const receiptJson = (item: ReceiptItem) =>
  ({
    ...item,
    tariff: item.tariff.toString(),
    settledAt: item.settledAt?.toISOString() ?? null,
  }) satisfies z.input<typeof publisherReceiptSchema>

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
