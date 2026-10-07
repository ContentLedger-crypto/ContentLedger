import { batches, receipts, vouchers } from '@contentledger/db'
import {
  merkleProof,
  merkleRoot,
  type publicLatestBatchSchema,
  type ReceiptBody,
  receiptId,
  receiptLeaf,
} from '@contentledger/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { apiError } from '../errors.js'
import type { Database } from '../store.js'

type Batch = typeof batches.$inferSelect
type ReceiptRow = typeof receipts.$inferSelect

// A settled batch and an anchored receipt never change; a pending one is about to.
const IMMUTABLE = 'public, max-age=31536000, immutable'
// The newest batch moves on with every settler pass that has work.
const LATEST = 'public, max-age=30'

const batchParams = z.object({
  consumer: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  seqTo: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .transform(BigInt),
})

const receiptParams = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) })

const invalid = (c: Context, error: z.ZodError) =>
  c.json(apiError('INVALID_INPUT', 'invalid path', { issues: z.flattenError(error) }), 400)

/**
 * Public by design (FR-013b): anyone, not only the payer, must be able to rebuild the
 * inclusion proof. Nothing here is taken on trust by a verifier: the root, the chain and
 * the previous batch's chain are all read back from the escrow's settlement record.
 */
export function publicRoutes(db: Database): Hono {
  const app = new Hono()

  // Any origin, unlike the session routes: these carry no credentials, and a verifier
  // or a page outside the dashboard has the same right to read them.
  for (const path of ['/v1/receipts/*', '/v1/batches/*']) {
    app.use(path, cors({ origin: '*', allowMethods: ['GET'] }))
  }

  // What settled last, for a reader who wants to see the rail move, not to verify:
  // the signature is the part to check, on the chain.
  app.get('/v1/batches/latest', async (c) => {
    const [batch] = await db.select().from(batches).orderBy(desc(batches.publishedAt)).limit(1)
    if (batch === undefined) return c.json(apiError('NOT_FOUND', 'no batch yet', {}), 404)
    c.header('Cache-Control', LATEST)
    return c.json({
      consumer: batch.consumer,
      seqTo: Number(batch.seqTo),
      txSig: batch.txSig,
      publishedAt: batch.publishedAt.toISOString(),
      receipts: Number(batch.seqTo - batch.seqFrom + 1n),
    } satisfies z.input<typeof publicLatestBatchSchema>)
  })

  app.get('/v1/batches/:consumer/:seqTo', async (c) => {
    const params = batchParams.safeParse(c.req.param())
    if (!params.success) return invalid(c, params.error)
    const { consumer, seqTo } = params.data

    const [batch] = await db
      .select()
      .from(batches)
      .where(and(eq(batches.consumer, consumer), eq(batches.seqTo, seqTo)))
    if (batch === undefined) return c.json(apiError('NOT_FOUND', 'no such batch', {}), 404)

    const { bodies } = await composition(db, batch)
    c.header('Cache-Control', IMMUTABLE)
    return c.json({
      consumer: batch.consumer,
      seqFrom: Number(batch.seqFrom),
      seqTo: Number(batch.seqTo),
      root: batch.root,
      chain: batch.chain,
      txSig: batch.txSig,
      publishedAt: batch.publishedAt.toISOString(),
      // Where to read the starting chain from, not the chain itself: a value served here
      // is exactly what step 3 of the verification must not take from the gateway.
      previous: await previousBatch(db, batch),
      receipts: bodies,
    })
  })

  app.get('/v1/receipts/:id', async (c) => {
    const params = receiptParams.safeParse(c.req.param())
    if (!params.success) return invalid(c, params.error)
    const { id } = params.data

    const [row] = await db
      .select({ receipt: receipts, seq: vouchers.seq })
      .from(receipts)
      .leftJoin(vouchers, eq(vouchers.receiptId, receipts.id))
      .where(eq(receipts.id, id))
    if (row === undefined) return c.json(apiError('NOT_FOUND', 'no such receipt', {}), 404)

    const body = bodyOf(row.receipt, row.seq)
    const anchor = await anchorOf(db, row.receipt, body)
    c.header('Cache-Control', anchor.kind === 'pending' ? 'no-store' : IMMUTABLE)
    return c.json({
      id,
      ...body,
      hashMatch: body.servedHash === body.registryHash,
      anchor,
    })
  })

  return app
}

