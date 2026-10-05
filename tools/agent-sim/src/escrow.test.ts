import { buildDeposit, buildOpenEscrow, coder, escrowPda, PROGRAM_ID } from '@contentledger/chain'
import { chainGenesis } from '@contentledger/shared'
import { BN } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  type AccountInfo,
  type Connection,
  Keypair,
  PublicKey,
  type SignatureStatus,
  Transaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { deposit, depositInstructions, settledPosition } from './escrow.js'

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

describe('deposit', () => {
  const payer = Keypair.generate()
  const configAccount = async (): Promise<AccountInfo<Buffer>> => ({
    data: await coder.accounts.encode('Config', {
      authority: Keypair.generate().publicKey,
      treasury_ata: Keypair.generate().publicKey,
      mint,
      protocol_fee_bps: 1000,
      node_share_bps: 0,
      voucher_grace_s: new BN(900),
      paused: false,
      bump: 255,
      reserved: Array(64).fill(0),
    }),
    owner: PROGRAM_ID,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  })

  it('opens the escrow and lands the deposit once, through an RPC error mid-confirmation', async () => {
    const sent: Buffer[] = []
    const statuses: (SignatureStatus | null | Error)[] = [
      null,
      new Error('failed to get signature status: Internal error'),
      { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' },
    ]
    let polled = 0
    const connection = {
      getMultipleAccountsInfo: async () => [await configAccount(), null],
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150,
      }),
      sendRawTransaction: async (raw: Buffer) => {
        sent.push(raw)
        return 'sig'
      },
      getSignatureStatuses: async () => {
        const step = statuses[Math.min(polled, statuses.length - 1)]
        polled += 1
        if (step instanceof Error) throw step
        return { context: { slot: 1 }, value: [step ?? null] }
      },
      getBlockHeight: async () => 100,
    } as unknown as Connection

    expect(await deposit(connection, payer, 5n, { pollMs: 0 })).toBe('sig')
    expect(sent).toHaveLength(1)
    const tx = Transaction.from(sent[0] as Buffer)
    expect(tx.verifySignatures()).toBe(true)
    const shape = (ixs: { programId: PublicKey; data: Buffer }[]) =>
      ixs.map((ix) => [ix.programId.toBase58(), ix.data.toString('hex')])
    expect(shape(tx.instructions)).toEqual(
      shape(
        depositInstructions({ consumer: payer.publicKey, mint, amount: 5n, escrowExists: false }),
      ),
    )
  })
})
