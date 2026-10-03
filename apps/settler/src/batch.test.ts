import { chainGenesis, chainStep, merkleRoot } from '@contentledger/shared'
import { describe, expect, it } from 'vitest'
import { composeBatch, isDue, type Leg, type PendingVoucher } from './batch.js'

const GENESIS = chainGenesis(new Uint8Array(32).fill(5))
const ACME = 'Acme1111111111111111111111111111111111111111'
const DEVBLOG = 'Dev11111111111111111111111111111111111111111'
const PHOTO = 'Photo111111111111111111111111111111111111111'
const NOW = new Date('2026-10-03T12:00:00.000Z')

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const leafOf = (seq: number) => new Uint8Array(32).fill(seq)

/** A run of vouchers whose chain really folds from `start`, as the gateway accepted them. */
function run(
  lines: readonly { domain: string; tariff: bigint; ageS?: number }[],
  { firstSeq = 1, start = GENESIS, cumulative = 0n } = {},
): PendingVoucher[] {
  let chain = start
  let total = cumulative
  return lines.map((line, i) => {
    const seq = firstSeq + i
    chain = chainStep(chain, leafOf(seq))
    total += line.tariff + line.tariff / 10n
    return {
      seq: BigInt(seq),
      cumulative: total,
      chain: hex(chain),
      signature: `sig${seq}`,
      receiptId: hex(leafOf(seq)),
      domain: line.domain,
      tariff: line.tariff,
      acceptedTs: new Date(NOW.getTime() - (line.ageS ?? 0) * 1000),
    }
  })
}

const anything = { maxReceipts: 50, fits: () => true }

