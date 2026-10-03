import { voucherMessage } from '@contentledger/shared'
import { ed25519 } from '@noble/curves/ed25519'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { hostSeed } from './identifiers.js'
import {
  buildDeposit,
  buildInitConfig,
  buildOpenEscrow,
  buildRegisterDomain,
  buildRegisterWork,
  buildSetDomainRates,
  buildSetDomainStatus,
  buildSettleBatch,
  buildSetWorkRates,
  buildSetWorkStatus,
  decodeInstruction,
} from './instructions.js'
import {
  associatedTokenAddress,
  configPda,
  domainPda,
  escrowPda,
  settlementLogPda,
  vaultPda,
  workPda,
} from './pda.js'
import { PROGRAM_ID } from './program.js'

const authority = Keypair.generate().publicKey
const owner = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const treasuryAta = Keypair.generate().publicKey

const HOST = 'example.com'
const SOURCE = 'https://example.com/articles/1'

describe('білдери інструкцій', () => {
  it('усі йдуть у нашу програму', () => {
    const instructions = [
      buildInitConfig({
        authority,
        mint,
        treasuryAta,
        protocolFeeBps: 250,
        nodeShareBps: 0,
        voucherGraceS: 900n,
      }),
      buildRegisterDomain({
        payer: owner,
        host: HOST,
        owner,
        payoutOwner: owner,
        rateTrain: 2_000n,
        rateInference: 500n,
      }),
      buildSetDomainStatus({ owner, host: HOST, status: 'suspended' }),
    ]
    for (const instruction of instructions) {
      expect(instruction.programId.toBase58()).toBe(PROGRAM_ID.toBase58())
    }
  })

  /// Anchor-кодувальник мовчки пише нуль на місце відсутнього поля, тож кожен
  /// білдер перевіряється зворотним декодуванням, а не лише тим, що не впав.
  it('init_config переживає round-trip', () => {
    const instruction = buildInitConfig({
      authority,
      mint,
      treasuryAta,
      protocolFeeBps: 250,
      nodeShareBps: 125,
      voucherGraceS: 900n,
    })
    expect(decodeInstruction(instruction)).toEqual({
      name: 'init_config',
      data: { protocol_fee_bps: 250, node_share_bps: 125, voucher_grace_s: 900n },
    })
  })

  it('register_domain переживає round-trip разом із хешем хоста', () => {
    const instruction = buildRegisterDomain({
      payer: authority,
      host: HOST,
      owner,
      payoutOwner: owner,
      rateTrain: 2_000n,
      rateInference: 500n,
    })
    const decoded = decodeInstruction(instruction)
    expect(decoded.name).toBe('register_domain')
    expect(decoded.data.host).toBe(HOST)
    expect(decoded.data.owner).toBe(owner.toBase58())
    expect(decoded.data.payout_owner).toBe(owner.toBase58())
    expect(decoded.data.rate_train).toBe(2_000n)
    expect(decoded.data.rate_inference).toBe(500n)
  })

  /// Саме на цьому місці camelCase давав буфер правильної довжини з нульовим
  /// хешем — тобто транзакцію, яка створює домен під іншим сідом.
  it('хеш хоста доїжджає ненульовим', () => {
    const decoded = decodeInstruction(
      buildRegisterDomain({
        payer: authority,
        host: HOST,
        owner,
        payoutOwner: owner,
        rateTrain: 1n,
        rateInference: 1n,
      }),
    )
    expect(decoded.data.host_hash).toEqual(Array.from(hostSeed(HOST)))
    expect(decoded.data.host_hash.every((byte: number) => byte === 0)).toBe(false)
  })

  it('register_work переживає round-trip', () => {
    const contentHash = new Uint8Array(32).fill(0xab)
    const instruction = buildRegisterWork({
      payer: owner,
      host: HOST,
      source: SOURCE,
      contentHash,
    })
    const decoded = decodeInstruction(instruction)
    expect(decoded.name).toBe('register_work')
    expect(decoded.data.content_hash).toEqual(Array.from(contentHash))
  })

  it('перекриття ставки: Some і None доходять різними байтами', () => {
    const withOverride = decodeInstruction(
      buildSetWorkRates({
        owner,
        host: HOST,
        source: SOURCE,
        rateTrain: 9_000n,
        rateInference: null,
      }),
    )
    const cleared = decodeInstruction(
      buildSetWorkRates({
        owner,
        host: HOST,
        source: SOURCE,
        rateTrain: null,
        rateInference: null,
      }),
    )
    expect(withOverride.data.rate_train).toBe(9_000n)
    expect(cleared.data.rate_train).toBe(null)
  })

  it('нуль як ставка не перетворюється на «не задано»', () => {
    const decoded = decodeInstruction(
      buildSetWorkRates({ owner, host: HOST, source: SOURCE, rateTrain: 0n, rateInference: null }),
    )
    expect(decoded.data.rate_train).toBe(0n)
  })

  it('статус кодується обома значеннями', () => {
    expect(
      decodeInstruction(buildSetWorkStatus({ owner, host: HOST, source: SOURCE, status: 'active' }))
        .data.status,
    ).toEqual({
      Active: {},
    })
    expect(
      decodeInstruction(buildSetDomainStatus({ owner, host: HOST, status: 'suspended' })).data
        .status,
    ).toEqual({
      Suspended: {},
    })
  })

  it('set_domain_rates переживає round-trip', () => {
    const decoded = decodeInstruction(
      buildSetDomainRates({ owner, host: HOST, rateTrain: 7_000n, rateInference: 1_250n }),
    )
    expect(decoded.data).toEqual({ rate_train: 7_000n, rate_inference: 1_250n })
  })
})

