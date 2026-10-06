import type { Domain, Work } from '@contentledger/chain'
import { acceptedAtColumns, domains, receipts, vouchers, works } from '@contentledger/db'
import { chainGenesis, type ReceiptBody, receiptId } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { desc, eq, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { EscrowSnapshot, Located } from './registry.js'
import type { EscrowReceiptBody, PresentedVoucher, VoucherPosition } from './voucher.js'

export type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** The registry snapshot an issuance was priced from, plus what only the served bytes tell. */
export interface RegistryMirror {
  slot: bigint
  source: string
  domain: Located<Domain>
  work: Located<Work>
  mediaType: string
  byteLen: number
}

export type X402ReceiptBody = Extract<ReceiptBody, { paymentMethod: 'x402' }>

export type IssuanceOutcome = { ok: true; receiptId: string } | { ok: false; reason: 'replayed' }

/**
 * Stored vouchers win over the chain: the escrow only learns of a voucher at settlement,
 * so falling back to it while unsettled vouchers exist would accept them again (FR-009).
 */
export async function loadPosition(db: Database, escrow: EscrowSnapshot): Promise<VoucherPosition> {
  const [last] = await db
    .select({ seq: vouchers.seq, cumulative: vouchers.cumulative, chain: vouchers.chain })
    .from(vouchers)
    .where(eq(vouchers.consumer, escrow.account.consumer))
    .orderBy(desc(vouchers.seq))
    .limit(1)
  if (last) return { seq: last.seq, cumulative: last.cumulative, chain: fromHex(last.chain) }

  const { lastSeq, settledTotal, lastChain } = escrow.account
  // open_escrow zeroes last_chain rather than writing the genesis value.
  const chain =
    lastSeq === 0n ? chainGenesis(new PublicKey(escrow.address).toBytes()) : fromHex(lastChain)
  return { seq: lastSeq, cumulative: settledTotal, chain }
}

export function recordEscrowIssuance(
  db: Database,
  body: EscrowReceiptBody,
  voucher: PresentedVoucher,
  mirror: RegistryMirror,
): Promise<IssuanceOutcome> {
  return issue(db, body, mirror, null, (tx, id) =>
    tx.insert(vouchers).values({
      consumer: body.consumer,
      seq: voucher.seq,
      cumulative: voucher.cumulative,
      chain: Buffer.from(voucher.chain).toString('hex'),
      signature: utils.bytes.bs58.encode(voucher.signature),
      receiptId: id,
    }),
  )
}

/** An x402 receipt is settled from the start: its money moved before the content did. */
export function recordX402Issuance(
  db: Database,
  body: X402ReceiptBody,
  paidAt: Date,
  mirror: RegistryMirror,
): Promise<IssuanceOutcome> {
  return issue(db, body, mirror, paidAt, async () => {})
}

/**
 * One transaction, so a replay loses its receipt along with its voucher. Replays are
 * told apart by the unique constraints alone (receipt id, `(consumer, seq)`,
 * `payment_ref`): checking first and inserting after would let two racing requests
 * both pass the check.
 */
async function issue(
  db: Database,
  body: ReceiptBody,
  mirror: RegistryMirror,
  settledAt: Date | null,
  after: (tx: Transaction, receiptId: string) => Promise<unknown>,
): Promise<IssuanceOutcome> {
  const id = receiptId(body)
  try {
    await db.transaction(async (tx) => {
      await upsertMirror(tx, mirror)
      await tx.insert(receipts).values({
        id,
        consumer: body.consumer,
        workId: body.work,
        useType: body.useType,
        tariff: BigInt(body.tariff),
        fee: BigInt(body.fee),
        rateLevel: body.rateLevel,
        servedHash: body.servedHash,
        registryHash: body.registryHash,
        hashMatch: body.servedHash === body.registryHash,
        paymentMethod: body.paymentMethod,
        paymentRef: body.paymentMethod === 'x402' ? body.paymentRef : null,
        ...acceptedAtColumns(body.acceptedAt),
        settledAt,
      })
      await after(tx, id)
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'replayed' }
    throw error
  }
  return { ok: true, receiptId: id }
}

async function upsertMirror(
  tx: Transaction,
  { slot, source, domain, work, ...served }: RegistryMirror,
) {
  const domainRow = {
    host: domain.account.host,
    owner: domain.account.owner,
    payoutOwner: domain.account.payoutOwner,
    rateTrain: domain.account.rateTrain,
    rateInference: domain.account.rateInference,
    status: domain.account.status,
    slot,
  }
  await tx
    .insert(domains)
    .values(domainRow)
    .onConflictDoUpdate({
      target: domains.host,
      set: domainRow,
      setWhere: sql`${domains.slot} < excluded.slot`,
    })

  const workRow = {
    id: work.address,
    host: domain.account.host,
    sourceId: source,
    contentHash: work.account.contentHash,
    rateTrain: work.account.rateTrain,
    rateInference: work.account.rateInference,
    status: work.account.status,
    mediaType: served.mediaType,
    byteLen: served.byteLen,
    slot,
  }
  await tx
    .insert(works)
    .values(workRow)
    .onConflictDoUpdate({
      target: works.id,
      set: workRow,
      setWhere: sql`${works.slot} < excluded.slot`,
    })
}

const UNIQUE_VIOLATION = '23505'

// Drizzle wraps driver errors, so the SQLSTATE sits somewhere down the cause chain.
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; isObject(current); current = current.cause) {
    if (current.code === UNIQUE_VIOLATION) return true
  }
  return false
}

const isObject = (value: unknown): value is { code?: unknown; cause?: unknown } =>
  typeof value === 'object' && value !== null

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'))
