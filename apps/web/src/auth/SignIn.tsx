import { WalletReadyState } from '@solana/wallet-adapter-base'
import { Column, Section } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { COLOR } from '@/lib/theme'
import { useSession } from './SessionProvider'

export function SignIn() {
  const narrow = useIsNarrow()
  const { wallets, pending, failure, signIn } = useSession()
  const usable = wallets.filter(
    (wallet) =>
      wallet.readyState === WalletReadyState.Installed ||
      wallet.readyState === WalletReadyState.Loadable,
  )

  return (
    <Column>
      <Section>
        <div style={{ maxWidth: 560 }}>
          <h1 className="serif" style={{ fontSize: narrow ? 26 : 34, fontWeight: 400 }}>
            Sign in
          </h1>
          <p className="serif mt-4" style={{ fontSize: narrow ? 17 : 19, color: COLOR.muted }}>
            Sign a one-time message with the wallet your payouts go to. Signing sends no transaction
            and costs nothing; the dashboard then shows the works this wallet owns.
          </p>

          <div className="mt-8" style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
            {usable.length === 0 ? (
              <p className="serif py-5" style={{ fontSize: 17 }}>
                No Solana wallet was found in this browser. Install one that supports the Wallet
                Standard, then reload this page.
              </p>
            ) : (
              usable.map((wallet) => {
                const waiting = pending === wallet.name
                return (
                  <button
                    key={wallet.name}
                    type="button"
                    disabled={pending !== null}
                    onClick={() => signIn(wallet.name)}
                    className="flex w-full items-center gap-4 py-4 text-left"
                    style={{
                      background: 'none',
                      border: 'none',
                      borderBottom: `1px solid ${COLOR.hairline}`,
                      color: pending !== null && !waiting ? COLOR.muted : COLOR.ink,
                      cursor: pending === null ? 'pointer' : 'default',
                    }}
                  >
                    <img src={wallet.icon} alt="" width={28} height={28} />
                    <span className="serif" style={{ fontSize: 19 }}>
                      {wallet.name}
                    </span>
                    {waiting && (
                      <span className="serif ml-auto" style={{ color: COLOR.sage, fontSize: 15 }}>
                        Waiting for the wallet…
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {failure !== null && (
            <p
              role="alert"
              className="serif mt-6"
              style={{ fontSize: 17, borderLeft: `2px solid ${COLOR.sage}`, paddingLeft: 14 }}
            >
              {failure}
            </p>
          )}
        </div>
      </Section>
    </Column>
  )
}
