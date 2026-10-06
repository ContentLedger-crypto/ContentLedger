import type { AuthChallenge, SessionGrant } from '@contentledger/shared'
import bs58 from 'bs58'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  type AuthApi,
  clearSession,
  describeFailure,
  loadSession,
  type Session,
  type SessionStore,
  SignInError,
  type SigningWallet,
  saveSession,
  sessionEnd,
  signInWith,
} from './session'

const WALLET = 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T'
const OTHER = 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp'
const NOW = new Date('2026-10-07T12:00:00.000Z')

const session: Session = {
  wallet: WALLET,
  token: 'q3Jx0Vb2s9H_k-4mZp7LwT1nYc8RfAeD6uGiOoXjK5E',
  expiresAt: new Date('2026-10-08T00:00:00.000Z'),
}

function memoryStore(): SessionStore & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

describe('stored session', () => {
  it('comes back as it was saved while it lasts', () => {
    const store = memoryStore()
    saveSession(store, session)
    expect(loadSession(store, NOW)).toEqual(session)
  })

  it('is gone at the moment it expires, and is removed', () => {
    const store = memoryStore()
    saveSession(store, session)
    expect(loadSession(store, session.expiresAt)).toBeNull()
    expect(store.items.size).toBe(0)
  })

  it.each([
    ['not JSON', '{'],
    ['a token of the wrong shape', JSON.stringify({ ...session, token: 'short' })],
    ['no wallet', JSON.stringify({ token: session.token, expiresAt: session.expiresAt })],
  ])('is dropped when it is %s', (_, raw) => {
    const store = memoryStore()
    store.items.set('contentledger.session', raw)
    expect(loadSession(store, NOW)).toBeNull()
    expect(store.items.size).toBe(0)
  })

  it('is simply absent when the browser refuses storage', () => {
    const refusing: SessionStore = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    expect(() => saveSession(refusing, session)).not.toThrow()
    expect(loadSession(refusing, NOW)).toBeNull()
    expect(() => clearSession(refusing)).not.toThrow()
  })
})

describe('sessionEnd', () => {
  it('lets a live session stand, whether or not a wallet is connected', () => {
    expect(sessionEnd(session, NOW, null)).toBeNull()
    expect(sessionEnd(session, NOW, WALLET)).toBeNull()
  })

  it('ends the session at its expiry without anything from the user', () => {
    expect(sessionEnd(session, session.expiresAt, null)).toBe('expired')
  })

  it('ends the session when the wallet switches to another account', () => {
    expect(sessionEnd(session, NOW, OTHER)).toBe('other-account')
  })
})

const challenge: AuthChallenge = {
  input: {
    domain: 'localhost:5173',
    address: WALLET,
    statement: 'Sign in to the ContentLedger publisher dashboard.',
    uri: 'http://localhost:5173',
    version: '1',
    chainId: 'solana:devnet',
    nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    issuedAt: '2026-10-07T12:00:00.000Z',
    expirationTime: '2026-10-07T12:05:00.000Z',
  },
  message: 'localhost:5173 wants you to sign in with your Solana account:\n…',
}
const grant: SessionGrant = { token: session.token, expiresAt: '2026-10-08T00:00:00.000Z' }
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, index) => index * 3)
const messageBytes = new TextEncoder().encode(challenge.message)

function fakeApi() {
  return {
    challenge: vi.fn<AuthApi['challenge']>(async () => challenge),
    verify: vi.fn<AuthApi['verify']>(async () => grant),
  }
}

const key = (address: string) => ({ toBase58: () => address })

