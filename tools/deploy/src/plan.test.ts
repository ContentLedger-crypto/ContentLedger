import type { Config } from '@contentledger/chain'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type BootstrapSnapshot,
  bootstrapPlan,
  LEGACY_TOKEN_PROGRAM,
  USDC_DECIMALS,
} from './plan.js'

const operator = Keypair.generate().publicKey.toBase58()
const mint = Keypair.generate().publicKey.toBase58()
const treasury = Keypair.generate().publicKey.toBase58()

const config: Config = {
  authority: operator,
  treasuryAta: treasury,
  mint,
  protocolFeeBps: 1000,
  nodeShareBps: 0,
  voucherGraceS: 900n,
  paused: false,
  bump: 255,
}

const fresh: BootstrapSnapshot = {
  operator,
  programDeployed: true,
  requestedMint: null,
  mint: null,
  treasuryAta: null,
  config: null,
}

const withMint: BootstrapSnapshot = {
  ...fresh,
  requestedMint: mint,
  mint: { address: mint, decimals: USDC_DECIMALS, tokenProgram: LEGACY_TOKEN_PROGRAM },
  treasuryAta: { address: treasury, exists: false },
}

describe('план бутстрапу', () => {
  it('на порожньому devnet — мінт, скарбниця, init_config', () => {
    const plan = bootstrapPlan(fresh)

    expect(plan.problems).toEqual([])
    expect(plan.mint).toBeNull()
    expect(plan.steps).toEqual(['create_mint', 'create_treasury_ata', 'init_config'])
  })

  it('із заданим мінтом мінт не створюється', () => {
    const plan = bootstrapPlan(withMint)

    expect(plan.problems).toEqual([])
    expect(plan.mint).toBe(mint)
    expect(plan.steps).toEqual(['create_treasury_ata', 'init_config'])
  })

  it('повторний запуск на готовому стані не має кроків', () => {
    const plan = bootstrapPlan({
      ...withMint,
      treasuryAta: { address: treasury, exists: true },
      config,
    })

    expect(plan.problems).toEqual([])
    expect(plan.steps).toEqual([])
  })

  /// `Config` пинить мінт назавжди, тож без `USDC_MINT` в оточенні мінт береться
  /// з нього, а не створюється вдруге.
  it('без USDC_MINT в оточенні, але з Config — мінт береться з Config', () => {
    const plan = bootstrapPlan({
      ...fresh,
      mint: { address: mint, decimals: USDC_DECIMALS, tokenProgram: LEGACY_TOKEN_PROGRAM },
      treasuryAta: { address: treasury, exists: true },
      config,
    })

    expect(plan.problems).toEqual([])
    expect(plan.mint).toBe(mint)
    expect(plan.steps).toEqual([])
  })
})

describe('план зупиняється, а не лікує', () => {
  it('без програми в мережі', () => {
    const plan = bootstrapPlan({ ...fresh, programDeployed: false })

    expect(plan.steps).toEqual([])
    expect(plan.problems).toHaveLength(1)
    expect(plan.problems[0]).toMatch(/програми/)
  })

  it('коли заданий USDC_MINT не існує в мережі', () => {
    const plan = bootstrapPlan({ ...fresh, requestedMint: mint })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/не знайдено/)
  })

  it('коли мінт не має шести знаків', () => {
    const plan = bootstrapPlan({
      ...withMint,
      mint: { address: mint, decimals: 9, tokenProgram: LEGACY_TOKEN_PROGRAM },
    })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/знак/)
  })

  it('коли мінт під Token-2022', () => {
    const plan = bootstrapPlan({
      ...withMint,
      mint: {
        address: mint,
        decimals: USDC_DECIMALS,
        tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      },
    })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/Token-2022/)
  })

  it('коли Config пинить інший мінт, ніж USDC_MINT', () => {
    const other = Keypair.generate().publicKey.toBase58()
    const plan = bootstrapPlan({
      ...withMint,
      requestedMint: other,
      mint: { address: other, decimals: USDC_DECIMALS, tokenProgram: LEGACY_TOKEN_PROGRAM },
      config,
    })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/мінт/)
  })

  it('коли authority в Config — не операторський ключ', () => {
    const plan = bootstrapPlan({
      ...withMint,
      config: { ...config, authority: Keypair.generate().publicKey.toBase58() },
    })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/authority/)
  })

  it('коли скарбниця в Config — не ATA оператора', () => {
    const plan = bootstrapPlan({
      ...withMint,
      config: { ...config, treasuryAta: Keypair.generate().publicKey.toBase58() },
    })

    expect(plan.steps).toEqual([])
    expect(plan.problems[0]).toMatch(/скарбниц/)
  })

  it('перелічує всі розбіжності разом, а не першу', () => {
    const plan = bootstrapPlan({
      ...withMint,
      config: {
        ...config,
        authority: Keypair.generate().publicKey.toBase58(),
        treasuryAta: Keypair.generate().publicKey.toBase58(),
      },
    })

    expect(plan.problems).toHaveLength(2)
  })
})
