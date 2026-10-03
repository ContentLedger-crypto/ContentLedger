import { escrowPda, type SettlementEntry } from '@contentledger/chain'
import {
  chainGenesis,
  chainStep,
  merkleProof,
  merkleRoot,
  type ReceiptBody,
  receiptId,
  receiptLeaf,
} from '@contentledger/shared'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Network, Settlement } from './network.js'
import type { Publication, PublishedBatch, PublishedReceipt } from './publication.js'
import { verifyReceipt } from './verify.js'

type EscrowBody = Extract<ReceiptBody, { paymentMethod: 'escrow' }>

const key = () => Keypair.generate().publicKey.toBase58()
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

const consumer = key()
const escrow = escrowPda(new PublicKey(consumer))[0]
const [DOMAIN_A, DOMAIN_B] = [key(), key()]
const [WORK_A, WORK_B] = [key(), key()]

const receipt = (seq: number, work = WORK_A, tariff = 2_000n): EscrowBody => ({
  consumer,
  work,
  useType: 'train',
  tariff: tariff.toString(),
  fee: (tariff / 10n).toString(),
  rateLevel: 'domain',
  servedHash: 'aa'.repeat(32),
  registryHash: 'aa'.repeat(32),
  acceptedAt: `2026-10-03T10:00:${String(seq).padStart(2, '0')}.000Z`,
  paymentMethod: 'escrow',
  seq,
})

interface World {
  ring: SettlementEntry[]
  settlements: Map<string, Settlement>
  works: Map<string, string>
  receipts: Map<string, PublishedReceipt>
  batches: Map<number, PublishedBatch>
}

const newWorld = (): World => ({
  ring: [],
  settlements: new Map(),
  works: new Map([
    [WORK_A, DOMAIN_A],
    [WORK_B, DOMAIN_B],
  ]),
  receipts: new Map(),
  batches: new Map(),
})

interface Settled {
  txSig: string
  ids: string[]
  chain: Uint8Array
}

/**
 * `signed` is what the payer's vouchers chain over, `tree` what the anchored root is built
 * from, the bodies themselves what the gateway publishes and pays out. An honest gateway
 * keeps all three the same; each lie in these tests pulls one of them apart.
 */
function settle(
  world: World,
  bodies: readonly EscrowBody[],
  options: {
    previous?: Settled
    signed?: readonly EscrowBody[]
    tree?: readonly EscrowBody[]
  } = {},
): Settled {
  const signed = options.signed ?? bodies
  const tree = options.tree ?? bodies
  const chain = signed
    .map(receiptLeaf)
    .reduce(chainStep, options.previous?.chain ?? chainGenesis(escrow.toBytes()))
  const treeLeaves = tree.map(receiptLeaf)
  const root = hex(merkleRoot(treeLeaves))
  const seqFrom = bodies[0]?.seq ?? 0
  const seqTo = bodies.at(-1)?.seq ?? 0
  const txSig = `settlement-${seqTo}-${world.settlements.size}`

  const owed = new Map<string, bigint>()
  for (const body of bodies) {
    const domain = world.works.get(body.work) ?? 'unknown'
    owed.set(domain, (owed.get(domain) ?? 0n) + BigInt(body.tariff))
  }
  world.settlements.set(txSig, {
    succeeded: true,
    escrow: escrow.toBase58(),
    seq: BigInt(seqTo),
    chain: hex(chain),
    root,
    legs: [...owed].map(([domain, tariff]) => ({ domain, tariff })),
    vaultDebit: bodies.reduce((sum, body) => sum + BigInt(body.tariff) + BigInt(body.fee), 0n),
    treasuryCredit: bodies.reduce((sum, body) => sum + BigInt(body.fee), 0n),
  })
  world.ring.push({ seqEnd: BigInt(seqTo), ts: 1_790_000_000n, root, chain: hex(chain) })
  world.batches.set(seqTo, {
    consumer,
    seqFrom,
    seqTo,
    previous: options.previous ? { seqTo: seqFrom - 1, txSig: options.previous.txSig } : null,
    receipts: [...bodies],
  })
  const ids = bodies.map((body) => {
    const id = receiptId(body)
    const index = tree.findIndex((leaf) => receiptId(leaf) === id)
    const path = index < 0 ? [] : merkleProof(treeLeaves, index)
    world.receipts.set(id, { body, anchor: { kind: 'batch', seqTo, txSig, path } })
    return id
  })
  return { txSig, ids, chain }
}

