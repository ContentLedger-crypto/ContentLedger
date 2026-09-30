import type { EscrowSnapshot } from './registry.js'

export type FundsRejection = 'escrow-missing' | 'withdrawal-requested' | 'insufficient-funds'

export type FundsVerdict = { ok: true } | { ok: false; reason: FundsRejection }

/**
 * `cumulative` is the voucher being accepted. A settlement moves money out of the vault
 * and adds it to `settledTotal` in one transaction, so any confirmed snapshot still
 * holds exactly what was signed above `settledTotal`.
 */
export function checkFunds(escrow: EscrowSnapshot | null, cumulative: bigint): FundsVerdict {
  if (escrow === null) return { ok: false, reason: 'escrow-missing' }
  // The grace window exists to settle what the agent already signed before it can
  // withdraw; taking new vouchers inside it would pay content out of a leaving vault.
  if (escrow.account.withdrawAfter !== 0n) return { ok: false, reason: 'withdrawal-requested' }
  if (cumulative - escrow.account.settledTotal > escrow.vaultBalance) {
    return { ok: false, reason: 'insufficient-funds' }
  }
  return { ok: true }
}
