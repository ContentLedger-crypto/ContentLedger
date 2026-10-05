import {
  buildDeposit,
  buildOpenEscrow,
  configPda,
  decodeConfig,
  decodeEscrow,
  escrowPda,
  PROGRAM_ID,
  type SendConnection,
  sendAndAwait,
  type WatchOptions,
} from '@contentledger/chain'
import { chainGenesis } from '@contentledger/shared'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  type Connection,
  type Keypair,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js'
import type { Position } from './protocol.js'

export async function settledPosition(
  connection: Pick<Connection, 'getAccountInfo'>,
  consumer: PublicKey,
): Promise<Position> {
  const [escrow] = escrowPda(consumer)
  const info = await connection.getAccountInfo(escrow, 'confirmed')
  // Lamports sent to the address leave a system-owned account, which is still no escrow;
  // nothing is settled, and an escrow opened later starts from the same genesis.
  if (!info?.owner.equals(PROGRAM_ID)) {
    return { seq: 0n, cumulative: 0n, chain: chainGenesis(escrow.toBytes()) }
  }
  const { lastSeq, settledTotal, lastChain } = decodeEscrow(info.data)
  return {
    seq: lastSeq,
    cumulative: settledTotal,
    // open_escrow zeroes last_chain rather than writing the genesis value.
    chain:
      lastSeq === 0n
        ? chainGenesis(escrow.toBytes())
        : Uint8Array.from(Buffer.from(lastChain, 'hex')),
  }
}

export function depositInstructions(args: {
  consumer: PublicKey
  mint: PublicKey
  amount: bigint
  escrowExists: boolean
}): TransactionInstruction[] {
  const { consumer, mint, amount, escrowExists } = args
  if (amount <= 0n) throw new RangeError('a deposit must move something')
  const source = getAssociatedTokenAddressSync(mint, consumer)
  const deposit = buildDeposit({ consumer, source, amount })
  return escrowExists ? [deposit] : [buildOpenEscrow({ consumer, mint }), deposit]
}

export async function deposit(
  connection: SendConnection & Pick<Connection, 'getMultipleAccountsInfo'>,
  agent: Keypair,
  amount: bigint,
  watch: WatchOptions = { pollMs: 400 },
): Promise<string> {
  const [configInfo, escrowInfo] = await connection.getMultipleAccountsInfo(
    [configPda()[0], escrowPda(agent.publicKey)[0]],
    'confirmed',
  )
  if (!configInfo) throw new Error('Config account does not exist')
  const instructions = depositInstructions({
    consumer: agent.publicKey,
    mint: new PublicKey(decodeConfig(configInfo.data).mint),
    amount,
    escrowExists: escrowInfo?.owner.equals(PROGRAM_ID) ?? false,
  })
  return sendAndAwait(connection, instructions, [agent], { commitment: 'confirmed', ...watch })
}
