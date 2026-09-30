import type { Escrow } from '@contentledger/chain'
import { describe, expect, it } from 'vitest'
import { checkFunds } from './escrow.js'
import type { EscrowSnapshot } from './registry.js'

const snapshot = (overrides: Partial<Escrow>, vaultBalance: bigint): EscrowSnapshot => ({
  address: 'escrow',
  account: {
    consumer: 'consumer',
    vault: 'vault',
    settledTotal: 0n,
    lastSeq: 0n,
    lastChain: '00'.repeat(32),
    withdrawAfter: 0n,
    bump: 255,
    vaultBump: 254,
    ...overrides,
  },
  vaultBalance,
})

describe('checkFunds', () => {
  it('accepts a voucher whose unsettled total fits the vault exactly', () => {
    expect(checkFunds(snapshot({ settledTotal: 1000n }, 500n), 1500n)).toEqual({ ok: true })
  })

  it('counts everything signed above the settled total, not just this request', () => {
    expect(checkFunds(snapshot({ settledTotal: 1000n }, 500n), 1501n)).toEqual({
      ok: false,
      reason: 'insufficient-funds',
    })
  })

  it('accepts a zero-rate voucher on an empty vault', () => {
    expect(checkFunds(snapshot({ settledTotal: 2200n }, 0n), 2200n)).toEqual({ ok: true })
  })

  it('refuses an agent that never opened an escrow', () => {
    expect(checkFunds(null, 0n)).toEqual({ ok: false, reason: 'escrow-missing' })
  })

  it('refuses once a withdrawal is requested, however much is left', () => {
    expect(checkFunds(snapshot({ withdrawAfter: 1_790_000_000n }, 1_000_000n), 1n)).toEqual({
      ok: false,
      reason: 'withdrawal-requested',
    })
  })
})
