import { escrowPda, type SettlementEntry } from '@contentledger/chain'
import {
  chainGenesis,
  chainStep,
  merkleRoot,
  type ReceiptBody,
  receiptId,
  receiptLeaf,
  verifyInclusion,
} from '@contentledger/shared'
import { PublicKey } from '@solana/web3.js'
import type { Network, Settlement } from './network.js'
import type { Publication, PublishedBatch } from './publication.js'

export type AnchorFailure =
  | 'settlement-not-found'
  | 'settlement-failed'
  | 'settlement-of-another-escrow'
  | 'settlement-of-another-batch'
  | 'ring-disagrees'

export type FailReason =
  | AnchorFailure
  | 'not-included'
  | 'composition-unavailable'
  | 'composition-malformed'
  | 'receipt-not-in-composition'
  | 'previous-batch-unverified'
  | 'chain-mismatch'
  | 'root-not-over-composition'
  | 'debit-mismatch'
  | 'fee-mismatch'
  | 'work-not-registered'
  | 'distribution-mismatch'

export type Verdict =
  | { status: 'pass' }
  | { status: 'fail'; reason: FailReason }
  | { status: 'skipped' }

export interface Steps {
  onchain: Verdict
  inclusion: Verdict
  chain: Verdict
  amounts: Verdict
}

/**
 * `tampered`: the body the gateway serves does not hash to the id asked about.
 * `pending` and `payment` have no batch to check against — not yet settled, or anchored
 * by the payer's own x402 transaction.
 */
export type Report =
  | { outcome: 'unknown' | 'tampered' | 'pending' | 'payment' }
  | { outcome: 'verified' | 'rejected'; steps: Steps }

export interface Sources {
  network: Network
  publication: Publication
}

type EscrowBody = Extract<ReceiptBody, { paymentMethod: 'escrow' }>

const PASS: Verdict = { status: 'pass' }
const SKIPPED: Verdict = { status: 'skipped' }
const fail = (reason: FailReason): Verdict => ({ status: 'fail', reason })

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))

/**
 * The four steps of FR-013a and FR-013d. The inclusion proof alone proves nothing: the
 * root is the gateway's, and a batch it made up whole is consistent with a root it built
 * over it. Only the chain the payer signed, recomputed over the published composition,
 * ties the batch to what was actually served.
 */
export async function verifyReceipt(
  id: string,
  { network, publication }: Sources,
): Promise<Report> {
  const published = await publication.receipt(id)
  if (published === null) return { outcome: 'unknown' }
  const { body, anchor } = published
  if (receiptId(body) !== id) return { outcome: 'tampered' }
  if (anchor.kind !== 'batch') return { outcome: anchor.kind }

  const escrow = escrowPda(new PublicKey(body.consumer))[0]
  const ring = await network.ring(escrow.toBase58())
  const seqTo = BigInt(anchor.seqTo)
  const anchored = await settlementOf(network, ring, escrow.toBase58(), seqTo, anchor.txSig)

  if (!anchored.ok) {
    return {
      outcome: 'rejected',
      steps: {
        onchain: fail(anchored.reason),
        inclusion: SKIPPED,
        chain: SKIPPED,
        amounts: SKIPPED,
      },
    }
  }
  const { settlement } = anchored

  // The tree's leaves are the receipt leaf hashes themselves, as the gateway and the settler
  // build it: `merkleRoot` hashes each of them once more under the leaf prefix.
  const inclusion = verifyInclusion(receiptLeaf(body), anchor.path, bytes(settlement.root))
    ? PASS
    : fail('not-included')

  const recomputed = await recomputeChain(id, body, seqTo, settlement, {
    network,
    publication,
    ring,
    escrow: escrow.toBytes(),
  })
  const amounts =
    recomputed.composition === undefined
      ? SKIPPED
      : await reconcileAmounts(network, settlement, recomputed.composition)

  const steps: Steps = { onchain: PASS, inclusion, chain: recomputed.verdict, amounts }
  const verified = Object.values(steps).every((step) => step.status === 'pass')
  return { outcome: verified ? 'verified' : 'rejected', steps }
}

type Anchored = { ok: true; settlement: Settlement } | { ok: false; reason: AnchorFailure }

/**
 * The transaction is always read — its balances are what step 4 reconciles — and the ring,
 * while it still holds the batch, must say the same: two records the program wrote.
 */
async function settlementOf(
  network: Network,
  ring: readonly SettlementEntry[],
  escrow: string,
  seqEnd: bigint,
  txSig: string,
): Promise<Anchored> {
  const settlement = await network.settlement(txSig)
  if (settlement === null) return { ok: false, reason: 'settlement-not-found' }
  if (!settlement.succeeded) return { ok: false, reason: 'settlement-failed' }
  if (settlement.escrow !== escrow) return { ok: false, reason: 'settlement-of-another-escrow' }
  if (settlement.seq !== seqEnd) return { ok: false, reason: 'settlement-of-another-batch' }
  const entry = ring.find((candidate) => candidate.seqEnd === seqEnd)
  if (entry && (entry.root !== settlement.root || entry.chain !== settlement.chain)) {
    return { ok: false, reason: 'ring-disagrees' }
  }
  return { ok: true, settlement }
}

