import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { hostSeed } from './identifiers.js'
import {
  buildInitConfig,
  buildRegisterDomain,
  buildRegisterWork,
  buildSetDomainRates,
  buildSetDomainStatus,
  buildSetWorkRates,
  buildSetWorkStatus,
  decodeInstruction,
} from './instructions.js'
import { configPda, domainPda, workPda } from './pda.js'
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
