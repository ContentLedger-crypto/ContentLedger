import { buildSettleBatch, escrowPda } from '@contentledger/chain'
import { chainGenesis } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  type Batch,
  composeBatch,
  isDue,
  type Leg,
  type PendingVoucher,
  type SettledPosition,
  type SettlePolicy,
} from './batch.js'
import { type ChainState, fitsInPacket, type SettlementChain } from './chain.js'
import { type Database, lastBatch, loadPending, recordBatch } from './store.js'

export type Log = (
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown>,
) => void

export interface SettlerDeps {
  db: Database
  chain: SettlementChain
  operator: PublicKey
  policy: SettlePolicy & { maxReceipts: number }
  now: () => Date
  log: Log
}

/** One pass over every agent with unbatched vouchers; one agent's failure stops only that agent. */
export async function settleAll(deps: SettlerDeps): Promise<void> {
  for (const [consumer, pending] of await loadPending(deps.db)) {
    try {
      await settleAgent(deps, consumer, pending)
    } catch (error) {
      deps.log('error', 'settlement stopped for this agent', {
        consumer,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function settleAgent(deps: SettlerDeps, consumer: string, pending: PendingVoucher[]) {
  let rest = pending
  while (rest.length > 0) {
    const state = await deps.chain.read(consumer, [...new Set(rest.map((p) => p.domain))])
    const { escrow } = state
    if (escrow === null) throw new Error('vouchers exist for an escrow that does not')

    const recorded = await lastBatch(deps.db, consumer)
    const recordedSeq = recorded?.seqTo ?? 0n
    if (escrow.lastSeq < recordedSeq) {
      throw new Error(`escrow settled to seq ${escrow.lastSeq}, batches record ${recordedSeq}`)
    }
    if (escrow.lastSeq > recordedSeq) {
      const start = recorded
        ? { lastSeq: recorded.seqTo, chain: Buffer.from(recorded.chain, 'hex') }
        : { lastSeq: 0n, chain: genesis(consumer) }
      await recover(deps, consumer, rest, start, escrow.lastSeq, state)
      rest = rest.filter((p) => p.seq > escrow.lastSeq)
      continue
    }

    if (!isDue(rest, escrow.withdrawAfter, deps.policy, deps.now())) return

    const start: SettledPosition = {
      lastSeq: escrow.lastSeq,
      // open_escrow zeroes last_chain rather than writing the genesis value.
      chain: escrow.lastSeq === 0n ? genesis(consumer) : Buffer.from(escrow.lastChain, 'hex'),
    }
    const batch = composeBatch(rest, start, {
      maxReceipts: deps.policy.maxReceipts,
      fits: (legs) =>
        fitsInPacket(settlementInstructions(deps, consumer, state, MEASURED, legs), deps.operator),
    })
    const txSig = await deps.chain.submit(
      settlementInstructions(deps, consumer, state, signed(batch), batch.legs),
    )
    const settledAt = deps.now()
    await recordBatch(deps.db, consumer, batch, {
      txSig,
      settledAt,
      publishedAt: settledAt,
      nodeShareBps: state.config.nodeShareBps,
    })
    deps.log('info', 'batch settled', {
      consumer,
      seqFrom: batch.seqFrom.toString(),
      seqTo: batch.seqTo.toString(),
      legs: batch.legs.length,
      txSig,
    })
    rest = rest.slice(batch.receiptIds.length)
  }
}

/**
 * The chain is the intent log: a settlement that landed while its batch was not written
 * is published from the vouchers it covered, held to the root the transaction anchored.
 */
async function recover(
  deps: SettlerDeps,
  consumer: string,
  pending: PendingVoucher[],
  start: SettledPosition,
  seqEnd: bigint,
  state: ChainState,
) {
  const found = await deps.chain.findSettlement(consumer, seqEnd)
  if (found === null) throw new Error(`escrow settled to seq ${seqEnd}, no transaction found`)

  const covered = pending.filter((p) => p.seq <= seqEnd)
  const batch = composeBatch(covered, start, { maxReceipts: covered.length, fits: () => true })
  const root = Buffer.from(batch.root).toString('hex')
  if (batch.seqTo !== seqEnd || root !== found.root) {
    throw new Error(`settlement ${found.txSig} anchored ${found.root}, vouchers give ${root}`)
  }
  await recordBatch(deps.db, consumer, batch, {
    txSig: found.txSig,
    settledAt: found.settledAt,
    publishedAt: deps.now(),
    nodeShareBps: state.config.nodeShareBps,
  })
  deps.log('info', 'recovered an unrecorded settlement', {
    consumer,
    seqTo: seqEnd.toString(),
    txSig: found.txSig,
  })
}

interface Signed {
  voucher: { seq: bigint; cumulative: bigint; chain: Uint8Array; signature: Uint8Array }
  root: Uint8Array
}

/** Every field has a fixed width, so a candidate's packet size does not depend on values. */
const MEASURED: Signed = {
  voucher: { seq: 0n, cumulative: 0n, chain: new Uint8Array(32), signature: new Uint8Array(64) },
  root: new Uint8Array(32),
}

const signed = ({ last, root }: Batch): Signed => ({
  voucher: {
    seq: last.seq,
    cumulative: last.cumulative,
    chain: Buffer.from(last.chain, 'hex'),
    signature: utils.bytes.bs58.decode(last.signature),
  },
  root,
})

function settlementInstructions(
  deps: SettlerDeps,
  consumer: string,
  state: ChainState,
  { voucher, root }: Signed,
  legs: readonly Leg[],
): TransactionInstruction[] {
  return buildSettleBatch({
    authority: deps.operator,
    consumer: new PublicKey(consumer),
    mint: new PublicKey(state.config.mint),
    treasuryAta: new PublicKey(state.config.treasuryAta),
    voucher,
    root,
    legs: legs.map((leg) => {
      const domain = state.domains.get(leg.domain)
      if (domain === undefined) throw new Error(`Domain ${leg.domain} was not read`)
      return {
        domain: new PublicKey(leg.domain),
        payoutOwner: new PublicKey(domain.payoutOwner),
        tariff: leg.tariff,
      }
    }),
  })
}

const genesis = (consumer: string): Uint8Array =>
  chainGenesis(escrowPda(new PublicKey(consumer))[0].toBytes())