interface ChainContext extends Sources {
  ring: readonly SettlementEntry[]
  escrow: Uint8Array
}

async function recomputeChain(
  id: string,
  body: ReceiptBody,
  seqTo: bigint,
  settlement: Settlement,
  context: ChainContext,
): Promise<{ verdict: Verdict; composition?: readonly EscrowBody[] }> {
  const batch = await context.publication.batch(body.consumer, Number(seqTo))
  if (batch === null) return { verdict: fail('composition-unavailable') }
  const composition = wellFormed(batch, body.consumer, seqTo)
  if (composition === null) return { verdict: fail('composition-malformed') }

  const leaves = composition.map(receiptLeaf)
  const position = body.paymentMethod === 'escrow' ? body.seq - batch.seqFrom : -1
  const own = leaves[position]
  if (own === undefined || hex(own) !== id) return { verdict: fail('receipt-not-in-composition') }

  const start = await startingChain(batch, context)
  if (start === null) return { verdict: fail('previous-batch-unverified') }
  if (hex(leaves.reduce(chainStep, start)) !== settlement.chain) {
    return { verdict: fail('chain-mismatch') }
  }
  if (hex(merkleRoot(leaves)) !== settlement.root) {
    return { verdict: fail('root-not-over-composition') }
  }
  return { verdict: PASS, composition }
}

function wellFormed(
  batch: PublishedBatch,
  consumer: string,
  seqTo: bigint,
): readonly EscrowBody[] | null {
  const escrowOnly = batch.receipts.filter(
    (receipt): receipt is EscrowBody => receipt.paymentMethod === 'escrow',
  )
  const contiguous = escrowOnly.every(
    (receipt, i) => receipt.consumer === consumer && receipt.seq === batch.seqFrom + i,
  )
  const covers =
    BigInt(batch.seqTo) === seqTo &&
    escrowOnly.length === batch.receipts.length &&
    BigInt(escrowOnly.length) === seqTo - BigInt(batch.seqFrom) + 1n
  return batch.consumer === consumer && contiguous && covers ? escrowOnly : null
}

/** The previous batch's chain comes off the network too, never from the gateway. */
async function startingChain(
  batch: PublishedBatch,
  { network, ring, escrow }: ChainContext,
): Promise<Uint8Array | null> {
  if (batch.seqFrom === 1) return chainGenesis(escrow)
  const previous = batch.previous
  if (previous === null || previous.seqTo !== batch.seqFrom - 1) return null
  const anchored = await settlementOf(
    network,
    ring,
    new PublicKey(escrow).toBase58(),
    BigInt(previous.seqTo),
    previous.txSig,
  )
  return anchored.ok ? bytes(anchored.settlement.chain) : null
}

/**
 * The program checks the totals and nothing about who got which tariff, so the split by
 * domain is where a gateway could still lie — and where this check is the only witness.
 */
async function reconcileAmounts(
  network: Network,
  settlement: Settlement,
  composition: readonly EscrowBody[],
): Promise<Verdict> {
  const total = (pick: (receipt: EscrowBody) => bigint) =>
    composition.reduce((sum, receipt) => sum + pick(receipt), 0n)
  if (total((r) => BigInt(r.tariff) + BigInt(r.fee)) !== settlement.vaultDebit) {
    return fail('debit-mismatch')
  }
  if (total((r) => BigInt(r.fee)) !== settlement.treasuryCredit) return fail('fee-mismatch')

  const domains = await network.workDomains([...new Set(composition.map((r) => r.work))])
  const owed = new Map<string, bigint>()
  for (const receipt of composition) {
    const domain = domains.get(receipt.work)
    if (domain === undefined) return fail('work-not-registered')
    owed.set(domain, (owed.get(domain) ?? 0n) + BigInt(receipt.tariff))
  }
  const paid = new Map<string, bigint>()
  for (const leg of settlement.legs) {
    paid.set(leg.domain, (paid.get(leg.domain) ?? 0n) + leg.tariff)
  }
  return sameNonZero(owed, paid) ? PASS : fail('distribution-mismatch')
}

// The settler pays no leg to a domain owed nothing, so a zero on one side is no entry.
function sameNonZero(a: ReadonlyMap<string, bigint>, b: ReadonlyMap<string, bigint>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()])
  return [...keys].every((key) => (a.get(key) ?? 0n) === (b.get(key) ?? 0n))
}