describe('склад акаунтів', () => {
  it('init_config несе config-PDA і системну програму', () => {
    const instruction = buildInitConfig({
      authority,
      mint,
      treasuryAta,
      protocolFeeBps: 250,
      nodeShareBps: 0,
      voucherGraceS: 900n,
    })
    const keys = instruction.keys.map((key) => key.pubkey.toBase58())
    expect(keys[0]).toBe(authority.toBase58())
    expect(keys[1]).toBe(configPda()[0].toBase58())
    expect(keys).toContain(PublicKey.default.toBase58())
  })

  it('register_work несе домен і твір у правильному порядку', () => {
    const instruction = buildRegisterWork({
      payer: owner,
      host: HOST,
      source: SOURCE,
      contentHash: new Uint8Array(32),
    })
    const keys = instruction.keys.map((key) => key.pubkey.toBase58())
    expect(keys[2]).toBe(domainPda(HOST)[0].toBase58())
    expect(keys[3]).toBe(workPda(SOURCE)[0].toBase58())
  })

  it('платник і власник — єдині підписанти', () => {
    const instruction = buildRegisterDomain({
      payer: authority,
      host: HOST,
      owner,
      payoutOwner: owner,
      rateTrain: 1n,
      rateInference: 1n,
    })
    const signers = instruction.keys.filter((key) => key.isSigner)
    expect(signers).toHaveLength(1)
    expect(signers[0]?.pubkey.toBase58()).toBe(authority.toBase58())
  })
})

