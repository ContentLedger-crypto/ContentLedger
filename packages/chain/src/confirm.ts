import type { Connection, SignatureStatus, TransactionError } from '@solana/web3.js'

export type StatusConnection = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>

export interface Watched {
  signature: string
  lastValidBlockHeight: number
  commitment: 'confirmed' | 'finalized'
}

export type Settled =
  | { status: 'landed' }
  | { status: 'failed'; err: TransactionError }
  | { status: 'expired' }

export interface WatchOptions {
  pollMs: number
  /** Failed RPC rounds in a row tolerated before the last error is thrown to the caller. */
  maxFailures?: number
}

const RANK = { processed: 0, confirmed: 1, finalized: 2 } as const

/**
 * Polls instead of web3.js `confirmTransaction`, which races a subscription against status
 * polls it never awaits: one RPC error there rejects with nobody listening and kills the
 * process. Here every call is awaited, and a failed round is only a round missed.
 */
export async function awaitSignature(
  connection: StatusConnection,
  watched: Watched,
  { pollMs, maxFailures = 10 }: WatchOptions,
): Promise<Settled> {
  let failures = 0
  for (;;) {
    try {
      const settled = await round(connection, watched)
      if (settled !== null) return settled
      failures = 0
    } catch (error) {
      failures += 1
      if (failures >= maxFailures) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function round(connection: StatusConnection, watched: Watched): Promise<Settled | null> {
  const { signature, lastValidBlockHeight, commitment } = watched
  const [recent] = (await connection.getSignatureStatuses([signature])).value
  if (recent) return decided(recent, commitment)
  if ((await connection.getBlockHeight(commitment)) <= lastValidBlockHeight) return null
  // The recent-status cache spans only the last ~150 blocks; a transaction that landed
  // before that is in history alone, and calling it expired would forget money that moved.
  const [past] = (
    await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
  ).value
  return past ? decided(past, commitment) : { status: 'expired' }
}

function decided(status: SignatureStatus, commitment: Watched['commitment']): Settled | null {
  const reached = status.confirmationStatus ?? 'processed'
  if (RANK[reached] < RANK[commitment]) return null
  return status.err === null ? { status: 'landed' } : { status: 'failed', err: status.err }
}
