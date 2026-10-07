import { domainPda } from '@contentledger/chain'
import {
  batches,
  receipts,
  SETTLEMENT_CHANNEL,
  settlerHeartbeat,
  vouchers,
  works,
} from '@contentledger/db'
import { and, asc, between, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { Batch, PendingVoucher } from './batch.js'

export type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

export interface Settlement {
  txSig: string
  settledAt: Date
  publishedAt: Date
  /** From the `Config` the batch was split under: the node cut is not in the signed body. */
  nodeShareBps: number
}

/** Unbatched escrow vouchers of every agent, each agent's in seq order. */
export async function loadPending(db: Database): Promise<Map<string, PendingVoucher[]>> {
  const rows = await db
    .select({
      consumer: vouchers.consumer,
      seq: vouchers.seq,
      cumulative: vouchers.cumulative,
      chain: vouchers.chain,
      signature: vouchers.signature,
      receiptId: vouchers.receiptId,
      tariff: receipts.tariff,
      acceptedTs: receipts.acceptedTs,
      host: works.host,
    })
    .from(vouchers)
    .innerJoin(receipts, eq(receipts.id, vouchers.receiptId))
    .innerJoin(works, eq(works.id, receipts.workId))
    .where(and(isNull(vouchers.batchId), eq(receipts.paymentMethod, 'escrow')))
    .orderBy(asc(vouchers.consumer), asc(vouchers.seq))

  const domains = new Map<string, string>()
  const pending = new Map<string, PendingVoucher[]>()
  for (const { consumer, host, ...voucher } of rows) {
    let domain = domains.get(host)
    if (domain === undefined) {
      domain = domainPda(host)[0].toBase58()
      domains.set(host, domain)
    }
    const list = pending.get(consumer) ?? []
    list.push({ ...voucher, domain })
    pending.set(consumer, list)
  }
  return pending
}

/** Where the recorded history of this agent ends; recovery starts right after it. */
export async function lastBatch(
  db: Database,
  consumer: string,
): Promise<{ seqTo: bigint; chain: string } | null> {
  const [row] = await db
    .select({ seqTo: batches.seqTo, chain: batches.chain })
    .from(batches)
    .where(eq(batches.consumer, consumer))
    .orderBy(desc(batches.seqTo))
    .limit(1)
  return row ?? null
}

/**
 * One transaction: the public routes serve a batched receipt only with its
 * `settled_at`, and a batch only when every seq in its range points back at it.
 */
export async function recordBatch(
  db: Database,
  consumer: string,
  batch: Batch,
  settlement: Settlement,
): Promise<void> {
  const id = Buffer.from(batch.root).toString('hex')
  await db.transaction(async (tx) => {
    await tx.insert(batches).values({
      id,
      consumer,
      seqFrom: batch.seqFrom,
      seqTo: batch.seqTo,
      root: id,
      chain: batch.last.chain,
      txSig: settlement.txSig,
      publishedAt: settlement.publishedAt,
    })

    const batchedVouchers = await tx
      .update(vouchers)
      .set({ batchId: id })
      .where(
        and(
          eq(vouchers.consumer, consumer),
          between(vouchers.seq, batch.seqFrom, batch.seqTo),
          isNull(vouchers.batchId),
        ),
      )
      .returning({ seq: vouchers.seq })

    const batchedReceipts = await tx
      .update(receipts)
      .set({
        batchId: id,
        settledAt: settlement.settledAt,
        // FR-015a: the node cut rounds down.
        nodeCut: sql`${receipts.tariff} * ${settlement.nodeShareBps}::bigint / 10000`,
      })
      .where(and(inArray(receipts.id, batch.receiptIds), isNull(receipts.batchId)))
      .returning({ id: receipts.id })

    const size = batch.receiptIds.length
    if (batchedVouchers.length !== size || batchedReceipts.length !== size) {
      throw new Error(
        `batch ${consumer} ${batch.seqFrom}..${batch.seqTo}: part of it is already batched`,
      )
    }
    await tx.execute(sql`select pg_notify(${SETTLEMENT_CHANNEL}, ${id})`)
  })
}

export interface Pass {
  passedAt: Date
  intervalSeconds: number
  failedAgents: number
}

export async function recordPass(db: Database, pass: Pass): Promise<void> {
  await db
    .insert(settlerHeartbeat)
    .values({ id: 1, ...pass })
    .onConflictDoUpdate({ target: settlerHeartbeat.id, set: pass })
}
