import { BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  decodeConfig,
  decodeDomain,
  decodeEscrow,
  decodeTokenAmount,
  decodeWork,
} from './accounts.js'
import { coder } from './program.js'

const authority = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const treasuryAta = Keypair.generate().publicKey
const owner = Keypair.generate().publicKey
const domainKey = Keypair.generate().publicKey

const encodeConfig = () =>
  coder.accounts.encode('Config', {
    authority,
    treasury_ata: treasuryAta,
    mint,
    protocol_fee_bps: 250,
    node_share_bps: 0,
    voucher_grace_s: new BN(900),
    paused: false,
    bump: 254,
    reserved: Array(64).fill(0),
  })

const encodeDomain = () =>
  coder.accounts.encode('Domain', {
    owner,
    payout_owner: owner,
    host: 'example.com',
    rate_train: new BN(2_000),
    rate_inference: new BN(500),
    status: { Active: {} },
    bump: 253,
    reserved: Array(32).fill(0),
  })

const encodeWork = (rateTrain: BN | null) =>
  coder.accounts.encode('Work', {
    domain: domainKey,
    source_hash: Array(32).fill(0x11),
    content_hash: Array(32).fill(0x22),
    rate_train: rateTrain,
    rate_inference: null,
    status: { Suspended: {} },
    attested_by: 3,
    bump: 252,
    reserved: Array(32).fill(0),
  })

describe('декодери', () => {
  it('гроші приходять bigint, а не BN і не number', async () => {
    const config = decodeConfig(await encodeConfig())
    expect(config.voucherGraceS).toBe(900n)
    expect(typeof config.voucherGraceS).toBe('bigint')

    const domain = decodeDomain(await encodeDomain())
    expect(domain.rateTrain).toBe(2_000n)
    expect(domain.rateInference).toBe(500n)
  })

  it('Config декодується цілком', async () => {
    const config = decodeConfig(await encodeConfig())
    expect(config.authority).toBe(authority.toBase58())
    expect(config.treasuryAta).toBe(treasuryAta.toBase58())
    expect(config.mint).toBe(mint.toBase58())
    expect(config.protocolFeeBps).toBe(250)
    expect(config.nodeShareBps).toBe(0)
    expect(config.paused).toBe(false)
    expect(config.bump).toBe(254)
  })

  it('Domain віддає статус рядком, а не обʼєктом anchor', async () => {
    const domain = decodeDomain(await encodeDomain())
    expect(domain.status).toBe('active')
    expect(domain.host).toBe('example.com')
    expect(domain.owner).toBe(owner.toBase58())
    expect(domain.payoutOwner).toBe(owner.toBase58())
  })

  it('перекриття ставки лишається null, а не нулем', async () => {
    const work = decodeWork(await encodeWork(null))
    expect(work.rateTrain).toBe(null)
    expect(work.rateInference).toBe(null)
  })

  it('нульове перекриття лишається нулем, а не null', async () => {
    const work = decodeWork(await encodeWork(new BN(0)))
    expect(work.rateTrain).toBe(0n)
  })

  it('Work декодується цілком', async () => {
    const work = decodeWork(await encodeWork(new BN(9_000)))
    expect(work.domain).toBe(domainKey.toBase58())
    expect(work.sourceHash).toBe('11'.repeat(32))
    expect(work.contentHash).toBe('22'.repeat(32))
    expect(work.status).toBe('suspended')
    expect(work.attestedBy).toBe(3)
    expect(work.bump).toBe(252)
  })

  it('чужий дискримінатор відхиляється, а не декодується як своє', async () => {
    const bytes = await encodeDomain()
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    expect(() => decodeDomain(bytes)).toThrow()
  })
})

const encodeEscrow = (withdrawAfter: number) =>
  coder.accounts.encode('Escrow', {
    consumer: owner,
    vault: domainKey,
    settled_total: new BN('18446744073709551615'),
    last_seq: new BN(41),
    last_chain: Array(32).fill(0xab),
    withdraw_after: new BN(withdrawAfter),
    bump: 251,
    vault_bump: 250,
    reserved: Array(32).fill(0),
  })

describe('decodeEscrow', () => {
  it('decodes every field in application form', async () => {
    const escrow = decodeEscrow(await encodeEscrow(1_790_000_000))
    expect(escrow).toEqual({
      consumer: owner.toBase58(),
      vault: domainKey.toBase58(),
      settledTotal: 18_446_744_073_709_551_615n,
      lastSeq: 41n,
      lastChain: 'ab'.repeat(32),
      withdrawAfter: 1_790_000_000n,
      bump: 251,
      vaultBump: 250,
    })
  })

  it('keeps a zero withdraw_after as 0n, the "no request" marker', async () => {
    expect(decodeEscrow(await encodeEscrow(0)).withdrawAfter).toBe(0n)
  })

  it('rejects another account type', async () => {
    const bytes = await encodeDomain()
    expect(() => decodeEscrow(bytes)).toThrow()
  })
})

describe('decodeTokenAmount', () => {
  const tokenAccount = (amount: bigint, length = 165) => {
    const data = Buffer.alloc(length)
    data.fill(0x77, 0, 64)
    data.writeBigUInt64LE(amount, 64)
    return new Uint8Array(data)
  }

  it('reads the full u64 range exactly', () => {
    expect(decodeTokenAmount(tokenAccount(18_446_744_073_709_551_615n))).toBe(
      18_446_744_073_709_551_615n,
    )
    expect(decodeTokenAmount(tokenAccount(0n))).toBe(0n)
  })

  it('rejects data that is not a legacy token account', () => {
    expect(() => decodeTokenAmount(tokenAccount(5n, 82))).toThrow(/token account/)
    expect(() => decodeTokenAmount(tokenAccount(5n, 170))).toThrow(/token account/)
  })
})
