import type { PublisherSummary } from '@contentledger/shared'
import type { PeriodWindow, PublisherSource } from './api'
import { followStream, type StreamReader, type StreamSink } from './follow'

export type Period = '7d' | '30d' | '12m'

export const PERIODS: readonly { readonly period: Period; readonly label: string }[] = [
  { period: '7d', label: '7 days' },
  { period: '30d', label: '30 days' },
  { period: '12m', label: '12 months' },
]

const DAY_MS = 24 * 60 * 60_000

/** Rolling, ending now: a period that ended at midnight would hide what arrived since. */
export function periodWindow(period: Period, now: Date): PeriodWindow {
  const from = new Date(now)
  if (period === '7d') from.setTime(Number(now) - 7 * DAY_MS)
  if (period === '30d') from.setTime(Number(now) - 30 * DAY_MS)
  if (period === '12m') from.setUTCFullYear(now.getUTCFullYear() - 1)
  return { from, to: now }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** UTC days, as the feed's times are UTC. */
export function periodLabel({ from, to }: PeriodWindow): string {
  const end = `${to.getUTCDate()} ${MONTHS[to.getUTCMonth()]} ${to.getUTCFullYear()}`
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    return `${from.getUTCDate()} ${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()} – ${end}`
  }
  if (from.getUTCMonth() !== to.getUTCMonth()) {
    return `${from.getUTCDate()} ${MONTHS[from.getUTCMonth()]} – ${end}`
  }
  return `${from.getUTCDate()} – ${end}`
}

export const byTotalDescending = (a: { total: bigint }, b: { total: bigint }) =>
  a.total === b.total ? 0 : a.total > b.total ? -1 : 1

// Three dashboards behind one address share the gateway's one read a second, so a burst
// of arrivals costs each of them a read every few seconds rather than one per arrival.
export const SUMMARY_REFRESH_MS = 3000

export interface SummarySink extends StreamSink {
  summary(summary: PublisherSummary): void
}

/**
 * The summary stays the gateway's: every event on the stream asks for it again rather
 * than adding the arrival here, so the figures cannot drift from what the ledger holds.
 */
export function followSummary(
  source: PublisherSource,
  period: Period,
  sink: SummarySink,
  signal: AbortSignal,
): Promise<void> {
  const reader: StreamReader = (fail, current) => {
    let pending: ReturnType<typeof setTimeout> | null = null
    let lastRead = Number.NEGATIVE_INFINITY
    let latest = 0

    const read = () => {
      pending = null
      lastRead = Date.now()
      latest += 1
      const asked = latest
      source.summary(periodWindow(period, new Date()), current).then((summary) => {
        if (asked !== latest) return
        sink.summary(summary)
        sink.link('live')
      }, fail)
    }
    const cancel = () => {
      if (pending !== null) clearTimeout(pending)
      pending = null
    }
    current.addEventListener('abort', cancel, { once: true })

    return (event) => {
      if (event.type === 'ready' || event.type === 'resync') {
        cancel()
        read()
      } else if (pending === null) {
        pending = setTimeout(read, Math.max(0, lastRead + SUMMARY_REFRESH_MS - Date.now()))
      }
    }
  }
  return followStream(source.stream, reader, sink, signal)
}
