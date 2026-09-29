import { escrowPda } from '@contentledger/chain'
import {
  chainGenesis,
  chainStep,
  type ReceiptBody,
  receiptLeaf,
  type Voucher,
  voucherMessage,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type EscrowReceiptBody,
  type PresentedVoucher,
  parseVoucherHeader,
  type VoucherPosition,
  verifyVoucher,
} from './voucher.js'

const agentSecret = new Uint8Array(32).fill(7)
const strangerSecret = new Uint8Array(32).fill(8)
const consumer = new PublicKey(ed25519.getPublicKey(agentSecret))
const [escrow] = escrowPda(consumer)
const work = new PublicKey(new Uint8Array(32).fill(9)).toBase58()

const genesis: VoucherPosition = {
  seq: 0n,
  cumulative: 0n,
  chain: chainGenesis(escrow.toBytes()),
}

const bodyAt = (seq: number, overrides: Partial<EscrowReceiptBody> = {}): EscrowReceiptBody => ({
  consumer: consumer.toBase58(),
  work,
  useType: 'train',
  tariff: '2000',
  fee: '200',
  rateLevel: 'domain',
  servedHash: 'ab'.repeat(32),
  registryHash: 'ab'.repeat(32),
  acceptedAt: '2026-09-29T10:00:00.000Z',
  paymentMethod: 'escrow',
  seq,
  ...overrides,
})

const sign = (voucher: Voucher, secret = agentSecret): PresentedVoucher => ({
  ...voucher,
  signature: ed25519.sign(voucherMessage(voucher), secret),
})

/** What an honest agent signs after reading the draft body from the 402. */
const honest = (previous: VoucherPosition, body: ReceiptBody): Voucher => ({
  escrow: escrow.toBytes(),
  seq: previous.seq + 1n,
  cumulative: previous.cumulative + BigInt(body.tariff) + BigInt(body.fee),
  chain: chainStep(previous.chain, receiptLeaf(body)),
})

const encodeHeader = (fields: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(fields)).toString('base64url')

const headerFields = (voucher: PresentedVoucher) => ({
  escrow: new PublicKey(voucher.escrow).toBase58(),
  seq: Number(voucher.seq),
  cumulative: voucher.cumulative.toString(),
  chain: Buffer.from(voucher.chain).toString('hex'),
  sig: utils.bytes.bs58.encode(Buffer.from(voucher.signature)),
})

