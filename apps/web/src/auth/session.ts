import {
  type AuthChallenge,
  base58KeySchema,
  type SessionGrant,
  type SignInFields,
  sessionGrantSchema,
} from '@contentledger/shared'
import bs58 from 'bs58'
import { ApiError } from '@/lib/api'

export interface Session {
  readonly wallet: string
  readonly token: string
  readonly expiresAt: Date
}

/** `sessionStorage`: one session per tab, so three tabs can hold three publishers. */
export type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface AuthApi {
  challenge(wallet: string): Promise<AuthChallenge>
  verify(body: { wallet: string; nonce: string; signature: string }): Promise<SessionGrant>
}

/** What sign-in needs of a wallet adapter; `signIn` and `signMessage` exist only if the wallet has them. */
export interface SigningWallet {
  publicKey: { toBase58(): string } | null
  connect(): Promise<void>
  signIn?: (input: SignInFields) => Promise<{
    account: { address: string }
    signedMessage: Uint8Array
    signature: Uint8Array
  }>
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
}

export type SignInFailure = 'cannot-sign' | 'other-account' | 'other-text'

export class SignInError extends Error {
  readonly reason: SignInFailure

  constructor(reason: SignInFailure) {
    super(`sign-in stopped: ${reason}`)
    this.name = 'SignInError'
    this.reason = reason
  }
}

const KEY = 'contentledger.session'
const storedSchema = sessionGrantSchema.extend({ wallet: base58KeySchema })

export function loadSession(store: SessionStore, now: Date): Session | null {
  let raw: string | null
  try {
    raw = store.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  const stored = storedSchema.safeParse(parseJson(raw))
  if (stored.success) {
    const session = { ...stored.data, expiresAt: new Date(stored.data.expiresAt) }
    if (sessionEnd(session, now, null) === null) return session
  }
  clearSession(store)
  return null
}

export function saveSession(store: SessionStore, session: Session): void {
  try {
    store.setItem(KEY, JSON.stringify({ ...session, expiresAt: session.expiresAt.toISOString() }))
  } catch {
    // Without storage the session still lives in memory; a reload asks for a signature again.
  }
}

export function clearSession(store: SessionStore): void {
  try {
    store.removeItem(KEY)
  } catch {
    // Nothing was stored to begin with.
  }
}

/**
 * Why a session can no longer stand. The dashboard shows whatever the session wallet owns,
 * so a wallet that has switched accounts would otherwise sit above someone else's data.
 */
export function sessionEnd(
  session: Session,
  now: Date,
  connectedWallet: string | null,
): 'expired' | 'other-account' | null {
  if (now >= session.expiresAt) return 'expired'
  if (connectedWallet !== null && connectedWallet !== session.wallet) return 'other-account'
  return null
}

export async function signInWith(wallet: SigningWallet, api: AuthApi): Promise<Session> {
  if (wallet.publicKey === null) await wallet.connect()
  const address = wallet.publicKey?.toBase58()
  if (address === undefined) throw new Error('the wallet connected without an account')
  // A Standard wallet's adapter offers `signMessage` only once an account is connected.
  if (wallet.signIn === undefined && wallet.signMessage === undefined) {
    throw new SignInError('cannot-sign')
  }

  const { input, message } = await api.challenge(address)
  const signature = await sign(wallet, input, new TextEncoder().encode(message))
  const grant = await api.verify({
    wallet: address,
    nonce: input.nonce,
    signature: bs58.encode(signature),
  })
  return { wallet: address, token: grant.token, expiresAt: new Date(grant.expiresAt) }
}

async function sign(
  wallet: SigningWallet,
  input: SignInFields,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (wallet.signIn !== undefined) {
    const signed = await wallet.signIn(input)
    // The gateway checks the signature over the text it issued. A wallet that signs with
    // another account or lays SIWS out its own way would earn only a bare 401 there.
    if (signed.account.address !== input.address) throw new SignInError('other-account')
    if (!sameBytes(signed.signedMessage, message)) throw new SignInError('other-text')
    return signed.signature
  }
  if (wallet.signMessage !== undefined) return wallet.signMessage(message)
  throw new SignInError('cannot-sign')
}

export function describeFailure(error: unknown): string {
  if (error instanceof SignInError) {
    switch (error.reason) {
      case 'cannot-sign':
        return 'This wallet cannot sign messages. Choose another wallet.'
      case 'other-account':
        return 'The wallet signed with a different account than the one connected. Switch back to it and try again.'
      case 'other-text':
        return 'The wallet signed different text than the dashboard asked for, so the gateway would refuse it. Try another wallet.'
    }
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'The gateway did not accept the signature. The request may have expired; try again.'
    }
    if (error.status === 429) {
      const wait = error.retryAfter === null ? 'a moment' : `${error.retryAfter} seconds`
      return `Too many sign-in attempts from this address. Try again in ${wait}.`
    }
    return `The gateway answered HTTP ${error.status}. Try again later.`
  }
  if (error instanceof TypeError) {
    return 'The gateway could not be reached. Check the connection and try again.'
  }
  if (error instanceof Error && error.name.startsWith('Wallet')) {
    return `The wallet stopped: ${error.message || error.name}`
  }
  return error instanceof Error ? error.message : 'Sign-in failed.'
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
