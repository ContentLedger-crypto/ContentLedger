import { useState } from 'react'
import { Nav, type ViewName } from '@/components/Nav'
import { COLOR } from '@/lib/mock'
import { Ledger } from '@/screens/Ledger'
import { ReceiptScreen } from '@/screens/Receipt'
import { Summary } from '@/screens/Summary'

const App = () => {
  const [view, setView] = useState<ViewName>('ledger')

  return (
    <div style={{ background: COLOR.ground, minHeight: '100vh', color: COLOR.ink }}>
      {view !== 'receipt' && <Nav current={view} onNavigate={setView} />}

      {view === 'ledger' && <Ledger onOpenReceipt={() => setView('receipt')} />}
      {view === 'summary' && <Summary />}
      {view === 'receipt' && <ReceiptScreen onBack={() => setView('ledger')} />}
    </div>
  )
}

export default App
