import { type Domain, escrowPda, type Work } from '@contentledger/chain'
import { batches, MIGRATIONS_DIR, receipts, vouchers } from '@contentledger/db'
import {
  type MerkleSide,
  merkleRoot,
  type ReceiptBody,
  receiptId,
  receiptLeaf,
  verifyInclusion,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PGlite } from '@electric-sql/pglite'
import { PublicKey } from '@solana/web3.js'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { Located } from '../registry.js'
import {
  type RegistryMirror,
  recordEscrowIssuance,
  recordX402Issuance,
  type X402ReceiptBody,
} from '../store.js'
import type { EscrowReceiptBody } from '../voucher.js'
import { publicRoutes } from './public.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed))
const CONSUMER = key(7).toBase58()
const WORK = key(9).toBase58()
const DOMAIN = key(8).toBase58()
const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32)
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))

let db: ReturnType<typeof drizzle>
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  const client = new PGlite()
  // Supabase ships these roles; the RLS migration names them in its policies.
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  app = createApp(publicRoutes(db))
})

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, batches, works, domains cascade`)
})

const domain: Located<Domain> = {
  address: DOMAIN,
  account: {
    owner: key(1).toBase58(),
    payoutOwner: key(2).toBase58(),
    host: 'acme-news.test',
    rateTrain: 2000n,
    rateInference: 500n,
    status: 'active',
    bump: 254,
  },
}

const work: Located<Work> = {
  address: WORK,
  account: {
    domain: DOMAIN,
    sourceHash: hex(0x11),
    contentHash: hex(0x22),
    rateTrain: null,
    rateInference: null,
    status: 'active',
    attestedBy: 0,
    bump: 253,
  },
}

const mirror: RegistryMirror = {
  slot: 100n,
  source: 'https://acme-news.test/2026/ai-act-explained.html',
  domain,
  work,
  mediaType: 'text/html',
  byteLen: 1234,
}

const escrowBody = (seq: number): EscrowReceiptBody => ({
  consumer: CONSUMER,
  work: WORK,
  useType: 'train',
  tariff: '2000',
  fee: '200',
  rateLevel: 'domain',
  servedHash: seq === 2 ? hex(0x33) : hex(0x22),
  registryHash: hex(0x22),
  acceptedAt: `2026-09-30T10:00:0${seq}.000Z`,
  paymentMethod: 'escrow',
  seq,
})

async function issue(seq: number): Promise<EscrowReceiptBody> {
  const body = escrowBody(seq)
  const recorded = await recordEscrowIssuance(
    db,
    body,
    {
      escrow: escrowPda(new PublicKey(CONSUMER))[0].toBytes(),
      seq: BigInt(seq),
      cumulative: BigInt(seq) * 2200n,
      chain: new Uint8Array(32).fill(seq),
      signature: new Uint8Array(64).fill(seq),
    },
    mirror,
  )
  if (!recorded.ok) throw new Error('seed issuance replayed')
  return body
}

const SETTLED_AT = new Date('2026-09-30T10:05:00.000Z')

/** What the settler leaves behind: the batch row, and every voucher and receipt pointing at it. */
async function settle(bodies: EscrowReceiptBody[], txByte: number, root?: string) {
  const id = root ?? toHex(merkleRoot(bodies.map(receiptLeaf)))
  const seqs = bodies.map((body) => BigInt(body.seq))
  await db.insert(batches).values({
    id,
    consumer: CONSUMER,
    seqFrom: seqs[0] ?? 1n,
    seqTo: seqs.at(-1) ?? 1n,
    root: id,
    chain: hex(txByte),
    txSig: utils.bytes.bs58.encode(new Uint8Array(64).fill(txByte)),
    publishedAt: SETTLED_AT,
  })
  const ids = bodies.map(receiptId)
  await db.update(vouchers).set({ batchId: id }).where(inArray(vouchers.receiptId, ids))
  await db
    .update(receipts)
    .set({ batchId: id, settledAt: SETTLED_AT })
    .where(inArray(receipts.id, ids))
  return id
}

interface BatchJson {
  consumer: string
  seqFrom: number
  seqTo: number
  root: string
  chain: string
  txSig: string
  publishedAt: string
  previous: { seqTo: number; txSig: string } | null
  receipts: ReceiptBody[]
}

interface ReceiptJson {
  id: string
  hashMatch: boolean
  anchor:
    | { kind: 'pending' }
    | { kind: 'payment'; paymentRef: string }
    | {
        kind: 'batch'
        consumer: string
        seqTo: number
        root: string
        txSig: string
        settledAt: string
        path: Array<{ hash: string; side: MerkleSide }>
      }
}

const getBatch = (seqTo: number | string, consumer = CONSUMER) =>
  app.request(`/v1/batches/${consumer}/${seqTo}`)
const getReceipt = (id: string) => app.request(`/v1/receipts/${id}`)

describe('GET /v1/batches/:consumer/:seqTo', () => {
  it('publishes the composition in seq order, enough to rebuild the anchored root', async () => {
    const bodies = [await issue(1), await issue(2), await issue(3)]
    const root = await settle(bodies, 0xa1)

    const res = await getBatch(3)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    const batch = (await res.json()) as BatchJson
    expect(batch).toEqual({
      consumer: CONSUMER,
      seqFrom: 1,
      seqTo: 3,
      root,
      chain: hex(0xa1),
      txSig: utils.bytes.bs58.encode(new Uint8Array(64).fill(0xa1)),
      publishedAt: '2026-09-30T10:05:00.000Z',
      previous: null,
      receipts: bodies,
    })
    expect(toHex(merkleRoot(batch.receipts.map(receiptLeaf)))).toBe(batch.root)
  })

  it('points at the previous batch rather than vouching for its chain', async () => {
    await settle([await issue(1)], 0xa1)
    const second = [await issue(2), await issue(3)]
    await settle(second, 0xa2)

    const batch = (await (await getBatch(3)).json()) as BatchJson
    expect(batch.seqFrom).toBe(2)
    expect(batch.previous).toEqual({
      seqTo: 1,
      txSig: utils.bytes.bs58.encode(new Uint8Array(64).fill(0xa1)),
    })
    expect(batch.receipts).toEqual(second)
    expect(batch).not.toHaveProperty('previousChain')
  })

  it('answers 404 for a batch that was never published', async () => {
    await settle([await issue(1)], 0xa1)
    expect((await getBatch(2)).status).toBe(404)
    expect((await getBatch(1, key(5).toBase58())).status).toBe(404)
  })

  it.each([
    ['a consumer that is not base58', ['0OIl', 1]],
    ['seq zero', [CONSUMER, 0]],
    ['a seq that is not a number', [CONSUMER, 'latest']],
  ] as const)('rejects %s', async (_, [consumer, seqTo]) => {
    expect((await getBatch(seqTo, consumer)).status).toBe(400)
  })

  it('refuses to publish a composition that does not hash to the anchored root', async () => {
    const bodies = [await issue(1), await issue(2)]
    await settle(bodies, 0xa1, hex(0xee))
    expect((await getBatch(2)).status).toBe(500)
  })

  it('refuses to publish a batch with a hole in its seq range', async () => {
    const bodies = [await issue(1), await issue(2), await issue(3)]
    await settle(bodies, 0xa1)
    await db.update(vouchers).set({ batchId: null }).where(eq(vouchers.seq, 2n))
    await db
      .update(receipts)
      .set({ batchId: null })
      .where(eq(receipts.id, receiptId(bodies[1] as ReceiptBody)))
    expect((await getBatch(3)).status).toBe(500)
  })

  it('refuses a batch whose root was built over a range with a seq missing', async () => {
    const first = await issue(1)
    await issue(2)
    const third = await issue(3)
    await settle([first, third], 0xa1)
    expect((await getBatch(3)).status).toBe(500)
  })

  it('refuses to point at a previous batch it does not have', async () => {
    await issue(1)
    await settle([await issue(2)], 0xa2)
    expect((await getBatch(2)).status).toBe(500)
  })
})

describe('GET /v1/receipts/:id', () => {
  it('proves a settled receipt into its batch root', async () => {
    const bodies = [await issue(1), await issue(2), await issue(3)]
    const root = await settle(bodies, 0xa1)
    const body = bodies[1] as EscrowReceiptBody

    const res = await getReceipt(receiptId(body))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    const receipt = (await res.json()) as ReceiptJson & EscrowReceiptBody
    expect(receipt).toMatchObject({ id: receiptId(body), ...body, hashMatch: false })
    if (receipt.anchor.kind !== 'batch') throw new Error(`anchor is ${receipt.anchor.kind}`)
    expect(receipt.anchor).toMatchObject({
      kind: 'batch',
      consumer: CONSUMER,
      seqTo: 3,
      root,
      settledAt: '2026-09-30T10:05:00.000Z',
    })
    const path = receipt.anchor.path.map((step) => ({ hash: fromHex(step.hash), side: step.side }))
    expect(verifyInclusion(receiptLeaf(body), path, fromHex(root))).toBe(true)
  })

  it('does not call a batched receipt settled before its settlement time is recorded', async () => {
    const body = await issue(1)
    await settle([body], 0xa1)
    await db
      .update(receipts)
      .set({ settledAt: null })
      .where(eq(receipts.id, receiptId(body)))
    expect((await getReceipt(receiptId(body))).status).toBe(500)
  })

  it('says a receipt not yet in a batch is pending, and lets nobody cache that', async () => {
    const body = await issue(1)
    const res = await getReceipt(receiptId(body))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      id: receiptId(body),
      ...body,
      hashMatch: true,
      anchor: { kind: 'pending' },
    })
  })

  it('anchors an x402 receipt to its own payment transaction', async () => {
    const paymentRef = utils.bytes.bs58.encode(new Uint8Array(64).fill(0x5a))
    const { seq: _seq, ...issued } = escrowBody(1)
    const body: X402ReceiptBody = { ...issued, paymentMethod: 'x402', paymentRef }
    await recordX402Issuance(db, body, new Date(body.acceptedAt), mirror)

    const res = await getReceipt(receiptId(body))
    expect(res.status).toBe(200)
    expect((await res.json()) as ReceiptJson).toMatchObject({
      ...body,
      anchor: { kind: 'payment', paymentRef },
    })
  })

  it('answers 404 for an unknown receipt and 400 for an id that is not one', async () => {
    expect((await getReceipt(hex(0x42))).status).toBe(404)
    expect((await getReceipt('ABC')).status).toBe(400)
    expect((await getReceipt(hex(0xab).toUpperCase())).status).toBe(400)
  })

  it('refuses to serve a stored receipt whose body no longer hashes to its id', async () => {
    const body = await issue(1)
    await db
      .update(receipts)
      .set({ tariff: 1n })
      .where(eq(receipts.id, receiptId(body)))
    expect((await getReceipt(receiptId(body))).status).toBe(500)
  })
})