const sources = (world: World): { network: Network; publication: Publication } => ({
  network: {
    ring: async (address) => (address === escrow.toBase58() ? world.ring : []),
    settlement: async (signature) => world.settlements.get(signature) ?? null,
    workDomains: async (works) =>
      new Map(
        works.flatMap((work) => {
          const domain = world.works.get(work)
          return domain === undefined ? [] : [[work, domain] as const]
        }),
      ),
  },
  publication: {
    receipt: async (id) => world.receipts.get(id) ?? null,
    batch: async (owner, seqTo) => (owner === consumer ? (world.batches.get(seqTo) ?? null) : null),
  },
})

function patchSettlement(world: World, txSig: string, patch: Partial<Settlement>): void {
  const settlement = world.settlements.get(txSig)
  if (settlement === undefined) throw new Error(`no settlement ${txSig}`)
  world.settlements.set(txSig, { ...settlement, ...patch })
}

function publishedReceipt(world: World, id: string): PublishedReceipt {
  const published = world.receipts.get(id)
  if (published === undefined) throw new Error(`no receipt ${id}`)
  return published
}

const PASS = { status: 'pass' }
const SKIPPED = { status: 'skipped' }
const fail = (reason: string) => ({ status: 'fail', reason })
const VERIFIED = {
  outcome: 'verified',
  steps: { onchain: PASS, inclusion: PASS, chain: PASS, amounts: PASS },
}

const honestFirstBatch = () => [receipt(1), receipt(2), receipt(3, WORK_B, 8_000n)]

describe('verifyReceipt — honest batches', () => {
  it('verifies every receipt of a first batch from the escrow genesis', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    for (const id of ids) {
      expect(await verifyReceipt(id, sources(world))).toEqual(VERIFIED)
    }
  })

  it('verifies a later batch starting from the chain the ring holds for its predecessor', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const { ids } = settle(world, [receipt(3), receipt(4, WORK_B)], { previous: first })
    for (const id of ids) {
      expect(await verifyReceipt(id, sources(world))).toEqual(VERIFIED)
    }
  })

  it('falls back to the transactions once the ring has evicted both batches', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const { ids } = settle(world, [receipt(3), receipt(4, WORK_B)], { previous: first })
    world.ring = []
    expect(await verifyReceipt(ids[1] ?? '', sources(world))).toEqual(VERIFIED)
  })

  it('verifies a single-receipt batch, whose inclusion path is empty', async () => {
    const world = newWorld()
    const { ids } = settle(world, [receipt(1)])
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(VERIFIED)
  })
})

describe('verifyReceipt — a batch fabricated whole (FR-013d)', () => {
  it('passes the inclusion proof and fails the chain recomputation', async () => {
    const world = newWorld()
    const fabricated = [
      receipt(1, WORK_B, 9_000n),
      receipt(2, WORK_B, 9_000n),
      receipt(3, WORK_B, 9_000n),
    ]
    const { ids } = settle(world, fabricated, { signed: honestFirstBatch() })
    for (const id of ids) {
      expect(await verifyReceipt(id, sources(world))).toEqual({
        outcome: 'rejected',
        steps: { onchain: PASS, inclusion: PASS, chain: fail('chain-mismatch'), amounts: SKIPPED },
      })
    }
  })

  it('catches an anchored root that is not built over the published composition', async () => {
    const world = newWorld()
    const honest = honestFirstBatch()
    const { ids } = settle(world, honest, { tree: [...honest, receipt(4)] })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual({
      outcome: 'rejected',
      steps: {
        onchain: PASS,
        inclusion: PASS,
        chain: fail('root-not-over-composition'),
        amounts: SKIPPED,
      },
    })
  })
})

