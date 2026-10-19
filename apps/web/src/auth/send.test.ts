import bs58 from 'bs58'
import { describe, expect, it, vi } from 'vitest'
import { SendError, type SendFailure } from '@/lib/register'
import { type SendingAdapter, SIGN_AND_SEND, senderFor } from './send'

const WALLET = 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T'
const CHAIN = 'solana:devnet'
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, index) => index)
const TRANSACTION = Uint8Array.from([1, 2, 3])

const account = (
  overrides: Partial<{ address: string; chains: string[]; features: string[] }> = {},
) => ({
  address: WALLET,
  chains: ['solana:mainnet', CHAIN],
  features: [SIGN_AND_SEND, 'solana:signTransaction'],
  ...overrides,
})

function standardAdapter(accounts = [account()], connected = true) {
  const signAndSendTransaction = vi.fn(async () => [{ signature: SIGNATURE }])
  const adapter = {
    connected,
    connect: vi.fn(async () => {
      adapter.connected = true
    }),
    wallet: { accounts, features: { [SIGN_AND_SEND]: { signAndSendTransaction } } },
  } satisfies SendingAdapter
  return { adapter, signAndSendTransaction }
}

describe('senderFor', () => {
  it('has the wallet sign and send to the session’s cluster, and answers with the signature', async () => {
    const { adapter, signAndSendTransaction } = standardAdapter()

    const signature = await senderFor(() => adapter, WALLET, CHAIN)(TRANSACTION)

    expect(signature).toBe(bs58.encode(SIGNATURE))
    expect(signAndSendTransaction).toHaveBeenCalledWith({
      account: account(),
      chain: CHAIN,
      transaction: TRANSACTION,
      options: { preflightCommitment: 'confirmed' },
    })
    expect(adapter.connect).not.toHaveBeenCalled()
  })

  it('connects the wallet again when a reloaded tab kept the session but not the connection', async () => {
    const { adapter, signAndSendTransaction } = standardAdapter([account()], false)
    await senderFor(() => adapter, WALLET, CHAIN)(TRANSACTION)
    expect(adapter.connect).toHaveBeenCalledOnce()
    expect(signAndSendTransaction).toHaveBeenCalledOnce()
  })

  it.each<[string, () => SendingAdapter | null, SendFailure]>([
    ['no wallet is selected', () => null, 'other-account'],
    [
      'the adapter is not a Standard wallet',
      () => ({ connected: true, connect: vi.fn() }),
      'cannot-send',
    ],
    [
      'the wallet has no sign-and-send',
      () => ({ ...standardAdapter().adapter, wallet: { accounts: [account()], features: {} } }),
      'cannot-send',
    ],
    [
      'the account is another one',
      () =>
        standardAdapter([account({ address: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp' })])
          .adapter,
      'other-account',
    ],
    [
      'the account cannot sign and send',
      () => standardAdapter([account({ features: ['solana:signTransaction'] })]).adapter,
      'cannot-send',
    ],
    [
      'the account does not offer the cluster',
      () => standardAdapter([account({ chains: ['solana:mainnet'] })]).adapter,
      'other-chain',
    ],
  ])('refuses before signing when %s', async (_, adapter, reason) => {
    await expect(senderFor(adapter, WALLET, CHAIN)(TRANSACTION)).rejects.toEqual(
      new SendError(reason),
    )
  })
})
