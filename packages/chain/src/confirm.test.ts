import { utils } from '@coral-xyz/anchor'
import { Keypair, type SignatureStatus, SystemProgram, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  awaitSignature,
  type SendConnection,
  type StatusConnection,
  sendAndAwait,
} from './confirm.js'

type Step = SignatureStatus | null | Error

const status = (
  confirmationStatus: SignatureStatus['confirmationStatus'],
  err: SignatureStatus['err'] = null,
): SignatureStatus => ({ slot: 1, confirmations: null, err, confirmationStatus })

/** Answers each status call with the next step; the last step repeats. */
const cluster = (steps: Step[], opts: { height?: number; history?: Step } = {}) => {
  const calls = { statuses: 0, history: 0, heights: [] as string[] }
  const answer = (step: Step | undefined) => {
    if (step instanceof Error) throw step
    return { context: { slot: 1 }, value: [step ?? null] }
  }
  const connection: StatusConnection = {
    async getSignatureStatuses(_signatures, config) {
      if (config?.searchTransactionHistory) {
        calls.history += 1
        return answer(opts.history ?? null)
      }
      const step = steps[Math.min(calls.statuses, steps.length - 1)]
      calls.statuses += 1
      return answer(step)
    },
    async getBlockHeight(commitment) {
      calls.heights.push(String(commitment))
      return opts.height ?? 100
    },
  }
  return { connection, calls }
}

const watch = (commitment: 'confirmed' | 'finalized') => ({
  signature: 'sig',
  lastValidBlockHeight: 150,
  commitment,
})
const fast = { pollMs: 0 }
const internal = () => new Error('failed to get signature status: Internal error')

describe('awaitSignature', () => {
  it('waits until the transaction reaches the commitment asked for', async () => {
    const { connection, calls } = cluster([
      null,
      status('processed'),
      status('confirmed'),
      status('finalized'),
    ])
    expect(await awaitSignature(connection, watch('finalized'), fast)).toEqual({ status: 'landed' })
    expect(calls.statuses).toBe(4)
  })

  it('takes a finalized transaction as confirmed', async () => {
    const { connection } = cluster([status('finalized')])
    expect(await awaitSignature(connection, watch('confirmed'), fast)).toEqual({ status: 'landed' })
  })

  it('reports the error of a transaction that executed and failed', async () => {
    const err = { InstructionError: [1, { Custom: 6011 }] }
    const { connection } = cluster([status('processed', err), status('finalized', err)])
    expect(await awaitSignature(connection, watch('finalized'), fast)).toEqual({
      status: 'failed',
      err,
    })
  })

  it('outlasts a run of RPC failures shorter than its limit', async () => {
    const { connection, calls } = cluster([internal(), internal(), status('finalized')])
    expect(
      await awaitSignature(connection, watch('finalized'), { ...fast, maxFailures: 3 }),
    ).toEqual({ status: 'landed' })
    expect(calls.statuses).toBe(3)
  })

  it('counts only failures in a row against its limit', async () => {
    const { connection } = cluster([
      internal(),
      null,
      internal(),
      null,
      internal(),
      status('confirmed'),
    ])
    expect(
      await awaitSignature(connection, watch('confirmed'), { ...fast, maxFailures: 2 }),
    ).toEqual({ status: 'landed' })
  })

  it('gives up with the RPC error once failures in a row reach the limit', async () => {
    const { connection, calls } = cluster([internal()])
    await expect(
      awaitSignature(connection, watch('finalized'), { ...fast, maxFailures: 3 }),
    ).rejects.toThrow(/Internal error/)
    expect(calls.statuses).toBe(3)
  })

  it('declares a transaction expired only once the block height passed its blockhash', async () => {
    const { connection, calls } = cluster([null], { height: 151 })
    expect(await awaitSignature(connection, watch('confirmed'), fast)).toEqual({
      status: 'expired',
    })
    expect(calls.heights).toEqual(['confirmed'])
  })

  // The recent-status cache holds only the last ~150 blocks: a payment sent before a crash
  // and landed long ago would otherwise be forgotten as expired, and its money lost.
  it('looks the transaction up in history before declaring it expired', async () => {
    const { connection, calls } = cluster([null], { height: 400, history: status('finalized') })
    expect(await awaitSignature(connection, watch('confirmed'), fast)).toEqual({ status: 'landed' })
    expect(calls.history).toBe(1)
  })

  it('does not take a history lookup that failed for an expiry', async () => {
    const { connection } = cluster([null, status('finalized')], {
      height: 400,
      history: internal(),
    })
    expect(await awaitSignature(connection, watch('finalized'), fast)).toEqual({ status: 'landed' })
  })
})

describe('sendAndAwait', () => {
  const payer = Keypair.generate()
  const transfer = () => [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ]

  const sender = (steps: Step[], height = 100) => {
    const { connection } = cluster(steps, { height })
    const sent: Buffer[] = []
    const full: SendConnection = {
      ...connection,
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150,
      }),
      sendRawTransaction: async (raw) => {
        sent.push(Buffer.from(raw as Uint8Array))
        return utils.bytes.bs58.encode(
          Transaction.from(raw as Buffer).signature ?? new Uint8Array(),
        )
      },
    }
    return { connection: full, sent }
  }

  const opts = { commitment: 'confirmed', pollMs: 0 } as const

  it('sends the signed transaction once and resolves with its signature when it lands', async () => {
    const { connection, sent } = sender([null, internal(), status('confirmed')])
    const signature = await sendAndAwait(connection, transfer(), [payer], opts)
    expect(sent).toHaveLength(1)
    const tx = Transaction.from(sent[0] as Buffer)
    expect(tx.verifySignatures()).toBe(true)
    expect(signature).toBe(utils.bytes.bs58.encode(tx.signature ?? new Uint8Array()))
  })

  it('throws when the transaction executed and failed', async () => {
    const { connection } = sender([status('confirmed', { InstructionError: [0, 'x'] })])
    await expect(sendAndAwait(connection, transfer(), [payer], opts)).rejects.toThrow(/failed/)
  })

  it('throws when its blockhash expired before it landed', async () => {
    const { connection } = sender([null], 151)
    await expect(sendAndAwait(connection, transfer(), [payer], opts)).rejects.toThrow(/expired/)
  })
})
