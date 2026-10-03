import { buildDeposit, buildOpenEscrow, coder, escrowPda, PROGRAM_ID } from '@contentledger/chain'
import { chainGenesis } from '@contentledger/shared'
import { BN } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type AccountInfo, type Connection, Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { depositInstructions, settledPosition } from './escrow.js'

const agent = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const [escrow] = escrowPda(agent)

const escrowAccount = async (
  lastSeq: number,
  owner = PROGRAM_ID,
): Promise<AccountInfo<Buffer>> => ({
  data: await coder.accounts.encode('Escrow', {
    consumer: agent,
    vault: Keypair.generate().publicKey,
    settled_total: new BN(lastSeq * 2200),
    last_seq: new BN(lastSeq),
    last_chain: Array(32).fill(lastSeq === 0 ? 0 : 9),
    withdraw_after: new BN(0),
    bump: 254,
    vault_bump: 253,
    reserved: Array(32).fill(0),
  }),
  owner,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
})

const reading = (info: AccountInfo<Buffer> | null) =>
  ({
    async getAccountInfo(key: PublicKey, commitment: string) {
      expect(key.toBase58()).toBe(escrow.toBase58())
      expect(commitment).toBe('confirmed')
      return info
    },
  }) as unknown as Connection

describe('settledPosition', () => {
  // open_escrow leaves last_chain zeroed; the first voucher chains from the genesis.
  it('starts a fresh escrow at the genesis of its chain', async () => {
    expect(await settledPosition(reading(await escrowAccount(0)), agent)).toEqual({
      seq: 0n,
      cumulative: 0n,
      chain: chainGenesis(escrow.toBytes()),
    })
  })

  it('continues a settled escrow from its last chain', async () => {
    expect(await settledPosition(reading(await escrowAccount(4)), agent)).toEqual({
      seq: 4n,
      cumulative: 8800n,
      chain: new Uint8Array(32).fill(9),
    })
  })

  // Nothing is settled yet, and the escrow it may open later starts from this genesis:
  // until then the agent can still pay by x402.
  it('starts an agent without an escrow at the genesis its escrow would open with', async () => {
    const genesis = { seq: 0n, cumulative: 0n, chain: chainGenesis(escrow.toBytes()) }
    expect(await settledPosition(reading(null), agent)).toEqual(genesis)
    expect(
      await settledPosition(reading(await escrowAccount(0, PublicKey.default)), agent),
    ).toEqual(genesis)
  })
})

describe('depositInstructions', () => {
  const source = getAssociatedTokenAddressSync(mint, agent)

  it('opens the escrow in the same transaction as its first deposit', () => {
    expect(depositInstructions({ consumer: agent, mint, amount: 5n, escrowExists: false })).toEqual(
      [
        buildOpenEscrow({ consumer: agent, mint }),
        buildDeposit({ consumer: agent, source, amount: 5n }),
      ],
    )
  })

  it('only deposits into an open escrow', () => {
    expect(depositInstructions({ consumer: agent, mint, amount: 5n, escrowExists: true })).toEqual([
      buildDeposit({ consumer: agent, source, amount: 5n }),
    ])
  })

  it('refuses a deposit of nothing', () => {
    expect(() =>
      depositInstructions({ consumer: agent, mint, amount: 0n, escrowExists: true }),
    ).toThrow()
  })
})
