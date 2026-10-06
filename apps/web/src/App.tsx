import { useMemo, useState } from 'react'
import { AuthProvider, useSession } from '@/auth/SessionProvider'
import { SignIn } from '@/auth/SignIn'
import { Nav, type ViewName } from '@/components/Nav'
import {
  authApi,
  dataMode,
  type FeedSource,
  publisherApiFor,
  sampleFeed,
  sampleWallet,
} from '@/lib/api'
import { COLOR } from '@/lib/theme'
import { Ledger } from '@/screens/Ledger'
import { ReceiptScreen } from '@/screens/Receipt'
import { Summary } from '@/screens/Summary'

const PREVIEW_NOTICE = 'Preview with sample figures: no gateway is connected to this page.'
const SAMPLE_SUMMARY_NOTICE = 'Sample figures: the summary does not yet read this wallet’s takings.'

const App = () => (
  <div style={{ background: COLOR.ground, minHeight: '100vh', color: COLOR.ink }}>
    {authApi === null ? (
      <Dashboard wallet={sampleWallet} source={sampleFeed} preview />
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
  source: FeedSource
  /** Sample figures throughout; otherwise the feed is this wallet's and the rest says so. */
  preview: boolean
  onSignOut?: () => void
}) {
  const [view, setView] = useState<ViewName>('ledger')
  const notice = preview ? PREVIEW_NOTICE : view === 'summary' ? SAMPLE_SUMMARY_NOTICE : null

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
          sampleBand={!preview}
          onUnauthorized={onSignOut}
          // The receipt screen shows a sample until it reads the row it was opened from.
          onOpenReceipt={preview ? () => setView('receipt') : undefined}
        />
      )}
      {view === 'summary' && <Summary />}
      {view === 'receipt' && <ReceiptScreen onBack={() => setView('ledger')} />}
    </>
  )
}

export default App
