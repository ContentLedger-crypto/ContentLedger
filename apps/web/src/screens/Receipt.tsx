import type { ReactNode } from 'react'
import { edgeId, FlowMap, MapBand } from '@/components/FlowMap'
import { Column, Line } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { useReceipt } from '@/hooks/useReceipt'
import { useSummary } from '@/hooks/useSummary'
import type { PublicationSource, PublisherSource } from '@/lib/api'
import { formatUsdc, instantLabel, workPath } from '@/lib/format'
import type { ReceiptView } from '@/lib/receipt'
import { COLOR } from '@/lib/theme'

/** A receipt as its feed row knows it: the id to read, and the work's URL the body lacks. */
export interface ReceiptOpening {
  readonly id: string
  readonly sourceId: string
}

const RECEIPT_FEE_PROSE =
  'The fee is 10% of the rate, rounded up to the smallest unit, and is added on top. Rounding never comes out of your share.'
const VERIFY_PROSE =
  'Step 2 alone is not enough — a batch invented from nothing can be internally consistent. Step 3 is what makes it impossible.'
const VERIFY_COMMAND = 'pnpm --filter @contentledger/verify-receipt verify'

export function ReceiptScreen({
  opening,
  publication,
  source,
  onUnauthorized,
  onBack,
}: {
  opening: ReceiptOpening
  publication: PublicationSource
  source: PublisherSource
  onUnauthorized?: () => void
  onBack: () => void
}) {
  const narrow = useIsNarrow()
  const read = useReceipt(publication, opening.id)
  const { summary } = useSummary(source, '7d', onUnauthorized)
  const shown = read.status === 'read' && 'receipt' in read.view ? read.view : null
  const body = shown?.receipt.body
  const edge = summary?.flows.find(
    (flow) => flow.consumer === body?.consumer && flow.workId === body?.work,
  )

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

      {summary !== null && edge !== undefined && (
        <MapBand>
          <FlowMap
            summary={summary}
            soloEdgeId={edgeId(edge.consumer, edge.workId)}
            title="This receipt within the last seven days"
          />
        </MapBand>
      )}

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
              {opening.id}
            </div>
            {body !== undefined && (
              <div className="serif mt-1" style={{ color: COLOR.muted, fontSize: 15 }}>
                {instantLabel(body.acceptedAt)}
              </div>
            )}
          </div>

          {shown === null ? (
            <Quiet>{read.status === 'read' ? absence(read.view) : status(read.status)}</Quiet>
          ) : (
            <Read view={shown} sourceId={opening.sourceId} />
          )}
        </div>
      </Column>
    </>
  )
}

