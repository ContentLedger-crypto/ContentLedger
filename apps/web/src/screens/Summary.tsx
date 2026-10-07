import type { PublisherSummary } from '@contentledger/shared'
import { useState } from 'react'
import { FlowMap, MapBand } from '@/components/FlowMap'
import { Column, FieldLabel, Figure, Section } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { useSummary } from '@/hooks/useSummary'
import type { PublisherSource } from '@/lib/api'
import type { Link } from '@/lib/follow'
import { formatCount, formatUsdc, shareOf, truncateMiddle, workPath } from '@/lib/format'
import { byTotalDescending, PERIODS, type Period, periodLabel, periodWindow } from '@/lib/summary'
import { COLOR } from '@/lib/theme'

const FEE_PROSE =
  'The fee is charged on top of the rate you set. You receive the rate you set, exactly.'
const ACCRUAL_PROSE = 'Accrued takings are paid out in the next batch, about once a minute.'

interface SummaryProps {
  readonly source: PublisherSource
  readonly onUnauthorized?: () => void
}

export function Summary({ source, onUnauthorized }: SummaryProps) {
  const narrow = useIsNarrow()
  const [period, setPeriod] = useState<Period>('7d')
  const { summary, link } = useSummary(source, period, onUnauthorized)

  return (
    <>
      <MapBand>
        <div className="mb-6 flex flex-col gap-2 md:mb-8 md:flex-row md:items-baseline md:justify-between">
          <p className="serif" style={{ fontSize: narrow ? 18 : 21 }}>
            {periodLabel(periodWindow(period, new Date()))}
          </p>
          <fieldset className="m-0 flex items-baseline gap-5 border-0 p-0" aria-label="Period">
            {PERIODS.map((choice) => (
              <button
                key={choice.period}
                type="button"
                className="serif navitem"
                aria-pressed={choice.period === period}
                onClick={() => setPeriod(choice.period)}
                style={{
                  fontSize: 14,
                  color: choice.period === period ? COLOR.sage : COLOR.muted,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                {choice.label}
              </button>
            ))}
          </fieldset>
        </div>
        {summary !== null && summary.flows.length > 0 ? (
          <FlowMap summary={summary} title="Takings by AI system and by work" />
        ) : (
          <Quiet>{periodInBrief(summary, link)}</Quiet>
        )}
      </MapBand>

      {summary !== null && (
        <Column>
          <Section>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-3 md:gap-10">
              <div>
                <FieldLabel>Received</FieldLabel>
                <Figure value={formatUsdc(summary.total)} size={narrow ? 24 : 30} align="left" />
              </div>
              <div>
                <FieldLabel>Paid by agents</FieldLabel>
                <Figure
                  value={formatUsdc(summary.total + summary.fee)}
                  size={narrow ? 24 : 30}
                  align="left"
                />
              </div>
              <div>
                <FieldLabel>Protocol fee</FieldLabel>
                <Figure value={formatUsdc(summary.fee)} size={narrow ? 24 : 30} align="left" />
              </div>
            </div>
            <p className="serif mt-7" style={{ color: COLOR.muted, fontSize: 16, maxWidth: 640 }}>
              {FEE_PROSE}
            </p>
          </Section>

          {summary.count > 0 && (
            <>
              <Section ruled>
                <ByWork summary={summary} narrow={narrow} />
                <div style={{ height: 48 }} />
                <ByConsumer summary={summary} narrow={narrow} />
              </Section>

              <Section ruled>
                <h2
                  className="serif"
                  style={{ fontSize: narrow ? 22 : 28, fontWeight: 400, marginBottom: 20 }}
                >
                  Settlement
                </h2>
                <div style={{ borderTop: `1px solid ${COLOR.hairline}`, maxWidth: 560 }}>
                  <SettleLine
                    label="Settled in batch"
                    value={formatUsdc(summary.settlement.inBatch)}
                  />
                  <SettleLine label="Accrued" value={formatUsdc(summary.settlement.accrued)} />
                  <SettleLine
                    label="Paid per request"
                    value={formatUsdc(summary.settlement.perRequest)}
                  />
                </div>
                <p className="serif mt-6" style={{ color: COLOR.muted, fontSize: 16 }}>
                  {ACCRUAL_PROSE}
                </p>
              </Section>
            </>
          )}
        </Column>
      )}
    </>
  )
}

function periodInBrief(summary: PublisherSummary | null, link: Link): string {
  if (summary === null) {
    return link === 'reconnecting'
      ? 'The gateway cannot be reached. Trying again.'
      : 'Reading the ledger…'
  }
  if (summary.registeredWorks === 0) {
    return 'No works are registered to this wallet yet. Once one is, what AI systems pay for it is summed here.'
  }
  return 'Nothing of yours was taken in this period.'
}

function Quiet({ children }: { children: string }) {
  return (
    <p className="serif" style={{ color: COLOR.muted, fontSize: 16, lineHeight: 1.5 }}>
      {children}
    </p>
  )
}

type PaymentMethod = PublisherSummary['byConsumer'][number]['paymentMethods'][number]

const PAID_BY: Readonly<Record<PaymentMethod, string>> = {
  escrow: 'escrow',
  x402: 'per request',
}

function SettleLine({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-6 py-[14px]"
      style={{ borderBottom: `1px solid ${COLOR.hairline}` }}
    >
      <span className="serif" style={{ fontSize: 16 }}>
        {label}
      </span>
      <span className="fig" style={{ fontSize: 16 }}>
        {value}
      </span>
    </div>
  )
}

function TableHead({ columns, template }: { columns: readonly string[]; template: string }) {
  return (
    <div
      className="grid gap-5 px-5 py-3"
      style={{
        gridTemplateColumns: template,
        borderBottom: `1px solid ${COLOR.hairline}`,
      }}
    >
      {columns.map((column, index) => (
        <span
          key={column}
          className="smallcaps"
          style={{
            color: COLOR.muted,
            fontSize: 14,
            textAlign: index === 0 ? 'left' : 'right',
          }}
        >
          {column.toLowerCase()}
        </span>
      ))}
    </div>
  )
}

const WORK_TEMPLATE = 'minmax(0,1fr) 110px 160px 90px'

function ByWork({ summary, narrow }: { summary: PublisherSummary; narrow: boolean }) {
  return (
    <div>
      <h2
        className="serif"
        style={{ fontSize: narrow ? 22 : 28, fontWeight: 400, marginBottom: 20 }}
      >
        By work
      </h2>
      <div style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
        {!narrow && (
          <TableHead template={WORK_TEMPLATE} columns={['Work', 'Requests', 'Amount', 'Share']} />
        )}
        {[...summary.byWork].sort(byTotalDescending).map((total) => {
          const share = shareOf(total.total, summary.total) ?? '—'
          const titleCell = (
            <div className="serif min-w-0 truncate" style={{ fontSize: 16 }} title={total.sourceId}>
              {workPath(total.sourceId)}
            </div>
          )

          if (narrow) {
            return (
              <div
                key={total.workId}
                className="flex flex-col gap-2 py-4"
                style={{ borderBottom: `1px solid ${COLOR.hairline}` }}
              >
                {titleCell}
                <StackedPair label="Requests" value={formatCount(total.count)} />
                <StackedPair label="Amount" value={formatUsdc(total.total)} />
                <StackedPair label="Share" value={share} />
              </div>
            )
          }

          return (
            <div
              key={total.workId}
              className="grid h-[56px] items-center gap-5 px-5"
              style={{
                gridTemplateColumns: WORK_TEMPLATE,
                borderBottom: `1px solid ${COLOR.hairline}`,
              }}
            >
              {titleCell}
              <span className="fig" style={{ fontSize: 15 }}>
                {formatCount(total.count)}
              </span>
              <span className="fig" style={{ fontSize: 15 }}>
                {formatUsdc(total.total)}
              </span>
              <span className="fig" style={{ fontSize: 15, color: COLOR.muted }}>
                {share}
              </span>
            </div>
          )
        })}

        {narrow ? (
          <div className="flex flex-col gap-2 py-4">
            <div className="serif" style={{ fontSize: 16 }}>
              Total
            </div>
            <StackedPair label="Requests" value={formatCount(summary.count)} />
            <StackedPair label="Amount" value={formatUsdc(summary.total)} />
          </div>
        ) : (
          <div
            className="grid min-h-[56px] items-center gap-5 px-5"
            style={{ gridTemplateColumns: WORK_TEMPLATE }}
          >
            <span className="serif" style={{ fontSize: 16 }}>
              Total
            </span>
            <span className="fig" style={{ fontSize: 15 }}>
              {formatCount(summary.count)}
            </span>
            <span className="fig" style={{ fontSize: 15 }}>
              {formatUsdc(summary.total)}
            </span>
            <span />
          </div>
        )}
      </div>
    </div>
  )
}

const CONSUMER_TEMPLATE = 'minmax(0,1fr) 110px 170px 140px'

function ByConsumer({ summary, narrow }: { summary: PublisherSummary; narrow: boolean }) {
  return (
    <div>
      <h2
        className="serif"
        style={{ fontSize: narrow ? 22 : 28, fontWeight: 400, marginBottom: 20 }}
      >
        By consumer
      </h2>
      <div style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
        {!narrow && (
          <TableHead
            template={CONSUMER_TEMPLATE}
            columns={['Consumer', 'Requests', 'Amount', 'Paid by']}
          />
        )}
        {summary.byConsumer.map((total) => {
          const paidBy = total.paymentMethods.map((method) => PAID_BY[method]).join(', ')
          if (narrow) {
            return (
              <div
                key={total.consumer}
                className="flex flex-col gap-2 py-4"
                style={{ borderBottom: `1px solid ${COLOR.hairline}` }}
              >
                <div className="mono" title={total.consumer}>
                  {truncateMiddle(total.consumer, 20)}
                </div>
                <StackedPair label="Requests" value={formatCount(total.count)} />
                <StackedPair label="Amount" value={formatUsdc(total.total)} />
                <StackedPair label="Paid by" value={paidBy} serifValue />
              </div>
            )
          }

          return (
            <div
              key={total.consumer}
              className="grid h-[56px] items-center gap-5 px-5"
              style={{
                gridTemplateColumns: CONSUMER_TEMPLATE,
                borderBottom: `1px solid ${COLOR.hairline}`,
              }}
            >
              <span className="mono truncate" title={total.consumer}>
                {total.consumer}
              </span>
              <span className="fig" style={{ fontSize: 15 }}>
                {formatCount(total.count)}
              </span>
              <span className="fig" style={{ fontSize: 15 }}>
                {formatUsdc(total.total)}
              </span>
              <span
                className="serif"
                style={{ fontSize: 15, color: COLOR.muted, textAlign: 'right' }}
              >
                {paidBy}
              </span>
            </div>
          )
        })}

        {narrow ? (
          <div className="flex flex-col gap-2 py-4">
            <div className="serif" style={{ fontSize: 16 }}>
              Total
            </div>
            <StackedPair label="Requests" value={formatCount(summary.count)} />
            <StackedPair label="Amount" value={formatUsdc(summary.total)} />
          </div>
        ) : (
          <div
            className="grid h-[56px] items-center gap-5 px-5"
            style={{ gridTemplateColumns: CONSUMER_TEMPLATE }}
          >
            <span className="serif" style={{ fontSize: 16 }}>
              Total
            </span>
            <span className="fig" style={{ fontSize: 15 }}>
              {formatCount(summary.count)}
            </span>
            <span className="fig" style={{ fontSize: 15 }}>
              {formatUsdc(summary.total)}
            </span>
            <span />
          </div>
        )}
      </div>
    </div>
  )
}

function StackedPair({
  label,
  value,
  serifValue = false,
}: {
  label: string
  value: string
  serifValue?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="serif" style={{ color: COLOR.muted, fontSize: 14 }}>
        {label}
      </span>
      <span className={serifValue ? 'serif' : 'fig'} style={{ fontSize: 15 }}>
        {value}
      </span>
    </div>
  )
}
