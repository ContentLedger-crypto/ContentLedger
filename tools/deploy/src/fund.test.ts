import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fundingInstructions } from './fund.js'

const operator = Keypair.generate().publicKey
const agent = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const agentAta = getAssociatedTokenAddressSync(mint, agent)

describe('fundingInstructions', () => {
  it('creates the agent’s token account, mints to it and sends lamports for fees', () => {
    expect(
      fundingInstructions({
        operator,
        recipient: agent,
        mint,
        usdc: 5_000_000n,
        lamports: 50_000_000n,
      }),
    ).toEqual([
      createAssociatedTokenAccountIdempotentInstruction(operator, agentAta, agent, mint),
      createMintToInstruction(mint, agentAta, operator, 5_000_000n),
      SystemProgram.transfer({ fromPubkey: operator, toPubkey: agent, lamports: 50_000_000n }),
    ])
  })

  it('leaves out what is not asked for', () => {
    expect(
      fundingInstructions({ operator, recipient: agent, mint, usdc: 0n, lamports: 1n }),
    ).toEqual([SystemProgram.transfer({ fromPubkey: operator, toPubkey: agent, lamports: 1n })])
    expect(
      fundingInstructions({ operator, recipient: agent, mint, usdc: 1n, lamports: 0n }),
    ).toHaveLength(2)
  })

  it('refuses to send nothing', () => {
    expect(() =>
      fundingInstructions({ operator, recipient: agent, mint, usdc: 0n, lamports: 0n }),
    ).toThrow()
  })
})
