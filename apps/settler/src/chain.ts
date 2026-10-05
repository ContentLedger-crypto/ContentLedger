import {
  awaitSignature,
  type Config,
  coder,
  configPda,
  type Domain,
  decodeConfig,
  decodeDomain,
  decodeEscrow,
  type Escrow,
  escrowPda,
  PROGRAM_ID,
  settlementLogPda,
  type WatchOptions,
} from '@contentledger/chain'
import type { BN } from '@coral-xyz/anchor'
import {
  type Connection,
  type Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  type VersionedMessage,
} from '@solana/web3.js'

/** Fixed by the network: an IPv6 MTU minus headers. */
const PACKET_BYTES = 1232

/** How far back the ring's own history is searched for an unrecorded settlement. */
const HISTORY_LIMIT = 20

export interface ChainState {
  config: Config
  escrow: Escrow | null
  domains: Map<string, Domain>
}

export interface FoundSettlement {
  txSig: string
  /** Hex of the root the transaction anchored. */
  root: string
  settledAt: Date
}

export interface SettlementChain {
  read(consumer: string, domains: readonly string[]): Promise<ChainState>
  /** Resolves only once the transaction is finalized: the batch is then published as immutable. */
  submit(instructions: readonly TransactionInstruction[]): Promise<string>
  findSettlement(consumer: string, seq: bigint): Promise<FoundSettlement | null>
}

type SettlementConnection = Pick<
  Connection,
  | 'getMultipleAccountsInfo'
  | 'getLatestBlockhash'
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getBlockHeight'
  | 'getSignaturesForAddress'
  | 'getTransaction'
>

export function rpcSettlementChain(
  connection: SettlementConnection,
  operator: Keypair,
  // Finalization takes ~13 s and nothing waits on it but the next batch.
  watch: WatchOptions = { pollMs: 2000 },
): SettlementChain {
  return {
    async read(consumer, domains) {
      const escrow = escrowPda(new PublicKey(consumer))[0]
      const keys = [configPda()[0], escrow, ...domains.map((domain) => new PublicKey(domain))]
      const [configInfo, escrowInfo, ...domainInfos] = await connection.getMultipleAccountsInfo(
        keys,
        'finalized',
      )
      if (!configInfo) throw new Error('Config account does not exist')

      const found = new Map<string, Domain>()
      domains.forEach((domain, i) => {
        const info = domainInfos[i]
        if (!info) throw new Error(`Domain ${domain} does not exist`)
        found.set(domain, decodeDomain(info.data))
      })
      return {
        config: decodeConfig(configInfo.data),
        // Anyone can send lamports to the escrow address; that leaves a system-owned
        // account, which is still no escrow.
        escrow: escrowInfo?.owner.equals(PROGRAM_ID) ? decodeEscrow(escrowInfo.data) : null,
        domains: found,
      }
    },

    async submit(instructions) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized')
      const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight })
      tx.add(...instructions).sign(operator)
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: 'finalized',
      })
      const settled = await awaitSignature(
        connection,
        { signature, lastValidBlockHeight, commitment: 'finalized' },
        watch,
      )
      if (settled.status === 'failed') {
        throw new Error(`settlement ${signature} failed: ${JSON.stringify(settled.err)}`)
      }
      if (settled.status === 'expired') {
        throw new Error(`settlement ${signature} expired before it landed`)
      }
      return signature
    },

    // Only settle_batch writes the ring, so its history holds nothing but the
    // operator's own legacy transactions — the escrow's would include agent deposits
    // in versions web3.js 1.x cannot read.
    async findSettlement(consumer, seq) {
      const log = settlementLogPda(escrowPda(new PublicKey(consumer))[0])[0]
      const signatures = await connection.getSignaturesForAddress(
        log,
        { limit: HISTORY_LIMIT },
        'finalized',
      )
      for (const { signature, err } of signatures) {
        if (err) continue
        const tx = await connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        })
        const settled = tx ? settlementIn(tx.transaction.message) : null
        if (tx && settled?.seq === seq) {
          if (!tx.blockTime) throw new Error(`settlement ${signature} has no block time`)
          return { txSig: signature, root: settled.root, settledAt: new Date(tx.blockTime * 1000) }
        }
      }
      return null
    },
  }
}

export function packetSize(
  instructions: readonly TransactionInstruction[],
  payer: PublicKey,
): number {
  const message = new Transaction({
    feePayer: payer,
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 0,
  })
    .add(...instructions)
    .compileMessage()
  const signatures = message.header.numRequiredSignatures
  // The signature count is a compact-u16: one byte below 128.
  return 1 + 64 * signatures + message.serialize().length
}

export const fitsInPacket = (
  instructions: readonly TransactionInstruction[],
  payer: PublicKey,
): boolean => packetSize(instructions, payer) <= PACKET_BYTES

export function settlementIn(
  message: Pick<VersionedMessage, 'staticAccountKeys' | 'compiledInstructions'>,
): { seq: bigint; root: string } | null {
  for (const instruction of message.compiledInstructions) {
    if (!message.staticAccountKeys[instruction.programIdIndex]?.equals(PROGRAM_ID)) continue
    const decoded = coder.instruction.decode(Buffer.from(instruction.data))
    if (decoded?.name !== 'settle_batch') continue
    const { seq, root } = decoded.data as { seq: BN; root: number[] }
    return { seq: BigInt(seq.toString()), root: Buffer.from(root).toString('hex') }
  }
  return null
}
