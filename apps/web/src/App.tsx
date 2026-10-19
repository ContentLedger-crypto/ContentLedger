import { useMemo, useState } from 'react'
import { AuthProvider, useSession } from '@/auth/SessionProvider'
import { SignIn } from '@/auth/SignIn'
import { Nav, type ViewName } from '@/components/Nav'
import {
  authApi,
  dataMode,
  type PublisherSource,
  publication,
  publisherApiFor,
  sampleOpening,
  sampleSource,
  sampleWallet,
} from '@/lib/api'
import type { TransactionSender } from '@/lib/register'
import { COLOR } from '@/lib/theme'
import { Ledger } from '@/screens/Ledger'
import { type ReceiptOpening, ReceiptScreen } from '@/screens/Receipt'
import { Register } from '@/screens/Register'
import { Summary } from '@/screens/Summary'

const PREVIEW_NOTICE = 'Preview with sample figures: no gateway is connected to this page.'

const App = () => (
  <div style={{ background: COLOR.ground, minHeight: '100vh', color: COLOR.ink }}>
    {authApi === null ? (
      <Dashboard wallet={sampleWallet} source={sampleSource} send={null} chain="" preview />
    ) : (
      <AuthProvider api={authApi}>
        <SignedIn />
      </AuthProvider>
    )}
  </div>
)

function SignedIn() {
  const { session, send, signOut } = useSession()
  const token = session?.token ?? null
  const source = useMemo(
    () =>
      token === null || dataMode.kind !== 'gateway'
        ? null
        : publisherApiFor(dataMode.apiUrl, token),
    [token],
  )
  if (session === null || source === null) return <SignIn />
  return (
    <Dashboard
      wallet={session.wallet}
      source={source}
      send={send}
      chain={session.chain}
      preview={false}
      onSignOut={signOut}
    />
  )
}

function Dashboard({
  wallet,
  source,
  send,
  chain,
  preview,
  onSignOut,
}: {
  wallet: string
  source: PublisherSource
  /** `null` in the preview, which has no wallet to sign registrations with. */
  send: TransactionSender | null
  chain: string
  /** Sample figures throughout; otherwise everything is this wallet's. */
  preview: boolean
  onSignOut?: () => void
}) {
  const [view, setView] = useState<ViewName>('ledger')
  const [opening, setOpening] = useState<ReceiptOpening | null>(null)
  const notice = preview ? PREVIEW_NOTICE : null

  return (
    <>
      {view !== 'receipt' && (
        <Nav
          current={view}
          onNavigate={setView}
          wallet={wallet}
          notice={notice}
          onSignOut={onSignOut}
        />
      )}

      {view === 'ledger' && (
        <Ledger
          source={source}
          onUnauthorized={onSignOut}
          onOpenReceipt={(receipt) => {
            setOpening(preview ? sampleOpening : receipt)
            setView('receipt')
          }}
        />
      )}
      {view === 'summary' && <Summary source={source} onUnauthorized={onSignOut} />}
      {view === 'register' && (
        <Register source={source} send={send} chain={chain} onUnauthorized={onSignOut} />
      )}
      {view === 'receipt' && opening !== null && (
        <ReceiptScreen
          opening={opening}
          publication={publication}
          source={source}
          onUnauthorized={onSignOut}
          onBack={() => setView('ledger')}
        />
      )}
    </>
  )
}

export default App
