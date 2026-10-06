import type { Adapter, WalletName, WalletReadyState } from '@solana/wallet-adapter-base'
import { useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  type AuthApi,
  clearSession,
  describeFailure,
  loadSession,
  type Session,
  type SessionStore,
  type SigningWallet,
  saveSession,
  sessionEnd,
  signInWith,
} from './session'

export interface WalletChoice {
  readonly name: WalletName
  readonly icon: string
  readonly readyState: WalletReadyState
}

interface SessionState {
  readonly session: Session | null
  readonly wallets: readonly WalletChoice[]
  /** The wallet a sign-in is waiting on. */
  readonly pending: WalletName | null
  readonly failure: string | null
  signIn(name: WalletName): void
  signOut(): void
}

const SessionContext = createContext<SessionState | null>(null)

// Wallets that implement the Wallet Standard announce themselves; no adapter is bundled.
const NO_ADAPTERS: Adapter[] = []

const store: SessionStore = {
  getItem: (key) => window.sessionStorage.getItem(key),
  setItem: (key, value) => window.sessionStorage.setItem(key, value),
  removeItem: (key) => window.sessionStorage.removeItem(key),
}

export function AuthProvider({ api, children }: { api: AuthApi; children: ReactNode }) {
  return (
    <WalletProvider wallets={NO_ADAPTERS} autoConnect={false}>
      <SessionProvider api={api}>{children}</SessionProvider>
    </WalletProvider>
  )
}

function SessionProvider({ api, children }: { api: AuthApi; children: ReactNode }) {
  const { wallets, select, publicKey, disconnect } = useWallet()
  const [session, setSession] = useState(() => loadSession(store, new Date()))
  const [pending, setPending] = useState<WalletName | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const signOut = useCallback(() => {
    clearSession(store)
    setSession(null)
    disconnect().catch(() => undefined)
  }, [disconnect])

  const connected = publicKey?.toBase58() ?? null
  useEffect(() => {
    if (session === null) return
    if (sessionEnd(session, new Date(), connected) !== null) {
      signOut()
      return
    }
    const timer = window.setTimeout(signOut, session.expiresAt.getTime() - Date.now())
    return () => window.clearTimeout(timer)
  }, [session, connected, signOut])

  const signIn = useCallback(
    async (name: WalletName) => {
      const adapter = wallets.find((wallet) => wallet.adapter.name === name)?.adapter
      if (adapter === undefined) return
      setPending(name)
      setFailure(null)
      select(name)
      try {
        const next = await signInWith(signingWallet(adapter), api)
        saveSession(store, next)
        setSession(next)
      } catch (error) {
        setFailure(describeFailure(error))
      } finally {
        setPending(null)
      }
    },
    [wallets, select, api],
  )

  const value = useMemo<SessionState>(
    () => ({
      session,
      wallets: wallets.map(({ adapter, readyState }) => ({
        name: adapter.name,
        icon: adapter.icon,
        readyState,
      })),
      pending,
      failure,
      signIn: (name) => void signIn(name),
      signOut,
    }),
    [session, wallets, pending, failure, signIn, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const state = useContext(SessionContext)
  if (state === null) throw new Error('useSession outside AuthProvider')
  return state
}

// The adapter is driven directly rather than through `useWallet().connect`: the provider
// learns of a `select` only on its next render, and a sign-in started in the same click
// would find no wallet selected. Getters, because the adapter adds and removes its
// signing methods as accounts connect.
function signingWallet(adapter: Adapter): SigningWallet {
  return {
    get publicKey() {
      return adapter.publicKey
    },
    connect: () => adapter.connect(),
    get signIn() {
      return 'signIn' in adapter ? adapter.signIn.bind(adapter) : undefined
    },
    get signMessage() {
      return 'signMessage' in adapter ? adapter.signMessage.bind(adapter) : undefined
    },
  }
}