describe('settle_batch', () => {
  const agent = Keypair.generate()
  const [escrow] = escrowPda(agent.publicKey)
  const chain = new Uint8Array(32).fill(0xc4)
  const root = new Uint8Array(32).fill(0x7a)
  const voucher = { seq: 12n, cumulative: 26_400n, chain }
  const message = voucherMessage({ escrow: escrow.toBytes(), ...voucher })
  const signature = ed25519.sign(message, agent.secretKey.slice(0, 32))
  const payoutOwner = Keypair.generate().publicKey
  const legs = [
    { domain: domainPda('acme-news.test')[0], payoutOwner, tariff: 20_000n },
    { domain: domainPda('devblog.test')[0], payoutOwner, tariff: 4_000n },
  ]
  const [verification, settle] = buildSettleBatch({
    authority,
    consumer: agent.publicKey,
    mint,
    treasuryAta,
    voucher: { ...voucher, signature },
    root,
    legs,
  })

  it('settle_batch survives a round-trip', () => {
    expect(decodeInstruction(settle).data).toEqual({
      seq: 12n,
      cumulative: 26_400n,
      chain: Array.from(chain),
      root: Array.from(root),
      tariffs: [20_000n, 4_000n],
    })
  })

  // settle.rs accepts exactly one header; any other layout is VoucherSignatureMismatch.
  it('the verification carries the header settle.rs pins, the agent key and the voucher', () => {
    const data = new Uint8Array(verification.data)
    expect(verification.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111')
    expect(Array.from(data.subarray(0, 16))).toEqual([
      1, 0, 48, 0, 0xff, 0xff, 16, 0, 0xff, 0xff, 112, 0, 88, 0, 0xff, 0xff,
    ])
    expect(data.subarray(16, 48)).toEqual(agent.publicKey.toBytes())
    expect(data.subarray(112)).toEqual(message)
    expect(ed25519.verify(data.subarray(48, 112), data.subarray(112), data.subarray(16, 48))).toBe(
      true,
    )
  })

  it('carries the fixed accounts in IDL order, then three per leg', () => {
    const keys = settle.keys.map(({ pubkey, isSigner, isWritable }) => [
      pubkey.toBase58(),
      isSigner,
      isWritable,
    ])
    expect(keys.slice(0, 7)).toEqual([
      [authority.toBase58(), true, true],
      [configPda()[0].toBase58(), false, false],
      [escrow.toBase58(), false, true],
      [vaultPda(escrow)[0].toBase58(), false, true],
      [treasuryAta.toBase58(), false, true],
      [mint.toBase58(), false, false],
      [settlementLogPda(escrow)[0].toBase58(), false, true],
    ])
    expect(keys.slice(11)).toEqual(
      legs.flatMap(({ domain }) => [
        [domain.toBase58(), false, false],
        [payoutOwner.toBase58(), false, false],
        [associatedTokenAddress(payoutOwner, mint).toBase58(), false, true],
      ]),
    )
  })

  it('refuses a voucher signature that is not 64 bytes', () => {
    expect(() =>
      buildSettleBatch({
        authority,
        consumer: agent.publicKey,
        mint,
        treasuryAta,
        voucher: { ...voucher, signature: signature.subarray(0, 63) },
        root,
        legs,
      }),
    ).toThrow()
  })
})

describe('escrow', () => {
  const agent = Keypair.generate().publicKey
  const [escrow] = escrowPda(agent)
  const meta = (instruction: {
    keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]
  }) =>
    instruction.keys.map(({ pubkey, isSigner, isWritable }) => [
      pubkey.toBase58(),
      isSigner,
      isWritable,
    ])

  it('open_escrow is paid for by the agent and creates escrow and vault', () => {
    const instruction = buildOpenEscrow({ consumer: agent, mint })
    expect(decodeInstruction(instruction).name).toBe('open_escrow')
    expect(meta(instruction).slice(0, 5)).toEqual([
      [agent.toBase58(), true, true],
      [configPda()[0].toBase58(), false, false],
      [escrow.toBase58(), false, true],
      [mint.toBase58(), false, false],
      [vaultPda(escrow)[0].toBase58(), false, true],
    ])
  })

  it('deposit survives a round-trip and moves tokens from the given account', () => {
    const source = Keypair.generate().publicKey
    const instruction = buildDeposit({ consumer: agent, source, amount: 5_000_000n })
    expect(decodeInstruction(instruction).data).toEqual({ amount: 5_000_000n })
    expect(meta(instruction).slice(0, 4)).toEqual([
      [agent.toBase58(), true, false],
      [escrow.toBase58(), false, true],
      [vaultPda(escrow)[0].toBase58(), false, true],
      [source.toBase58(), false, true],
    ])
  })
})
