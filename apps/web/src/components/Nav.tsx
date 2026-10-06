import { Column } from '@/components/Primitives'
import { COLOR } from '@/lib/theme'

export type ViewName = 'ledger' | 'summary' | 'receipt'

const ITEMS: readonly { readonly id: 'ledger' | 'summary'; readonly label: string }[] = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'summary', label: 'Summary' },
]

export function Nav({
  current,
  onNavigate,
  wallet,
  notice,
  onSignOut,
}: {
  current: ViewName
  onNavigate: (view: ViewName) => void
  wallet: string
  /** Says what the figures below are while they are not this wallet's own. */
  notice: string | null
  onSignOut?: () => void
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
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <div className="mono" style={{ color: COLOR.muted }} title={wallet}>
            {wallet}
          </div>
          {onSignOut && (
            <button
              type="button"
              className="navitem"
              onClick={onSignOut}
              style={{
                color: COLOR.muted,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </div>
      {notice !== null && (
        <p className="serif pb-2" style={{ color: COLOR.muted, fontSize: 14 }}>
          {notice}
        </p>
      )}
    </Column>
  )
}
