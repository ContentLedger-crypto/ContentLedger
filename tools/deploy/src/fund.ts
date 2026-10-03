import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { type PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'

export interface Funding {
  operator: PublicKey
  recipient: PublicKey
  mint: PublicKey
  usdc: bigint
  lamports: bigint
}

/**
 * The devnet faucet for the test mint, whose authority is the operator. It lives with
 * the operator's tooling so an agent never holds the operator key: on mainnet the agent
 * would buy USDC, and here it receives it the same way, from someone else.
 */
export function fundingInstructions(funding: Funding): TransactionInstruction[] {
  const { operator, recipient, mint, usdc, lamports } = funding
  if (usdc === 0n && lamports === 0n) throw new RangeError('nothing to send')
  const ata = getAssociatedTokenAddressSync(mint, recipient)
  return [
    ...(usdc > 0n
      ? [
          createAssociatedTokenAccountIdempotentInstruction(operator, ata, recipient, mint),
          createMintToInstruction(mint, ata, operator, usdc),
        ]
      : []),
    ...(lamports > 0n
      ? [SystemProgram.transfer({ fromPubkey: operator, toPubkey: recipient, lamports })]
      : []),
  ]
}
