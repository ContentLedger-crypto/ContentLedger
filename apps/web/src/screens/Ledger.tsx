import type { PublisherReceipt } from '@contentledger/shared'
import { useCallback, useRef, useState } from 'react'
import { type EdgeFlash, edgeId, FlowMap, MapBand } from '@/components/FlowMap'
import { Column, FieldLabel, Figure, Section, SmallCaps } from '@/components/Primitives'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { CONSUMER_TOTALS, type FeedSource, SETTLEMENT, summary } from '@/lib/api'
import { formatCount, formatUsdc } from '@/lib/format'
import { Feed } from '@/screens/Feed'

interface LedgerProps {
  readonly source: FeedSource
  /** The band's aggregates are not yet read from the ledger, while the feed below is. */
  readonly sampleBand: boolean
  readonly onUnauthorized?: () => void
  readonly onOpenReceipt?: () => void
}

export function Ledger({ source, sampleBand, onUnauthorized, onOpenReceipt }: LedgerProps) {
  const narrow = useIsNarrow()
  const [flash, setFlash] = useState<EdgeFlash | null>(null)
  const arrivedCount = useRef(0)

  const onArrival = useCallback((incoming: PublisherReceipt) => {
    arrivedCount.current += 1
    setFlash({ edgeId: edgeId(incoming.consumer, incoming.workId), seq: arrivedCount.current })
  }, [])

  return (
    <>
      <MapBand>
        {sampleBand && (
          <div style={{ marginBottom: narrow ? 12 : 16 }}>
            <SmallCaps muted>sample figures</SmallCaps>
          </div>
        )}
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
          <Feed
            source={source}
            narrow={narrow}
            onUnauthorized={onUnauthorized}
            onArrival={sampleBand ? undefined : onArrival}
            onOpenReceipt={onOpenReceipt}
          />
        </Section>
      </Column>
    </>
  )
}
