import { useState } from 'react'
import { AuthProvider, useSession } from '@/auth/SessionProvider'
import { SignIn } from '@/auth/SignIn'
import { Nav, type ViewName } from '@/components/Nav'
import { authApi, sampleWallet } from '@/lib/api'
import { COLOR } from '@/lib/theme'
import { Ledger } from '@/screens/Ledger'
import { ReceiptScreen } from '@/screens/Receipt'
import { Summary } from '@/screens/Summary'

const PREVIEW_NOTICE = 'Preview with sample figures: no gateway is connected to this page.'
const SAMPLE_NOTICE = 'Sample figures: the ledger does not yet read this wallet’s takings.'

const App = () => (
  <div style={{ background: COLOR.ground, minHeight: '100vh', color: COLOR.ink }}>
    {authApi === null ? (
      <Dashboard wallet={sampleWallet} notice={PREVIEW_NOTICE} />
    ) : (
      <AuthProvider api={authApi}>
        <SignedIn />
      </AuthProvider>
    )}
  </div>
)

function SignedIn() {
  const { session, signOut } = useSession()
  if (session === null) return <SignIn />
  return <Dashboard wallet={session.wallet} notice={SAMPLE_NOTICE} onSignOut={signOut} />
}

function Dashboard({
  wallet,
  notice,
  onSignOut,
}: {
  wallet: string
  notice: string
  onSignOut?: () => void
}) {
  const [view, setView] = useState<ViewName>('ledger')

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

      {view === 'ledger' && <Ledger onOpenReceipt={() => setView('receipt')} />}
      {view === 'summary' && <Summary />}
      {view === 'receipt' && <ReceiptScreen onBack={() => setView('ledger')} />}
    </>
  )
}

export default App