const tampers: [string, (body: EscrowBody) => ReceiptBody][] = [
  ['consumer', (body) => ({ ...body, consumer: key() })],
  ['work', (body) => ({ ...body, work: WORK_B })],
  ['useType', (body) => ({ ...body, useType: 'inference' })],
  ['tariff', (body) => ({ ...body, tariff: (BigInt(body.tariff) + 1n).toString() })],
  ['fee', (body) => ({ ...body, fee: (BigInt(body.fee) + 1n).toString() })],
  ['rateLevel', (body) => ({ ...body, rateLevel: 'work' })],
  ['servedHash', (body) => ({ ...body, servedHash: 'bb'.repeat(32) })],
  ['registryHash', (body) => ({ ...body, registryHash: 'bb'.repeat(32) })],
  ['acceptedAt', (body) => ({ ...body, acceptedAt: '2026-10-03T11:00:00.000Z' })],
  ['seq', (body) => ({ ...body, seq: body.seq + 1 })],
  [
    'paymentMethod',
    ({ seq: _seq, ...body }) => ({ ...body, paymentMethod: 'x402', paymentRef: '5'.repeat(88) }),
  ],
]

describe('verifyReceipt — a tampered field (SC-007)', () => {
  it('covers every field of the receipt body', () => {
    expect(tampers.map(([field]) => field).sort()).toEqual(Object.keys(receipt(1)).sort())
  })

  it.each(tampers)('refuses a tampered %s served under the original id', async (_, tamper) => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const id = ids[1] ?? ''
    const original = publishedReceipt(world, id)
    world.receipts.set(id, { ...original, body: tamper(receipt(2)) })
    expect(await verifyReceipt(id, sources(world))).toEqual({ outcome: 'tampered' })
  })

  it.each(tampers)('rejects a tampered %s served under its own id', async (_, tamper) => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const original = publishedReceipt(world, ids[1] ?? '')
    const tampered = tamper(receipt(2))
    const id = receiptId(tampered)
    world.receipts.set(id, { ...original, body: tampered })
    expect(await verifyReceipt(id, sources(world))).toMatchObject({
      outcome: 'rejected',
      steps: { inclusion: { status: expect.not.stringMatching(/^pass$/) } },
    })
  })
})

describe('verifyReceipt — step 1, the anchor on chain', () => {
  const rejectedAtAnchor = (reason: string) => ({
    outcome: 'rejected',
    steps: { onchain: fail(reason), inclusion: SKIPPED, chain: SKIPPED, amounts: SKIPPED },
  })

  it('rejects a receipt whose settlement transaction does not exist', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    world.settlements.delete(txSig)
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('settlement-not-found'),
    )
  })

  it('rejects a settlement transaction that failed', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, { succeeded: false })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('settlement-failed'),
    )
  })

  it("rejects a settlement of another payer's escrow", async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, { escrow: key() })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('settlement-of-another-escrow'),
    )
  })

  it('rejects a settlement of another batch of the same escrow', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, { seq: 7n })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('settlement-of-another-batch'),
    )
  })

  it('rejects when the ring and the transaction disagree on the root', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    world.ring = world.ring.map((entry) => ({ ...entry, root: 'cc'.repeat(32) }))
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('ring-disagrees'),
    )
  })

  it('rejects when the ring and the transaction disagree on the chain', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    world.ring = world.ring.map((entry) => ({ ...entry, chain: 'cc'.repeat(32) }))
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAnchor('ring-disagrees'),
    )
  })

  it('verifies from the transaction alone once the ring has evicted the batch', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    world.ring = []
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(VERIFIED)
  })
})

