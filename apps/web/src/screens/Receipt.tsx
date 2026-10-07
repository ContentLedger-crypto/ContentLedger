import type { ReactNode } from 'react'
import { edgeId, FlowMap, MapBand } from '@/components/FlowMap'
import { Column, Line } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { INCLUSION_PATH, RECEIPT, sampleSummary, VERIFY_STEPS } from '@/lib/api'
import { formatUsdc, workPath } from '@/lib/format'
import { COLOR } from '@/lib/theme'

const RECEIPT_FEE_PROSE =
  'The fee is 10% of the rate, rounded up to the smallest unit, and is added on top. Rounding never comes out of your share.'
const VERIFY_PROSE =
  'Step 2 alone is not enough — a batch invented from nothing can be internally consistent. Step 3 is what makes it impossible.'

export function ReceiptScreen({ onBack }: { onBack: () => void }) {
  const narrow = useIsNarrow()

  return (
    <>
      <Column>
        <div className="py-6 md:py-8">
          <button
            type="button"
            onClick={onBack}
            className="serif"
            style={{
              color: COLOR.muted,
              fontSize: 15,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            ← Ledger
          </button>
        </div>
      </Column>

      <MapBand>
        <FlowMap
          summary={sampleSummary}
          soloEdgeId={edgeId(RECEIPT.consumer, RECEIPT.workId)}
          title="This receipt within the period"
        />
      </MapBand>

      <Column>
        <div className="w-full max-w-[680px] pb-24">
          <div className="pt-[36px] md:pt-[56px]">
            <h1
              className="serif"
              style={{ fontSize: narrow ? 30 : 40, fontWeight: 400, lineHeight: 1.15 }}
            >
              Receipt
            </h1>
            <div className="mono mt-3 break-all" style={{ color: COLOR.ink }}>
              {RECEIPT.id}
            </div>
            <div className="serif mt-1" style={{ color: COLOR.muted, fontSize: 15 }}>
              {RECEIPT.issuedAt}
            </div>
          </div>

          <Block title="The taking">
            <Line label="Consumer" value={RECEIPT.consumer} mono copyable />
            <Line label="Work" value={workPath(RECEIPT.source)} />
            <Line label="Source" value={RECEIPT.source} />
            <Line label="Use" value={RECEIPT.use} />
            <Line label="Rate source" value={RECEIPT.rateSourceLabel} />
          </Block>

          <Block title="The money">
            <Line label="Your rate" value={formatUsdc(RECEIPT.yourRate)} />
            <Line label="Protocol fee" value={formatUsdc(RECEIPT.protocolFee)} />
            <Line label="Agent paid" value={formatUsdc(RECEIPT.agentPaid)} />
            <Line label="You receive" value={formatUsdc(RECEIPT.youReceive)} />
            <p className="serif" style={{ color: COLOR.muted, fontSize: 15, marginTop: 14 }}>
              {RECEIPT_FEE_PROSE}
            </p>
          </Block>

          <Block title="The content">
            <Line label="Registered hash" value={RECEIPT.registeredHash} mono copyable />
            <Line label="Served hash" value={RECEIPT.servedHash} mono copyable />
            <Line label="Match" value={RECEIPT.match} />
          </Block>

          <Block title="The payment">
            <Line label="Method" value={RECEIPT.method} />
            <Line label="Escrow account" value={RECEIPT.escrowAccount} mono copyable />
            <Line label="Voucher sequence" value={RECEIPT.voucherSequence} />
            <Line label="Running total before" value={formatUsdc(RECEIPT.runningBefore)} />
            <Line label="Running total after" value={formatUsdc(RECEIPT.runningAfter)} />
          </Block>

          <Block title="The settlement">
            <Line
              label="Batch"
              value={`sequences ${RECEIPT.batchFrom} – ${RECEIPT.batchTo}, ${RECEIPT.batchCount} receipts`}
            />
            <Line label="Merkle root" value={RECEIPT.merkleRoot} mono copyable />
            <Line label="Voucher chain" value={RECEIPT.voucherChain} mono copyable />
            <Line label="Transaction" value={RECEIPT.transaction} mono copyable />
            <Line label="Settled at" value={RECEIPT.settledAt} />
          </Block>

          <Block title="Anyone can check this">
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {VERIFY_STEPS.map((step) => (
                <li key={step.n} className="py-[10px]">
                  <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-8">
                    <span className="serif" style={{ fontSize: 15 }}>
                      <span style={{ color: COLOR.muted }}>{step.n}. </span>
                      {step.text}
                    </span>
                    {step.value !== null && (
                      <span className="mono shrink-0" style={{ color: COLOR.ink }}>
                        {step.value}
                      </span>
                    )}
                  </div>
                  {step.n === 2 && (
                    <div className="mt-2">
                      {INCLUSION_PATH.map((sibling) => (
                        <div
                          key={sibling}
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: COLOR.muted,
                            wordBreak: 'break-all',
                            lineHeight: 1.7,
                          }}
                        >
                          {sibling}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <p className="serif" style={{ color: COLOR.muted, fontSize: 15, marginTop: 14 }}>
              {VERIFY_PROSE}
            </p>
          </Block>
        </div>
      </Column>
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ borderTop: `1px solid ${COLOR.hairline}`, marginTop: 40, paddingTop: 40 }}>
      <h2 className="serif" style={{ fontSize: 22, fontWeight: 400, marginBottom: 12 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}