describe('composeBatch', () => {
  it('anchors the root of the receipt leaves and settles the last voucher', () => {
    const pending = run([
      { domain: ACME, tariff: 2000n },
      { domain: DEVBLOG, tariff: 500n },
      { domain: ACME, tariff: 2000n },
    ])
    const batch = composeBatch(pending, { lastSeq: 0n, chain: GENESIS }, anything)
    expect(batch.seqFrom).toBe(1n)
    expect(batch.seqTo).toBe(3n)
    expect(batch.last).toBe(pending[2])
    expect(batch.root).toEqual(merkleRoot([leafOf(1), leafOf(2), leafOf(3)]))
    expect(batch.receiptIds).toEqual(pending.map((p) => p.receiptId))
  })

  it('pays each domain once, in order of first appearance', () => {
    const pending = run([
      { domain: DEVBLOG, tariff: 500n },
      { domain: ACME, tariff: 2000n },
      { domain: DEVBLOG, tariff: 700n },
    ])
    expect(composeBatch(pending, { lastSeq: 0n, chain: GENESIS }, anything).legs).toEqual([
      { domain: DEVBLOG, tariff: 1200n },
      { domain: ACME, tariff: 2000n },
    ])
  })

  // A free work still sits in the agent's chain, but a zero leg would only spend
  // three accounts of the packet on a transfer of nothing.
  it('keeps free receipts in the batch without a leg for them', () => {
    const pending = run([
      { domain: ACME, tariff: 2000n },
      { domain: PHOTO, tariff: 0n },
    ])
    const batch = composeBatch(pending, { lastSeq: 0n, chain: GENESIS }, anything)
    expect(batch.seqTo).toBe(2n)
    expect(batch.legs).toEqual([{ domain: ACME, tariff: 2000n }])
  })

  it('continues from a settled position', () => {
    const before = run([{ domain: ACME, tariff: 2000n }])
    const after = run([{ domain: ACME, tariff: 2000n }], {
      firstSeq: 2,
      start: Buffer.from(before[0]?.chain ?? '', 'hex'),
      cumulative: 2200n,
    })
    const batch = composeBatch(
      after,
      { lastSeq: 1n, chain: Buffer.from(before[0]?.chain ?? '', 'hex') },
      anything,
    )
    expect(batch.seqFrom).toBe(2n)
    expect(batch.seqTo).toBe(2n)
  })

  it('stops before the receipt whose new domain would overflow the packet', () => {
    const pending = run([
      { domain: ACME, tariff: 2000n },
      { domain: DEVBLOG, tariff: 500n },
      { domain: ACME, tariff: 2000n },
      { domain: PHOTO, tariff: 900n },
      { domain: ACME, tariff: 2000n },
    ])
    const asked: Leg[][] = []
    const fits = (legs: readonly Leg[]) => {
      asked.push([...legs])
      return legs.length <= 2
    }
    const batch = composeBatch(pending, { lastSeq: 0n, chain: GENESIS }, { maxReceipts: 50, fits })
    expect(batch.seqTo).toBe(3n)
    expect(batch.legs.map((leg) => leg.domain)).toEqual([ACME, DEVBLOG])
    // Size grows only with a new recipient, so a repeated domain is not measured again.
    expect(asked.map((legs) => legs.length)).toEqual([1, 2, 3])
  })

  it('caps the number of receipts', () => {
    const pending = run(Array.from({ length: 5 }, () => ({ domain: ACME, tariff: 1n })))
    const batch = composeBatch(
      pending,
      { lastSeq: 0n, chain: GENESIS },
      { maxReceipts: 3, fits: () => true },
    )
    expect(batch.seqTo).toBe(3n)
  })

  it('refuses vouchers that do not start right after the settled seq', () => {
    const pending = run([{ domain: ACME, tariff: 2000n }], { firstSeq: 3 })
    expect(() => composeBatch(pending, { lastSeq: 1n, chain: GENESIS }, anything)).toThrow(/seq 2/)
  })

  it('refuses a gap inside the run', () => {
    const pending = run([
      { domain: ACME, tariff: 2000n },
      { domain: ACME, tariff: 2000n },
      { domain: ACME, tariff: 2000n },
    ])
    expect(() =>
      composeBatch(
        [pending[0], pending[2]] as PendingVoucher[],
        { lastSeq: 0n, chain: GENESIS },
        anything,
      ),
    ).toThrow(/seq 2/)
  })

  // The program checks only the signature over `chain`; a composition that does not fold
  // into it would be anchored, paid out and then fail step 3 of every verification.
  it('refuses a composition that does not fold into the signed chain', () => {
    const pending = run([
      { domain: ACME, tariff: 2000n },
      { domain: ACME, tariff: 2000n },
    ])
    const swapped = pending.map((p, i) => (i === 0 ? { ...p, receiptId: hex(leafOf(9)) } : p))
    expect(() => composeBatch(swapped, { lastSeq: 0n, chain: GENESIS }, anything)).toThrow(/chain/)
  })

  it('refuses to start from a chain other than the escrow’s', () => {
    const pending = run([{ domain: ACME, tariff: 2000n }])
    expect(() =>
      composeBatch(pending, { lastSeq: 0n, chain: new Uint8Array(32) }, anything),
    ).toThrow(/chain/)
  })

  it('refuses when even one recipient does not fit', () => {
    const pending = run([{ domain: ACME, tariff: 2000n }])
    expect(() =>
      composeBatch(
        pending,
        { lastSeq: 0n, chain: GENESIS },
        { maxReceipts: 50, fits: () => false },
      ),
    ).toThrow(/packet/)
  })

  it('refuses an empty run', () => {
    expect(() => composeBatch([], { lastSeq: 0n, chain: GENESIS }, anything)).toThrow()
  })
})

describe('isDue', () => {
  const policy = { minReceipts: 3, maxAgeMs: 300_000 }

  it('waits while there are few and fresh receipts', () => {
    const pending = run([
      { domain: ACME, tariff: 1n, ageS: 299 },
      { domain: ACME, tariff: 1n },
    ])
    expect(isDue(pending, 0n, policy, NOW)).toBe(false)
  })

  it('settles once enough receipts have gathered', () => {
    const pending = run(Array.from({ length: 3 }, () => ({ domain: ACME, tariff: 1n })))
    expect(isDue(pending, 0n, policy, NOW)).toBe(true)
  })

  it('settles once the oldest has waited long enough', () => {
    expect(isDue(run([{ domain: ACME, tariff: 1n, ageS: 300 }]), 0n, policy, NOW)).toBe(true)
  })

  // After the grace window the agent takes the whole vault, publishers' money with it.
  it('settles at once when the agent has asked to withdraw', () => {
    expect(isDue(run([{ domain: ACME, tariff: 1n }]), 1_790_000_000n, policy, NOW)).toBe(true)
  })

  it('has nothing to settle without receipts', () => {
    expect(isDue([], 1_790_000_000n, policy, NOW)).toBe(false)
  })
})
