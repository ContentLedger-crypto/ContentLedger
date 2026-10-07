import type { PublisherReceipt, PublisherSummary } from '@contentledger/shared'
import { useCallback, useRef, useState } from 'react'
import { type EdgeFlash, edgeId, FlowMap, MapBand } from '@/components/FlowMap'
import { Column, FieldLabel, Figure, Section } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { useSummary } from '@/hooks/useSummary'
import type { PublisherSource } from '@/lib/api'
import { formatCount, formatUsdc } from '@/lib/format'
import { COLOR } from '@/lib/theme'
import { Feed } from '@/screens/Feed'

interface LedgerProps {
  readonly source: PublisherSource
  readonly onUnauthorized?: () => void
  readonly onOpenReceipt?: (receipt: PublisherReceipt) => void
}

export function Ledger({ source, onUnauthorized, onOpenReceipt }: LedgerProps) {
  const narrow = useIsNarrow()
  const { summary } = useSummary(source, '7d', onUnauthorized)
  const [flash, setFlash] = useState<EdgeFlash | null>(null)
  const arrivedCount = useRef(0)

  const onArrival = useCallback((incoming: PublisherReceipt) => {
    arrivedCount.current += 1
    setFlash({ edgeId: edgeId(incoming.consumer, incoming.workId), seq: arrivedCount.current })
  }, [])

  return (
    <>
      <MapBand>
        <p
          className="serif"
          style={{
            fontSize: narrow ? 18 : 21,
            marginBottom: narrow ? 20 : 28,
            color: summary === null ? COLOR.muted : COLOR.ink,
          }}
        >
          {weekInBrief(summary)}
        </p>
        {summary !== null && summary.flows.length > 0 && (
          <FlowMap summary={summary} flash={flash} title="Takings by AI system and by work" />
        )}
        {summary !== null && (
          <div className="mt-8 flex flex-col items-end gap-6 md:mt-10 md:flex-row md:justify-end md:gap-16">
            <div style={{ textAlign: 'right' }}>
              <FieldLabel>Received, 7 days</FieldLabel>
              <Figure value={formatUsdc(summary.total)} size={narrow ? 22 : 26} />
            </div>
            <div style={{ textAlign: 'right' }}>
              <FieldLabel>Awaiting settlement</FieldLabel>
              <Figure value={formatUsdc(summary.settlement.accrued)} size={narrow ? 22 : 26} />
            </div>
          </div>
        )}
      </MapBand>

      <Column>
        <Section>
          <Feed
            source={source}
            narrow={narrow}
            onUnauthorized={onUnauthorized}
            onArrival={onArrival}
            onOpenReceipt={onOpenReceipt}
          />
        </Section>
      </Column>
    </>
  )
}

function weekInBrief(summary: PublisherSummary | null): string {
  if (summary === null) return 'Reading the last seven days…'
  if (summary.registeredWorks === 0) return 'No works are registered to this wallet yet.'
  if (summary.count === 0) return 'Nothing of yours was taken in the last seven days.'
  const systems = summary.byConsumer.length
  const pieces = summary.count
  return `Over the last seven days, ${formatCount(systems)} ${systems === 1 ? 'AI system' : 'AI systems'} took ${formatCount(pieces)} ${pieces === 1 ? 'piece' : 'pieces'} of your work.`
}
