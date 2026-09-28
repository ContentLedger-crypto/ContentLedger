import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
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

const consumer = new PublicKey('7Xw3kQhVvVfN4dLpAqTzR9mBcJyU2sHnEgWxPd6ZaKtF')

describe('деривація PDA', () => {
  it('усі адреси належать нашій програмі й лежать поза кривою', () => {
    const escrow = escrowPda(consumer)
    for (const [address] of [
      configPda(),
      domainPda('example.com'),
      workPda('https://example.com/a'),
      escrow,
      vaultPda(escrow[0]),
      settlementLogPda(escrow[0]),
    ]) {
      expect(PublicKey.isOnCurve(address.toBytes())).toBe(false)
    }
  })

  it('сімейства сідів не перетинаються', () => {
    const escrow = escrowPda(consumer)[0]
    const keys = [
      configPda()[0],
      domainPda('example.com')[0],
      workPda('https://example.com/a')[0],
      escrow,
      vaultPda(escrow)[0],
      settlementLogPda(escrow)[0],
    ].map((key) => key.toBase58())

    expect(new Set(keys).size).toBe(keys.length)
  })

  /// Домену в сідах твору немає (рішення T017): той самий URL дає ту саму
  /// адресу, з якого боку до неї не йти.
  it('адреса твору залежить тільки від джерела', () => {
    expect(workPda('https://example.com/a')[0].toBase58()).toBe(
      workPda('https://example.com/a')[0].toBase58(),
    )
    expect(workPda('https://example.com/a')[0].toBase58()).not.toBe(
      workPda('https://example.com/b')[0].toBase58(),
    )
  })

  it('bump канонічний — це той самий, що поверне findProgramAddressSync', () => {
    const [address, bump] = configPda()
    const [expectedAddress, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('config')],
      PROGRAM_ID,
    )
    expect(address.toBase58()).toBe(expectedAddress.toBase58())
    expect(bump).toBe(expectedBump)
  })

  it('неканонічний хост не доходить до деривації', () => {
    expect(() => domainPda('Example.com')).toThrow()
  })
})

describe('associatedTokenAddress', () => {
  const mint = new PublicKey('F2snBajNcBXZ6GheR5LPhMvc9Ai2vG9uGweXrciNM1oF')

  // Vectors from @solana/spl-token getAssociatedTokenAddressSync; the first one is
  // the live devnet treasury that init_config accepted.
  it.each([
    [
      '2nfDE4vfx7aBkjucAJzo7tegmkbMzJ52ambqoguHkgsm',
      'HM8EYSNJMxvfrpi1FM31BPpCbgd3p2zbEd9K9re4WgwZ',
    ],
    [
      'FKoKPEnGHQsawTzHpWCvWj1WxAtwFCbZqZEWV4D3JoLM',
      'H4g3tncAE1YGyHAwCB16SGxghVPK4etZgUE3K3e7tH2b',
    ],
  ])('derives the legacy SPL Token ATA of %s', (owner, ata) => {
    expect(associatedTokenAddress(new PublicKey(owner), mint).toBase58()).toBe(ata)
  })
})