describe('verifyReceipt — step 2, the inclusion proof', () => {
  it('rejects a path that does not lead to the anchored root', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    // The last of three leaves: its only sibling sits on the left, so the flip is a change.
    const id = ids[2] ?? ''
    const original = publishedReceipt(world, id)
    if (original.anchor.kind !== 'batch') throw new Error('expected a batch anchor')
    const path = original.anchor.path.map((step) => ({ ...step, side: 'right' as const }))
    world.receipts.set(id, { ...original, anchor: { ...original.anchor, path } })
    expect(await verifyReceipt(id, sources(world))).toEqual({
      outcome: 'rejected',
      steps: { onchain: PASS, inclusion: fail('not-included'), chain: PASS, amounts: PASS },
    })
  })
})

describe('verifyReceipt — step 3, the composition and the chain', () => {
  const rejectedAtChain = (reason: string) => ({
    outcome: 'rejected',
    steps: { onchain: PASS, inclusion: PASS, chain: fail(reason), amounts: SKIPPED },
  })

  it('rejects when the composition is not published', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    world.batches.clear()
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-unavailable'),
    )
  })

  it('rejects a composition with a gap in seq', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    world.batches.set(3, { ...batch, receipts: batch.receipts.filter((_, i) => i !== 1) })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it('rejects a composition that mixes in an x402 receipt (FR-013c)', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    const { seq: _seq, ...rest } = receipt(2)
    const x402: ReceiptBody = { ...rest, paymentMethod: 'x402', paymentRef: '5'.repeat(88) }
    world.batches.set(3, { ...batch, receipts: batch.receipts.map((r, i) => (i === 1 ? x402 : r)) })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it('rejects a composition with an x402 receipt added on top of a full escrow run', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    const { seq: _seq, ...rest } = receipt(2)
    const x402: ReceiptBody = { ...rest, paymentMethod: 'x402', paymentRef: '5'.repeat(88) }
    world.batches.set(3, { ...batch, receipts: [...batch.receipts, x402] })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it('rejects a composition out of seq order', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    const [first, second, third] = batch.receipts
    if (!first || !second || !third) throw new Error('short batch')
    world.batches.set(3, { ...batch, receipts: [first, third, second] })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it("rejects a composition holding another payer's receipt", async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    const foreign = { ...receipt(2), consumer: key() }
    world.batches.set(3, {
      ...batch,
      receipts: batch.receipts.map((r, i) => (i === 1 ? foreign : r)),
    })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it("rejects a composition of another payer's receipts", async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    world.batches.set(3, { ...batch, consumer: key() })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('composition-malformed'),
    )
  })

  it('rejects a composition that does not hold the receipt at its seq', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    const batch = world.batches.get(3)
    if (batch === undefined) throw new Error('no batch')
    const other = { ...receipt(1), acceptedAt: '2026-10-03T12:00:00.000Z' }
    world.batches.set(3, {
      ...batch,
      receipts: batch.receipts.map((r, i) => (i === 0 ? other : r)),
    })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('receipt-not-in-composition'),
    )
  })

  it('rejects a later batch whose previous settlement does not exist', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const { ids } = settle(world, [receipt(3), receipt(4)], { previous: first })
    world.settlements.delete(first.txSig)
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('previous-batch-unverified'),
    )
  })

  it('rejects a later batch that does not point at its predecessor', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const { ids } = settle(world, [receipt(3), receipt(4)], { previous: first })
    const batch = world.batches.get(4)
    if (batch === undefined) throw new Error('no batch')
    world.batches.set(4, { ...batch, previous: null })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('previous-batch-unverified'),
    )
  })

  it('rejects a later batch that points past its predecessor at an older batch', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const second = settle(world, [receipt(3), receipt(4)], { previous: first })
    const { ids } = settle(world, [receipt(5), receipt(6)], { previous: second })
    const batch = world.batches.get(6)
    if (batch === undefined) throw new Error('no batch')
    world.batches.set(6, { ...batch, previous: { seqTo: 2, txSig: first.txSig } })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('previous-batch-unverified'),
    )
  })

  it('rejects a predecessor whose ring entry disagrees with its transaction', async () => {
    const world = newWorld()
    const first = settle(world, [receipt(1), receipt(2)])
    const { ids } = settle(world, [receipt(3), receipt(4)], { previous: first })
    world.ring = world.ring.map((entry) =>
      entry.seqEnd === 2n ? { ...entry, chain: 'cc'.repeat(32) } : entry,
    )
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtChain('previous-batch-unverified'),
    )
  })
})

