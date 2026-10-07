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
import { COLOR } from '@/lib/theme'
import { Ledger } from '@/screens/Ledger'
import { type ReceiptOpening, ReceiptScreen } from '@/screens/Receipt'
import { Summary } from '@/screens/Summary'

const PREVIEW_NOTICE = 'Preview with sample figures: no gateway is connected to this page.'

const App = () => (
  <div style={{ background: COLOR.ground, minHeight: '100vh', color: COLOR.ink }}>
    {authApi === null ? (
      <Dashboard wallet={sampleWallet} source={sampleSource} preview />
    ) : (
      <AuthProvider api={authApi}>
        <SignedIn />
      </AuthProvider>
    )}
  </div>
)

function SignedIn() {
  const { session, signOut } = useSession()
  const token = session?.token ?? null
  const source = useMemo(
    () =>
      token === null || dataMode.kind !== 'gateway'
        ? null
        : publisherApiFor(dataMode.apiUrl, token),
    [token],
  )
  if (session === null || source === null) return <SignIn />
  return <Dashboard wallet={session.wallet} source={source} preview={false} onSignOut={signOut} />
}

function Dashboard({
  wallet,
  source,
  preview,
  onSignOut,
}: {
  wallet: string
  source: PublisherSource
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