describe('verifyVoucher', () => {
  it('accepts the first voucher from genesis and advances the position', () => {
    const body = bodyAt(1)
    const voucher = sign(honest(genesis, body))

    const verdict = verifyVoucher(voucher, body, genesis)

    expect(verdict).toEqual({
      ok: true,
      position: { seq: 1n, cumulative: 2200n, chain: voucher.chain },
    })
  })

  it('accepts a voucher chained on the previous accepted one', () => {
    const first = bodyAt(1)
    const afterFirst: VoucherPosition = {
      seq: 1n,
      cumulative: 2200n,
      chain: chainStep(genesis.chain, receiptLeaf(first)),
    }
    const second = bodyAt(2, { tariff: '9000', fee: '900', rateLevel: 'work' })

    const verdict = verifyVoucher(sign(honest(afterFirst, second)), second, afterFirst)

    expect(verdict).toMatchObject({ ok: true, position: { seq: 2n, cumulative: 12100n } })
  })

  it('accepts a zero-rate voucher whose cumulative does not grow', () => {
    const body = bodyAt(1, { tariff: '0', fee: '0' })

    const verdict = verifyVoucher(sign(honest(genesis, body)), body, genesis)

    expect(verdict).toMatchObject({ ok: true, position: { seq: 1n, cumulative: 0n } })
  })

  it('refuses the same voucher presented a second time', () => {
    const body = bodyAt(1)
    const voucher = sign(honest(genesis, body))
    const accepted = verifyVoucher(voucher, body, genesis)
    if (!accepted.ok) throw new Error('first presentation must pass')

    expect(verifyVoucher(voucher, body, accepted.position)).toEqual({
      ok: false,
      reason: 'replayed',
    })
  })

  it('refuses an older voucher once the position has moved past it', () => {
    const body = bodyAt(1)
    const moved: VoucherPosition = { seq: 5n, cumulative: 11000n, chain: genesis.chain }

    expect(verifyVoucher(sign(honest(genesis, body)), body, moved)).toEqual({
      ok: false,
      reason: 'replayed',
    })
  })

  it('refuses a voucher that skips a sequence number', () => {
    const body = bodyAt(2)
    const skipping = { ...honest(genesis, body), seq: 2n }

    expect(verifyVoucher(sign(skipping), body, genesis)).toEqual({
      ok: false,
      reason: 'seq-gap',
    })
  })

  it('refuses a voucher whose seq differs from the offered body', () => {
    const body = bodyAt(2)

    expect(verifyVoucher(sign(honest(genesis, body)), body, genesis)).toEqual({
      ok: false,
      reason: 'body-mismatch',
    })
  })

  it('refuses a voucher signed by someone other than the escrow consumer', () => {
    const body = bodyAt(1)

    expect(verifyVoucher(sign(honest(genesis, body), strangerSecret), body, genesis)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('refuses a voucher altered after signing', () => {
    const body = bodyAt(1)
    const signed = sign(honest(genesis, body))

    expect(verifyVoucher({ ...signed, cumulative: 1n }, body, genesis)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it("refuses a voucher naming another agent's escrow", () => {
    const body = bodyAt(1)
    const [otherEscrow] = escrowPda(new PublicKey(ed25519.getPublicKey(strangerSecret)))
    const voucher = sign({ ...honest(genesis, body), escrow: otherEscrow.toBytes() })

    expect(verifyVoucher(voucher, body, genesis)).toEqual({
      ok: false,
      reason: 'escrow-mismatch',
    })
  })

  it.each([
    ['underpays', 2199n],
    ['overpays', 2201n],
    ['goes backwards', -1n],
  ])('refuses a voucher whose cumulative %s', (_, delta) => {
    const previous: VoucherPosition = { ...genesis, seq: 3n, cumulative: 5000n }
    const body = bodyAt(4)
    const voucher = sign({ ...honest(previous, body), cumulative: previous.cumulative + delta })

    expect(verifyVoucher(voucher, body, previous)).toEqual({
      ok: false,
      reason: 'amount-mismatch',
    })
  })

  it('refuses a voucher chained over a body other than the offered one', () => {
    const offered = bodyAt(1)
    const signedOver = bodyAt(1, { servedHash: 'cd'.repeat(32) })

    expect(verifyVoucher(sign(honest(genesis, signedOver)), offered, genesis)).toEqual({
      ok: false,
      reason: 'chain-mismatch',
    })
  })

  it('refuses a voucher chained from a position other than the accepted one', () => {
    const body = bodyAt(1)
    const forked: VoucherPosition = { ...genesis, chain: new Uint8Array(32) }

    expect(verifyVoucher(sign(honest(forked, body)), body, genesis)).toEqual({
      ok: false,
      reason: 'chain-mismatch',
    })
  })
})

describe('parseVoucherHeader', () => {
  const voucher = sign(honest(genesis, bodyAt(1)))

  it('decodes the header an agent sends', () => {
    expect(parseVoucherHeader(encodeHeader(headerFields(voucher)))).toEqual(voucher)
  })

  it('keeps cumulative exact above 2^53', () => {
    const header = encodeHeader({ ...headerFields(voucher), cumulative: '18446744073709551615' })

    expect(parseVoucherHeader(header)?.cumulative).toBe(18446744073709551615n)
  })

  it.each([
    ['not base64url', '!!!'],
    ['not JSON', Buffer.from('{seq:').toString('base64url')],
    ['a JSON array', Buffer.from('[]').toString('base64url')],
  ])('rejects a header that is %s', (_, header) => {
    expect(parseVoucherHeader(header)).toBeNull()
  })

  it('rejects a valid header with characters base64url does not have', () => {
    const header = encodeHeader(headerFields(voucher))

    expect(parseVoucherHeader(`${header.slice(0, 8)}.${header.slice(8)}`)).toBeNull()
  })

  it.each([
    ['a missing field', { sig: undefined }],
    ['an unknown field', { extra: 1 }],
    ['seq zero', { seq: 0 }],
    ['a fractional seq', { seq: 1.5 }],
    ['cumulative as a number', { cumulative: 2200 }],
    ['cumulative above u64', { cumulative: '18446744073709551616' }],
    ['an uppercase chain', { chain: 'AB'.repeat(32) }],
    ['a short chain', { chain: 'ab'.repeat(31) }],
    ['an escrow that is not a key', { escrow: 'z'.repeat(44) }],
    // 87 base58 characters: inside the signature regex, so only the byte count catches it.
    ['a 63-byte signature', { sig: utils.bytes.bs58.encode(Buffer.alloc(63, 0xff)) }],
  ])('rejects %s', (_, change) => {
    expect(parseVoucherHeader(encodeHeader({ ...headerFields(voucher), ...change }))).toBeNull()
  })
})