describe('verifyReceipt — step 4, the amounts', () => {
  const rejectedAtAmounts = (reason: string) => ({
    outcome: 'rejected',
    steps: { onchain: PASS, inclusion: PASS, chain: PASS, amounts: fail(reason) },
  })

  it('rejects when the vault was debited more than the composition charges', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, { vaultDebit: 13_201n })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAmounts('debit-mismatch'),
    )
  })

  it('rejects when the treasury took other than the summed fees', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, { treasuryCredit: 1_199n })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAmounts('fee-mismatch'),
    )
  })

  it("rejects a payout that hands one publisher another's tariffs", async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, {
      legs: [
        { domain: DOMAIN_A, tariff: 8_000n },
        { domain: DOMAIN_B, tariff: 4_000n },
      ],
    })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAmounts('distribution-mismatch'),
    )
  })

  it('rejects a payout to a domain the composition owes nothing', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, honestFirstBatch())
    patchSettlement(world, txSig, {
      legs: [
        { domain: DOMAIN_A, tariff: 4_000n },
        { domain: DOMAIN_B, tariff: 8_000n },
        { domain: key(), tariff: 1_000n },
      ],
    })
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAmounts('distribution-mismatch'),
    )
  })

  it('rejects a composition naming a work the program does not hold', async () => {
    const world = newWorld()
    const { ids } = settle(world, honestFirstBatch())
    world.works.delete(WORK_B)
    expect(await verifyReceipt(ids[0] ?? '', sources(world))).toEqual(
      rejectedAtAmounts('work-not-registered'),
    )
  })

  it('accepts a zero-tariff receipt, which the settler pays no leg for', async () => {
    const world = newWorld()
    const { ids, txSig } = settle(world, [receipt(1), receipt(2, WORK_B, 0n)])
    patchSettlement(world, txSig, { legs: [{ domain: DOMAIN_A, tariff: 2_000n }] })
    expect(await verifyReceipt(ids[1] ?? '', sources(world))).toEqual(VERIFIED)
  })
})

describe('verifyReceipt — receipts with nothing to verify against a batch', () => {
  it('reports an id the gateway does not know', async () => {
    expect(await verifyReceipt('ab'.repeat(32), sources(newWorld()))).toEqual({
      outcome: 'unknown',
    })
  })

  it('reports a receipt that is not settled yet', async () => {
    const world = newWorld()
    const body = receipt(1)
    const id = receiptId(body)
    world.receipts.set(id, { body, anchor: { kind: 'pending' } })
    expect(await verifyReceipt(id, sources(world))).toEqual({ outcome: 'pending' })
  })

  it('reports a receipt anchored by its own x402 payment', async () => {
    const world = newWorld()
    const { seq: _seq, ...rest } = receipt(1)
    const body: ReceiptBody = { ...rest, paymentMethod: 'x402', paymentRef: '5'.repeat(88) }
    const id = receiptId(body)
    world.receipts.set(id, { body, anchor: { kind: 'payment', paymentRef: body.paymentRef } })
    expect(await verifyReceipt(id, sources(world))).toEqual({ outcome: 'payment' })
  })
})
