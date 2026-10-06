import { type Domain, escrowPda, type Work } from '@contentledger/chain'
import { MIGRATIONS_DIR, receipts, vouchers, works } from '@contentledger/db'
import { chainGenesis, receiptId } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EscrowSnapshot, Located } from './registry.js'
import {
  loadPosition,
  type RegistryMirror,
  recordEscrowIssuance,
  recordX402Issuance,
  type X402ReceiptBody,
} from './store.js'
import type { EscrowReceiptBody, PresentedVoucher } from './voucher.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed))
const CONSUMER = key(7)
const [ESCROW] = escrowPda(CONSUMER)
const WORK = key(9).toBase58()
const DOMAIN = key(8).toBase58()
const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32)

let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  const client = new PGlite()
  // Supabase ships these roles; the RLS migration names them in its policies.
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, works, domains cascade`)
})

const domain = (rateTrain: bigint): Located<Domain> => ({
  address: DOMAIN,
  account: {
    owner: key(1).toBase58(),
    payoutOwner: key(2).toBase58(),
    host: 'acme-news.test',
    rateTrain,
    rateInference: 500n,
    status: 'active',
    bump: 254,
  },
})

const work = (address: string): Located<Work> => ({
  address,
  account: {
    domain: DOMAIN,
    sourceHash: hex(0x11),
    contentHash: hex(0x22),
    rateTrain: null,
    rateInference: 900n,
    status: 'active',
    attestedBy: 0,
    bump: 253,
  },
})

const mirror = (slot: bigint, rateTrain = 2000n): RegistryMirror => ({
  slot,
  source: 'https://acme-news.test/2026/ai-act-explained.html',
  domain: domain(rateTrain),
  work: work(WORK),
  mediaType: 'text/html',
  byteLen: 1234,
})

const escrowBody = (seq: number, servedHash = hex(0x22)): EscrowReceiptBody => ({
  consumer: CONSUMER.toBase58(),
  work: WORK,
  useType: 'train',
  tariff: '2000',
  fee: '200',
  rateLevel: 'domain',
  servedHash,
  registryHash: hex(0x22),
  acceptedAt: '2026-09-30T10:00:00.000Z',
  paymentMethod: 'escrow',
  seq,
})

const PAYMENT_REF = utils.bytes.bs58.encode(new Uint8Array(64).fill(0x5a))

const x402Body = (acceptedAt: string): X402ReceiptBody => {
  const { seq: _seq, ...issued } = escrowBody(1)
  return { ...issued, acceptedAt, paymentMethod: 'x402', paymentRef: PAYMENT_REF }
}

const voucher = (seq: bigint, cumulative: bigint, chainByte: number): PresentedVoucher => ({
  escrow: ESCROW.toBytes(),
  seq,
  cumulative,
  chain: new Uint8Array(32).fill(chainByte),
  signature: new Uint8Array(64).fill(chainByte),
})

const onchain = (lastSeq: bigint, settledTotal: bigint, lastChain: string): EscrowSnapshot => ({
  address: ESCROW.toBase58(),
  account: {
    consumer: CONSUMER.toBase58(),
    vault: key(3).toBase58(),
    settledTotal,
    lastSeq,
    lastChain,
    withdrawAfter: 0n,
    bump: 252,
    vaultBump: 251,
  },
  vaultBalance: 1_000_000n,
})

describe('loadPosition', () => {
  it('starts a fresh escrow at its genesis, not at the zeroed chain the program stores', async () => {
    const position = await loadPosition(db, onchain(0n, 0n, hex(0)))
    expect(position).toEqual({ seq: 0n, cumulative: 0n, chain: chainGenesis(ESCROW.toBytes()) })
  })

  it('falls back to the settled on-chain position when no voucher is stored', async () => {
    const position = await loadPosition(db, onchain(5n, 11_000n, hex(0xcd)))
    expect(position).toEqual({
      seq: 5n,
      cumulative: 11_000n,
      chain: Uint8Array.from(Buffer.from(hex(0xcd), 'hex')),
    })
  })

  it('takes the highest stored voucher over the chain, which lags until settlement', async () => {
    await recordEscrowIssuance(db, escrowBody(6), voucher(6n, 13_200n, 0x06), mirror(10n))
    await recordEscrowIssuance(db, escrowBody(7), voucher(7n, 15_400n, 0x07), mirror(11n))

    const position = await loadPosition(db, onchain(5n, 11_000n, hex(0xcd)))
    expect(position).toEqual({
      seq: 7n,
      cumulative: 15_400n,
      chain: new Uint8Array(32).fill(0x07),
    })
  })

  it("ignores another agent's vouchers", async () => {
    await recordEscrowIssuance(
      db,
      { ...escrowBody(1), consumer: key(6).toBase58() },
      voucher(1n, 2200n, 0x01),
      mirror(10n),
    )
    expect((await loadPosition(db, onchain(0n, 0n, hex(0)))).seq).toBe(0n)
  })
})

describe('recordEscrowIssuance', () => {
  it('writes the mirror, the receipt and the voucher together', async () => {
    const body = escrowBody(1, hex(0x33))
    const outcome = await recordEscrowIssuance(db, body, voucher(1n, 2200n, 0x01), mirror(10n))
    expect(outcome).toEqual({ ok: true, receiptId: receiptId(body) })

    const [receipt] = await db.select().from(receipts)
    expect(receipt).toMatchObject({
      id: receiptId(body),
      consumer: CONSUMER.toBase58(),
      workId: WORK,
      useType: 'train',
      tariff: 2000n,
      fee: 200n,
      nodeCut: null,
      rateLevel: 'domain',
      servedHash: hex(0x33),
      registryHash: hex(0x22),
      hashMatch: false,
      paymentMethod: 'escrow',
      paymentRef: null,
      acceptedAt: '2026-09-30T10:00:00.000Z',
      acceptedTs: new Date('2026-09-30T10:00:00.000Z'),
      settledAt: null,
      batchId: null,
    })
    expect(await db.select().from(vouchers)).toEqual([
      {
        consumer: CONSUMER.toBase58(),
        seq: 1n,
        cumulative: 2200n,
        chain: hex(0x01),
        signature: utils.bytes.bs58.encode(new Uint8Array(64).fill(0x01)),
        receiptId: receiptId(body),
        batchId: null,
      },
    ])
    expect(await db.select().from(works)).toEqual([
      {
        id: WORK,
        host: 'acme-news.test',
        sourceId: 'https://acme-news.test/2026/ai-act-explained.html',
        contentHash: hex(0x22),
        rateTrain: null,
        rateInference: 900n,
        status: 'active',
        mediaType: 'text/html',
        byteLen: 1234,
        slot: 10n,
      },
    ])
  })

  it('marks a matching served hash as a match', async () => {
    await recordEscrowIssuance(db, escrowBody(1), voucher(1n, 2200n, 0x01), mirror(10n))
    const [receipt] = await db.select().from(receipts)
    expect(receipt?.hashMatch).toBe(true)
  })

  it('refuses the same voucher twice and keeps one issuance', async () => {
    await recordEscrowIssuance(db, escrowBody(1), voucher(1n, 2200n, 0x01), mirror(10n))
    const again = await recordEscrowIssuance(
      db,
      escrowBody(1),
      voucher(1n, 2200n, 0x01),
      mirror(10n),
    )
    expect(again).toEqual({ ok: false, reason: 'replayed' })
    expect(await db.select().from(vouchers)).toHaveLength(1)
  })

  it('lets exactly one of two racing vouchers with the same seq through', async () => {
    const outcomes = await Promise.all([
      recordEscrowIssuance(db, escrowBody(1), voucher(1n, 2200n, 0x01), mirror(10n)),
      recordEscrowIssuance(db, escrowBody(1, hex(0x44)), voucher(1n, 2200n, 0x02), mirror(10n)),
    ])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes).toContainEqual({ ok: false, reason: 'replayed' })
    expect(await db.select().from(vouchers)).toHaveLength(1)
    // The loser's receipt goes with it: a receipt without its voucher would be an
    // issuance nobody paid for.
    expect(await db.select().from(receipts)).toHaveLength(1)
  })

  it('never lets an older registry snapshot overwrite a newer mirror', async () => {
    await recordEscrowIssuance(db, escrowBody(1), voucher(1n, 2200n, 0x01), mirror(20n, 3000n))
    await recordEscrowIssuance(db, escrowBody(2), voucher(2n, 4400n, 0x02), mirror(10n, 1000n))
    const older = await db.execute(sql`select rate_train::text, slot::text from domains`)
    expect(older.rows).toEqual([{ rate_train: '3000', slot: '20' }])

    await recordEscrowIssuance(db, escrowBody(3), voucher(3n, 6600n, 0x03), mirror(30n, 4000n))
    const newer = await db.execute(sql`select rate_train::text from domains`)
    expect(newer.rows).toEqual([{ rate_train: '4000' }])
  })

  it('surfaces errors other than a replay and leaves nothing behind', async () => {
    const orphan: RegistryMirror = { ...mirror(10n), work: work(key(99).toBase58()) }
    await expect(
      recordEscrowIssuance(db, escrowBody(1), voucher(1n, 2200n, 0x01), orphan),
    ).rejects.toThrow()
    expect(await db.select().from(receipts)).toHaveLength(0)
    expect(await db.select().from(works)).toHaveLength(0)
  })
})

describe('recordX402Issuance', () => {
  it('writes the receipt anchored to the payment transaction and settled when it was paid', async () => {
    const body = x402Body('2026-09-30T10:00:00.000Z')
    const paidAt = new Date('2026-09-30T09:59:58.000Z')
    expect(await recordX402Issuance(db, body, paidAt, mirror(10n))).toEqual({
      ok: true,
      receiptId: receiptId(body),
    })
    const [receipt] = await db.select().from(receipts)
    expect(receipt).toMatchObject({
      paymentMethod: 'x402',
      paymentRef: PAYMENT_REF,
      settledAt: paidAt,
      batchId: null,
    })
    expect(await db.select().from(vouchers)).toHaveLength(0)
  })

  it('refuses the same payment for a second issuance, even with a different body', async () => {
    const paidAt = new Date('2026-09-30T09:59:58.000Z')
    await recordX402Issuance(db, x402Body('2026-09-30T10:00:00.000Z'), paidAt, mirror(10n))
    const again = await recordX402Issuance(
      db,
      x402Body('2026-09-30T10:00:05.000Z'),
      paidAt,
      mirror(10n),
    )
    expect(again).toEqual({ ok: false, reason: 'replayed' })
    expect(await db.select().from(receipts)).toHaveLength(1)
  })
})
