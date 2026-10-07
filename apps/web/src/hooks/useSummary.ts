import type { PublisherSummary } from '@contentledger/shared'
import { useEffect, useRef, useState } from 'react'
import type { PublisherSource } from '@/lib/api'
import type { Link } from '@/lib/follow'
import { followSummary, type Period } from '@/lib/summary'

export function useSummary(
  source: PublisherSource,
  period: Period,
  onUnauthorized: (() => void) | undefined,
) {
  const [summary, setSummary] = useState<PublisherSummary | null>(null)
  const [link, setLink] = useState<Link>('connecting')
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  useEffect(() => {
    const controller = new AbortController()
    // The previous period's figures under the new period's name would be wrong, not stale.
    setSummary(null)
    setLink('connecting')
    void followSummary(
      source,
      period,
      {
        summary: setSummary,
        link: setLink,
        unauthorized: () => unauthorized.current?.(),
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [source, period])

  return { summary, link }
}
