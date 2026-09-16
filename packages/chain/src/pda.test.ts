import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { configPda, domainPda, escrowPda, settlementLogPda, vaultPda, workPda } from './pda.js'
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
