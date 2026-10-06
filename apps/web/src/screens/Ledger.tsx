import type { PublisherReceipt } from '@contentledger/shared'
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { type EdgeFlash, edgeId, FlowMap, MapBand } from '@/components/FlowMap'
import { Column, FieldLabel, Figure, Section, SmallCaps } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { CONSUMER_TOTALS, receipts, SETTLEMENT, subscribeReceipts, summary } from '@/lib/api'
import { formatCount, formatUsdc, timeOfDay, truncateMiddle, workPath } from '@/lib/format'
import { COLOR } from '@/lib/theme'

interface LedgerProps {
  readonly onOpenReceipt: () => void
}

interface Displayed extends PublisherReceipt {
  readonly arrived: boolean
}

const INITIAL: readonly Displayed[] = receipts.items.map((row) => ({ ...row, arrived: false }))

export function Ledger({ onOpenReceipt }: LedgerProps) {
  const narrow = useIsNarrow()
  const [rows, setRows] = useState<readonly Displayed[]>(INITIAL)
  const [flash, setFlash] = useState<EdgeFlash | null>(null)
  const arrivedCount = useRef(0)

  useEffect(
    () =>
      subscribeReceipts((incoming) => {
        arrivedCount.current += 1
        setRows((previous) => [{ ...incoming, arrived: true }, ...previous])
        setFlash({ edgeId: edgeId(incoming.consumer, incoming.workId), seq: arrivedCount.current })
      }),
    [],
  )

  return (
    <>
      <MapBand>
        <p className="serif" style={{ fontSize: narrow ? 18 : 21, marginBottom: narrow ? 20 : 28 }}>
          Over the last seven days, {formatCount(CONSUMER_TOTALS.length)} AI systems took{' '}
          {formatCount(summary.count)} pieces of your work.
        </p>
        <FlowMap flash={flash} title="Takings by AI system and by work" />
        <div className="mt-8 flex flex-col items-end gap-6 md:mt-10 md:flex-row md:justify-end md:gap-16">
          <div style={{ textAlign: 'right' }}>
            <FieldLabel>Received, 7 days</FieldLabel>
            <Figure value={formatUsdc(summary.total)} size={narrow ? 22 : 26} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <FieldLabel>Awaiting settlement</FieldLabel>
            <Figure value={formatUsdc(SETTLEMENT.accrued)} size={narrow ? 22 : 26} />
          </div>
        </div>
      </MapBand>

      <Column>
        <Section>
          <h2 className="serif" style={{ fontSize: narrow ? 24 : 30, fontWeight: 400 }}>
            Recent takings
          </h2>
          <div className="mt-6" style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
            {rows.map((row) => (
              <Row key={row.id} row={row} narrow={narrow} onOpen={onOpenReceipt} />
            ))}
          </div>
        </Section>
      </Column>
    </>
  )
}

function Row({ row, narrow, onOpen }: { row: Displayed; narrow: boolean; onOpen: () => void }) {
  const [lifted, setLifted] = useState(false)
  const consumer = truncateMiddle(row.consumer, 13)
  const work = workPath(row.sourceId)
  const time = timeOfDay(row.acceptedAt)
  const state = row.settledAt === null ? 'ACCRUED' : 'SETTLED'

  const activate = () => onOpen()

  const common = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: activate,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        activate()
      }
    },
    onMouseEnter: () => setLifted(true),
    onMouseLeave: () => setLifted(false),
    onFocus: () => setLifted(true),
    onBlur: () => setLifted(false),
    className: row.arrived ? 'row-enter' : undefined,
    style: {
      borderBottom: `1px solid ${COLOR.hairline}`,
      background: lifted ? COLOR.lifted : 'transparent',
      cursor: 'pointer',
    } as CSSProperties,
  }

  if (narrow) {
    return (
      <div {...common}>
        <div className="flex h-[104px] flex-col justify-center gap-1 px-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="mono" title={row.consumer}>
              {consumer}
            </span>
            <span className="fig" style={{ fontSize: 15 }}>
              {formatUsdc(row.tariff)}
            </span>
          </div>
          <div
            className="serif truncate"
            style={{ color: COLOR.muted, fontSize: 14, lineHeight: 1.4 }}
          >
            {work}
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-baseline gap-3">
              <span className="fig" style={{ fontSize: 13, color: COLOR.muted }}>
                {time}
              </span>
              <SmallCaps>{row.useType}</SmallCaps>
            </span>
            <SmallCaps muted>{state}</SmallCaps>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div {...common}>
      <div
        className="grid h-[56px] items-center gap-5 px-5"
        style={{
          gridTemplateColumns: '84px 168px minmax(0,1fr) 108px 150px 104px',
        }}
      >
        <span className="fig" style={{ fontSize: 14, textAlign: 'left', color: COLOR.muted }}>
          {time}
        </span>
        <span className="mono truncate" title={row.consumer}>
          {consumer}
        </span>
        <span
          className="serif truncate"
          style={{ color: COLOR.muted, fontSize: 16 }}
          title={row.sourceId}
        >
          {work}
        </span>
        <SmallCaps>{row.useType}</SmallCaps>
        <span className="fig" style={{ fontSize: 15 }}>
          {formatUsdc(row.tariff)}
        </span>
        <span style={{ textAlign: 'right' }}>
          <SmallCaps muted>{state}</SmallCaps>
        </span>
      </div>
    </div>
  )
}