describe('signInWith', () => {
  it('signs in through the wallet’s own sign-in and trades the signature for a session', async () => {
    const api = fakeApi()
    const signIn = vi.fn<NonNullable<SigningWallet['signIn']>>(async () => ({
      account: { address: WALLET },
      signedMessage: messageBytes,
      signature: SIGNATURE,
    }))
    const wallet: SigningWallet = { publicKey: key(WALLET), connect: vi.fn(), signIn }

    expect(await signInWith(wallet, api)).toEqual(session)
    expect(api.challenge).toHaveBeenCalledWith(WALLET)
    expect(signIn).toHaveBeenCalledWith(challenge.input)
    expect(api.verify).toHaveBeenCalledWith({
      wallet: WALLET,
      nonce: challenge.input.nonce,
      signature: bs58.encode(SIGNATURE),
    })
    expect(wallet.connect).not.toHaveBeenCalled()
  })

  it('signs the served text byte for byte when the wallet has no sign-in', async () => {
    const api = fakeApi()
    const signMessage = vi.fn<NonNullable<SigningWallet['signMessage']>>(async () => SIGNATURE)

    await signInWith({ publicKey: key(WALLET), connect: vi.fn(), signMessage }, api)
    expect(signMessage).toHaveBeenCalledWith(messageBytes)
    expect(bs58.decode(api.verify.mock.calls[0]?.[0].signature ?? '')).toEqual(SIGNATURE)
  })

  it('connects the wallet first when it has no account yet', async () => {
    const api = fakeApi()
    const wallet: SigningWallet & { publicKey: { toBase58(): string } | null } = {
      publicKey: null,
      connect: vi.fn(async () => {
        wallet.publicKey = key(WALLET)
      }),
      signMessage: async () => SIGNATURE,
    }

    await signInWith(wallet, api)
    expect(wallet.connect).toHaveBeenCalledOnce()
    expect(api.challenge).toHaveBeenCalledWith(WALLET)
  })

  it.each([
    [
      'other-account',
      { account: { address: OTHER }, signedMessage: messageBytes, signature: SIGNATURE },
    ],
    [
      'other-text',
      {
        account: { address: WALLET },
        signedMessage: new TextEncoder().encode(`${challenge.message}\nResources:`),
        signature: SIGNATURE,
      },
    ],
  ] as const)('stops before verify when the wallet signs %s', async (reason, output) => {
    const api = fakeApi()
    const wallet: SigningWallet = {
      publicKey: key(WALLET),
      connect: vi.fn(),
      signIn: async () => output,
    }

    await expect(signInWith(wallet, api)).rejects.toEqual(new SignInError(reason))
    expect(api.verify).not.toHaveBeenCalled()
  })

  it('asks what the wallet can sign only once it is connected', async () => {
    const api = fakeApi()
    const wallet: SigningWallet = {
      publicKey: null,
      connect: vi.fn(async () => {
        wallet.publicKey = key(WALLET)
        wallet.signMessage = async () => SIGNATURE
      }),
    }

    expect(await signInWith(wallet, api)).toEqual(session)
  })

  it('refuses a wallet that can sign neither way, before asking for a challenge', async () => {
    const api = fakeApi()
    await expect(signInWith({ publicKey: key(WALLET), connect: vi.fn() }, api)).rejects.toEqual(
      new SignInError('cannot-sign'),
    )
    expect(api.challenge).not.toHaveBeenCalled()
  })

  it('passes the gateway’s refusal on', async () => {
    const api = fakeApi()
    api.verify.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', null))
    const wallet: SigningWallet = {
      publicKey: key(WALLET),
      connect: vi.fn(),
      signMessage: async () => SIGNATURE,
    }
    await expect(signInWith(wallet, api)).rejects.toBeInstanceOf(ApiError)
  })
})

describe('describeFailure', () => {
  it.each([
    [new SignInError('cannot-sign'), /cannot sign messages/],
    [new SignInError('other-account'), /different account/],
    [new SignInError('other-text'), /different text/],
    [new ApiError(401, 'UNAUTHORIZED', null), /did not accept the signature/],
    [new ApiError(429, 'RATE_LIMITED', 12), /12 seconds/],
    [new ApiError(500, 'INTERNAL', null), /HTTP 500/],
    [
      Object.assign(new Error('User rejected the request.'), { name: 'WalletSignInError' }),
      /User rejected the request/,
    ],
    [new TypeError('Failed to fetch'), /could not be reached/],
  ])('names %s', (error, expected) => {
    expect(describeFailure(error)).toMatch(expected)
  })
})
