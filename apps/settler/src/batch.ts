import { chainStep, merkleRoot } from '@contentledger/shared'

/** An accepted escrow voucher with the receipt it pays for, not yet in any batch. */
export interface PendingVoucher {
  seq: bigint
  cumulative: bigint
  /** Hex, exactly as the agent signed it. */
  chain: string
  /** Base58 Ed25519 signature of the agent over the voucher message. */
  signature: string
  /** Hex of the receipt's leaf hash: the same digest is the tree leaf and the chain link. */
  receiptId: string
  /** Base58 `Domain` account the tariff is owed to. */
  domain: string
  tariff: bigint
  acceptedTs: Date
}

/** Where the escrow stands on chain: the next batch starts right after it. */
export interface SettledPosition {
  lastSeq: bigint
  chain: Uint8Array
}

export interface Leg {
  domain: string
  tariff: bigint
}

export interface Batch {
  seqFrom: bigint
  seqTo: bigint
  root: Uint8Array
  /** The voucher `settle_batch` verifies: it commits the agent to every receipt before it. */
  last: PendingVoucher
  receiptIds: string[]
  legs: Leg[]
}

export interface Cut {
  maxReceipts: number
  fits: (legs: readonly Leg[]) => boolean
}

export interface SettlePolicy {
  minReceipts: number
  maxAgeMs: number
}

/**
 * The longest prefix of `pending` that one transaction can settle. Packet size grows
 * with distinct recipients, never with receipts, so only a new domain is measured.
 */
export function composeBatch(
  pending: readonly PendingVoucher[],
  start: SettledPosition,
  cut: Cut,
): Batch {
  let owed = new Map<string, bigint>()
  const taken: PendingVoucher[] = []

  for (const voucher of pending) {
    if (taken.length === cut.maxReceipts) break
    const expected = start.lastSeq + BigInt(taken.length) + 1n
    if (voucher.seq !== expected) throw new Error(`pending vouchers skip seq ${expected}`)

    const before = legsOf(owed)
    const tentative = new Map(owed).set(
      voucher.domain,
      (owed.get(voucher.domain) ?? 0n) + voucher.tariff,
    )
    const legs = legsOf(tentative)
    if (legs.length > before.length && !cut.fits(legs)) {
      if (taken.length === 0) throw new Error('one recipient does not fit in a packet')
      break
    }
    owed = tentative
    taken.push(voucher)
  }

  const [first] = taken
  const last = taken.at(-1)
  if (first === undefined || last === undefined) throw new Error('nothing to settle')

  const leaves = taken.map((voucher) => Buffer.from(voucher.receiptId, 'hex'))
  const folded = leaves.reduce<Uint8Array>((chain, leaf) => chainStep(chain, leaf), start.chain)
  if (Buffer.from(folded).toString('hex') !== last.chain) {
    throw new Error(`receipts ${first.seq}..${last.seq} do not fold into the signed chain`)
  }

  return {
    seqFrom: first.seq,
    seqTo: last.seq,
    root: merkleRoot(leaves),
    last,
    receiptIds: taken.map((voucher) => voucher.receiptId),
    legs: legsOf(owed),
  }
}

const legsOf = (owed: ReadonlyMap<string, bigint>): Leg[] =>
  [...owed].filter(([, tariff]) => tariff > 0n).map(([domain, tariff]) => ({ domain, tariff }))

/**
 * A batch costs two signatures in fees whatever its size, so a lone receipt would cost
 * more than SC-001 allows. A requested withdrawal overrides both thresholds: once the
 * grace window ends the agent takes the whole vault, unsettled tariffs included.
 */
export function isDue(
  pending: readonly PendingVoucher[],
  withdrawAfter: bigint,
  policy: SettlePolicy,
  now: Date,
): boolean {
  const [oldest] = pending
  if (oldest === undefined) return false
  return (
    withdrawAfter !== 0n ||
    pending.length >= policy.minReceipts ||
    now.getTime() - oldest.acceptedTs.getTime() >= policy.maxAgeMs
  )
}
