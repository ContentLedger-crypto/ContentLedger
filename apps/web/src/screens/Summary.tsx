import { FlowMap, MapBand } from '@/components/FlowMap'
import { Column, FieldLabel, Figure, Section } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import {
  CONSUMER_TOTALS,
  PERIOD_LABEL,
  PERIOD_PAID_BY_AGENTS,
  PERIOD_PROTOCOL_FEE,
  SETTLEMENT,
  summary,
} from '@/lib/api'
import { formatCount, formatUsdc, shareOf, truncateMiddle, workPath } from '@/lib/format'
import { COLOR } from '@/lib/theme'

const FEE_PROSE =
  'The fee is charged on top of the rate you set. You receive the rate you set, exactly.'
const ACCRUAL_PROSE = 'Accrued takings are paid out in the next batch, about once a minute.'

const WORK_TOTALS = [...summary.byWork].sort((a, b) =>
  a.total === b.total ? 0 : a.total > b.total ? -1 : 1,
)

const PERIOD_CHOICES: readonly { readonly label: string; readonly current: boolean }[] = [
  { label: '7 days', current: true },
  { label: '30 days', current: false },
  { label: 'All', current: false },
]

export function Summary() {
  const narrow = useIsNarrow()

  return (
    <>
      <MapBand>
        <div className="mb-6 flex flex-col gap-2 md:mb-8 md:flex-row md:items-baseline md:justify-between">
          <p className="serif" style={{ fontSize: narrow ? 18 : 21 }}>
            {PERIOD_LABEL}
          </p>
          <div className="flex items-baseline gap-5">
            {PERIOD_CHOICES.map((choice) => (
              <span
                key={choice.label}
                className="serif"
                style={{
                  fontSize: 14,
                  color: choice.current ? COLOR.sage : COLOR.muted,
                }}
              >
                {choice.label}
              </span>
            ))}
          </div>
        </div>
        <FlowMap title="Takings by AI system and by work" />
      </MapBand>

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
                value={formatUsdc(PERIOD_PAID_BY_AGENTS)}
                size={narrow ? 24 : 30}
                align="left"
              />
            </div>
            <div>
              <FieldLabel>Protocol fee</FieldLabel>
              <Figure
                value={formatUsdc(PERIOD_PROTOCOL_FEE)}
                size={narrow ? 24 : 30}
                align="left"
              />
            </div>
          </div>
          <p className="serif mt-7" style={{ color: COLOR.muted, fontSize: 16, maxWidth: 640 }}>
            {FEE_PROSE}
          </p>
        </Section>

        <Section ruled>
          <ByWork narrow={narrow} />
          <div style={{ height: 48 }} />
          <ByConsumer narrow={narrow} />
        </Section>

        <Section ruled>
          <h2
            className="serif"
            style={{ fontSize: narrow ? 22 : 28, fontWeight: 400, marginBottom: 20 }}
          >
            Settlement
          </h2>
          <div style={{ borderTop: `1px solid ${COLOR.hairline}`, maxWidth: 560 }}>
            <SettleLine label="Settled" value={formatUsdc(SETTLEMENT.settled)} />
            <SettleLine label="Accrued" value={formatUsdc(SETTLEMENT.accrued)} />
            <SettleLine label="Paid per request" value={formatUsdc(SETTLEMENT.paidPerRequest)} />
          </div>
          <p className="serif mt-6" style={{ color: COLOR.muted, fontSize: 16 }}>
            {ACCRUAL_PROSE}
          </p>
        </Section>
      </Column>
    </>
  )
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

function ByWork({ narrow }: { narrow: boolean }) {
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
        {WORK_TOTALS.map((total) => {
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

function ByConsumer({ narrow }: { narrow: boolean }) {
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
        {CONSUMER_TOTALS.map((total) => {
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
                <StackedPair label="Requests" value={formatCount(total.requests)} />
                <StackedPair label="Amount" value={formatUsdc(total.amount)} />
                <StackedPair label="Paid by" value={total.paysBy} serifValue />
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
                {formatCount(total.requests)}
              </span>
              <span className="fig" style={{ fontSize: 15 }}>
                {formatUsdc(total.amount)}
              </span>
              <span
                className="serif"
                style={{ fontSize: 15, color: COLOR.muted, textAlign: 'right' }}
              >
                {total.paysBy}
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
