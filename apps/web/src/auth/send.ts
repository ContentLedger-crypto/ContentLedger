import bs58 from 'bs58'
import { SendError, type TransactionSender } from '@/lib/register'

export const SIGN_AND_SEND = 'solana:signAndSendTransaction'

interface StandardAccount {
  readonly address: string
  readonly chains: readonly string[]
  readonly features: readonly string[]
}

interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: {
      account: StandardAccount
      chain: string
      transaction: Uint8Array
      options?: { preflightCommitment?: 'processed' | 'confirmed' | 'finalized' }
    }[]
  ): Promise<readonly { signature: Uint8Array }[]>
}

/** What sending needs of a wallet adapter; only a Standard wallet's carries `wallet`. */
export interface SendingAdapter {
  readonly connected: boolean
  connect(): Promise<void>
  readonly wallet?: {
    readonly accounts: readonly StandardAccount[]
    readonly features: Readonly<Record<string, unknown>>
  }
}

/**
 * The wallet signs and sends in one step, to the cluster the session signed in on: the
 * dashboard holds no RPC endpoint of its own to send through (PLAN, «Рішення T046a»).
 * The adapter is read at each send, since a reloaded tab restores the session but not
 * the wallet's connection.
 */
export function senderFor(
  adapter: () => SendingAdapter | null,
  address: string,
  chain: string,
): TransactionSender {
  return async (transaction) => {
    const current = adapter()
    if (current === null) throw new SendError('other-account')
    if (current.wallet === undefined) throw new SendError('cannot-send')
    const feature = current.wallet.features[SIGN_AND_SEND] as SignAndSendFeature | undefined
    if (feature === undefined) throw new SendError('cannot-send')

    if (!current.connected) await current.connect()
    const account = current.wallet.accounts.find((candidate) => candidate.address === address)
    if (account === undefined) throw new SendError('other-account')
    if (!account.features.includes(SIGN_AND_SEND)) throw new SendError('cannot-send')
    if (!account.chains.includes(chain)) throw new SendError('other-chain')

    const [output] = await feature.signAndSendTransaction({
      account,
      chain,
      transaction,
      options: { preflightCommitment: 'confirmed' },
    })
    if (output === undefined) throw new Error('the wallet answered without a signature')
    return bs58.encode(output.signature)
  }
}