async function anchorOf(db: Database, row: ReceiptRow, body: ReceiptBody) {
  if (body.paymentMethod === 'x402') {
    return { kind: 'payment' as const, paymentRef: body.paymentRef }
  }
  if (row.batchId === null) return { kind: 'pending' as const }

  const [batch] = await db.select().from(batches).where(eq(batches.id, row.batchId))
  if (batch === undefined) throw new Error(`receipt ${row.id} points at a missing batch`)
  if (row.settledAt === null) throw new Error(`receipt ${row.id} is batched but not settled`)
  const { leaves } = await composition(db, batch)
  const index = Number(BigInt(body.seq) - batch.seqFrom)
  return {
    kind: 'batch' as const,
    consumer: batch.consumer,
    seqTo: Number(batch.seqTo),
    root: batch.root,
    txSig: batch.txSig,
    settledAt: row.settledAt.toISOString(),
    path: merkleProof(leaves, index).map(({ hash, side }) => ({ hash: toHex(hash), side })),
  }
}

/**
 * Checked before it is served: a published composition that misses a seq or does not
 * hash to the anchored root would send every verifier chasing a fault that is ours.
 */
async function composition(db: Database, batch: Batch) {
  const rows = await db
    .select({ receipt: receipts, seq: vouchers.seq })
    .from(vouchers)
    .innerJoin(receipts, eq(vouchers.receiptId, receipts.id))
    .where(eq(vouchers.batchId, batch.id))
    .orderBy(asc(vouchers.seq))

  const expected = batch.seqTo - batch.seqFrom + 1n
  const contiguous = rows.every((row, i) => row.seq === batch.seqFrom + BigInt(i))
  if (BigInt(rows.length) !== expected || !contiguous) {
    throw new Error(`batch ${batch.id} does not cover seq ${batch.seqFrom}..${batch.seqTo}`)
  }
  const bodies = rows.map((row) => bodyOf(row.receipt, row.seq))
  const leaves = bodies.map(receiptLeaf)
  if (toHex(merkleRoot(leaves)) !== batch.root) {
    throw new Error(`batch ${batch.id} does not hash to its anchored root`)
  }
  return { bodies, leaves }
}

async function previousBatch(db: Database, batch: Batch) {
  if (batch.seqFrom === 1n) return null
  const [previous] = await db
    .select({ seqTo: batches.seqTo, txSig: batches.txSig })
    .from(batches)
    .where(and(eq(batches.consumer, batch.consumer), eq(batches.seqTo, batch.seqFrom - 1n)))
  if (previous === undefined) {
    throw new Error(`batch ${batch.id} follows seq ${batch.seqFrom - 1n}, which has no batch`)
  }
  return { seqTo: Number(previous.seqTo), txSig: previous.txSig }
}

/** The signed body, rebuilt from its columns and held to the id it was stored under. */
function bodyOf(row: ReceiptRow, seq: bigint | null): ReceiptBody {
  const issued = {
    consumer: row.consumer,
    work: row.workId,
    useType: row.useType,
    tariff: row.tariff.toString(),
    fee: row.fee.toString(),
    rateLevel: row.rateLevel,
    servedHash: row.servedHash,
    registryHash: row.registryHash,
    acceptedAt: row.acceptedAt,
  }
  const body: ReceiptBody =
    row.paymentMethod === 'x402'
      ? { ...issued, paymentMethod: 'x402', paymentRef: required(row.paymentRef, row.id) }
      : { ...issued, paymentMethod: 'escrow', seq: Number(required(seq, row.id)) }
  if (receiptId(body) !== row.id) throw new Error(`receipt ${row.id} no longer hashes to its id`)
  return body
}

function required<T>(value: T | null, id: string): T {
  if (value === null) throw new Error(`receipt ${id} is missing its payment reference`)
  return value
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
