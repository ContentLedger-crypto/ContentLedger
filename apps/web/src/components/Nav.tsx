import { Column } from '@/components/Primitives'
import { COLOR, PUBLISHER } from '@/lib/mock'

export type ViewName = 'ledger' | 'summary' | 'receipt'

const ITEMS: readonly { readonly id: 'ledger' | 'summary'; readonly label: string }[] = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'summary', label: 'Summary' },
]

export function Nav({
  current,
  onNavigate,
}: {
  current: ViewName
  onNavigate: (view: ViewName) => void
}) {
  return (
    <Column>
      <div className="flex flex-col gap-2 py-6 md:flex-row md:items-baseline md:justify-between md:py-8">
        <nav className="flex items-baseline gap-7">
          {ITEMS.map((item) => {
            const active = current === item.id
            return (
              <button
                key={item.id}
                type="button"
                className="navitem"
                onClick={() => onNavigate(item.id)}
                style={{
                  color: active ? COLOR.sage : COLOR.muted,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            )
          })}
        </nav>
        <div className="serif" style={{ color: COLOR.muted, fontSize: 14 }}>
          {PUBLISHER.name} — {PUBLISHER.domain}
        </div>
      </div>
    </Column>
  )
}