function Read({ view, sourceId }: { view: Shown; sourceId: string }) {
  const { receipt } = view
  const { body } = receipt
  const tariff = BigInt(body.tariff)
  const fee = BigInt(body.fee)

  return (
    <>
      <Block title="The taking">
        <Line label="Consumer" value={body.consumer} mono copyable />
        <Line label="Work" value={workPath(sourceId)} />
        <Line label="Source" value={sourceId} />
        <Line label="Use" value={body.useType} />
        <Line
          label="Rate source"
          value={body.rateLevel === 'work' ? 'set on this work' : 'set on the domain'}
        />
      </Block>

      <Block title="The money">
        <Line label="Your rate" value={formatUsdc(tariff)} />
        <Line label="Protocol fee" value={formatUsdc(fee)} />
        <Line label="Agent paid" value={formatUsdc(tariff + fee)} />
        <Line label="You receive" value={formatUsdc(tariff)} />
        <p className="serif" style={{ color: COLOR.muted, fontSize: 15, marginTop: 14 }}>
          {RECEIPT_FEE_PROSE}
        </p>
      </Block>

      <Block title="The content">
        <Line label="Registered hash" value={body.registryHash} mono copyable />
        <Line label="Served hash" value={body.servedHash} mono copyable />
        <Line label="Match" value={body.servedHash === body.registryHash ? 'yes' : 'no'} />
      </Block>

      <Block title="The payment">
        {body.paymentMethod === 'escrow' ? (
          <>
            <Line label="Method" value="escrow, settled in batches" />
            <Line label="Voucher sequence" value={String(body.seq)} />
          </>
        ) : (
          <>
            <Line label="Method" value="x402, paid per request" />
            <Line label="Transaction" value={body.paymentRef} mono copyable />
          </>
        )}
      </Block>

      {view.kind === 'pending' && (
        <Block title="The settlement">
          <Prose>
            Not settled yet. This receipt is accrued and waits for its batch; once the batch
            settles, everything below can be checked.
          </Prose>
        </Block>
      )}

      {view.kind === 'payment' && (
        <Block title="The settlement">
          <Prose>
            Settled by the agent’s own x402 payment, in the request it paid for. The transaction
            above is the settlement; there is no batch to prove this receipt into.
          </Prose>
        </Block>
      )}

      {view.kind === 'batch' && (
        <>
          <Block title="The settlement">
            <Line
              label="Batch"
              value={`sequences ${view.batch.seqFrom} – ${view.batch.seqTo}, ${view.batch.count} ${view.batch.count === 1 ? 'receipt' : 'receipts'}`}
            />
            <Line label="Merkle root" value={view.anchor.root} mono copyable />
            <Line label="Voucher chain" value={view.batch.chain} mono copyable />
            <Line label="Transaction" value={view.anchor.txSig} mono copyable />
            <Line label="Settled at" value={instantLabel(view.anchor.settledAt)} />
          </Block>

          <Block title="Anyone can check this">
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <Step
                n={1}
                text="Read the batch root from the chain"
                value={short(view.anchor.root)}
              />
              <Step
                n={2}
                text={`Prove this receipt is in that batch — inclusion path, ${view.anchor.path.length} ${view.anchor.path.length === 1 ? 'step' : 'steps'}`}
              >
                <div className="mt-2">
                  {view.anchor.path.map((sibling) => (
                    <div
                      key={sibling.hash}
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: COLOR.muted,
                        wordBreak: 'break-all',
                        lineHeight: 1.7,
                      }}
                    >
                      {sibling.hash}
                    </div>
                  ))}
                </div>
              </Step>
              <Step
                n={3}
                text="Recompute the voucher chain across the whole batch"
                value={short(view.batch.chain)}
              />
              <Step
                n={4}
                text="Check the sum charged matches the batch"
                value={formatUsdc(view.batch.charged)}
              />
            </ol>
            <Prose>{VERIFY_PROSE}</Prose>
            <Prose>The four steps, against the chain rather than this page:</Prose>
            <div
              className="mono mt-2"
              style={{ fontSize: 12, color: COLOR.ink, wordBreak: 'break-all', lineHeight: 1.7 }}
            >
              {`${VERIFY_COMMAND} ${receipt.id}`}
            </div>
          </Block>
        </>
      )}
    </>
  )
}

function Step({
  n,
  text,
  value = null,
  children,
}: {
  n: number
  text: string
  value?: string | null
  children?: ReactNode
}) {
  return (
    <li className="py-[10px]">
      <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-8">
        <span className="serif" style={{ fontSize: 15 }}>
          <span style={{ color: COLOR.muted }}>{n}. </span>
          {text}
        </span>
        {value !== null && (
          <span className="mono shrink-0" style={{ color: COLOR.ink }}>
            {value}
          </span>
        )}
      </div>
      {children}
    </li>
  )
}

type Shown = Exclude<ReceiptView, { kind: 'unknown' | 'tampered' }>

const short = (hex: string): string => `${hex.slice(0, 8)}…${hex.slice(-8)}`

function status(reading: 'reading' | 'failed'): string {
  return reading === 'reading'
    ? 'Reading this receipt…'
    : 'The gateway could not be reached for this receipt. Go back and open it again.'
}

function absence(view: ReceiptView): string {
  return view.kind === 'tampered'
    ? 'What the gateway served for this id does not hash to it, so none of it is shown as this receipt.'
    : 'The gateway knows no receipt with this id.'
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

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="serif" style={{ color: COLOR.muted, fontSize: 15, marginTop: 14 }}>
      {children}
    </p>
  )
}

function Quiet({ children }: { children: string }) {
  return (
    <p className="serif mt-10" style={{ color: COLOR.muted, fontSize: 16, lineHeight: 1.5 }}>
      {children}
    </p>
  )
}
