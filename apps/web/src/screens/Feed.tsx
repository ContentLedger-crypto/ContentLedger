import type { PublisherReceipt } from '@contentledger/shared'
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { SmallCaps } from '@/components/Primitives'
import { ApiError, type FeedSource } from '@/lib/api'
import {
  EMPTY_FEED,
  type FeedRow,
  type FeedState,
  type Standing,
  standingOf,
  withOlder,
} from '@/lib/feed'
import { followFeed, type Link } from '@/lib/follow'
import { clockLabel, formatUsdc, truncateMiddle, workPath } from '@/lib/format'
import { COLOR } from '@/lib/theme'

interface FeedProps {
  readonly source: FeedSource
  readonly narrow: boolean
  /** The gateway refused the session: it ended, or was never valid. */
  readonly onUnauthorized?: () => void
  readonly onArrival?: (receipt: PublisherReceipt) => void
  readonly onOpenReceipt?: (receipt: PublisherReceipt) => void
}

export function Feed({ source, narrow, onUnauthorized, onArrival, onOpenReceipt }: FeedProps) {
  const { state, link, olderFailed, loadingOlder, loadOlder } = useFeed(
    source,
    onUnauthorized,
    onArrival,
  )
  const today = new Date().toISOString().slice(0, 10)

  return (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="serif" style={{ fontSize: narrow ? 24 : 30, fontWeight: 400 }}>
          Recent takings
        </h2>
        <LinkStatus link={link} />
      </div>
      <div className="mt-6" style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
        {state.rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            today={today}
            narrow={narrow}
            onOpen={onOpenReceipt && (() => onOpenReceipt(row))}
          />
        ))}
      </div>
      {!state.loaded && (
        <Quiet>
          {link === 'reconnecting'
            ? 'The gateway cannot be reached. Trying again.'
            : 'Reading the ledger…'}
        </Quiet>
      )}
      {state.loaded && state.rows.length === 0 && (
        <Quiet>
          Nothing has been taken yet. When an AI system pays for one of your works, it appears here
          as it happens.
        </Quiet>
      )}
      {state.nextCursor !== null && (
        <div className="mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <button
            type="button"
            className="navitem"
            onClick={loadOlder}
            disabled={loadingOlder}
            style={{
              color: loadingOlder ? COLOR.muted : COLOR.sage,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: loadingOlder ? 'default' : 'pointer',
            }}
          >
            {loadingOlder ? 'Reading earlier takings…' : 'Show earlier'}
          </button>
          {olderFailed && (
            <span role="alert" className="serif" style={{ color: COLOR.muted, fontSize: 14 }}>
              Earlier takings could not be read. Try again.
            </span>
          )}
        </div>
      )}
    </>
  )
}

function useFeed(
  source: FeedSource,
  onUnauthorized: (() => void) | undefined,
  onArrival: ((receipt: PublisherReceipt) => void) | undefined,
) {
  const [state, setState] = useState<FeedState>(EMPTY_FEED)
  const [link, setLink] = useState<Link>('connecting')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderFailed, setOlderFailed] = useState(false)
  const lifetime = useRef<AbortSignal | null>(null)
  const callbacks = useRef({ onUnauthorized, onArrival })
  callbacks.current = { onUnauthorized, onArrival }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller.signal
    setState(EMPTY_FEED)
    setLink('connecting')
    void followFeed(
      source,
      {
        update: setState,
        link: setLink,
        arrival: (receipt) => callbacks.current.onArrival?.(receipt),
        unauthorized: () => callbacks.current.onUnauthorized?.(),
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [source])

  const loadOlder = useCallback(() => {
    const signal = lifetime.current
    const cursor = state.nextCursor
    if (signal === null || cursor === null) return
    setLoadingOlder(true)
    setOlderFailed(false)
    source
      .receipts(cursor, signal)
      .then(
        (page) => setState((previous) => withOlder(previous, cursor, page)),
        (error: unknown) => {
          if (signal.aborted) return
          if (error instanceof ApiError && error.status === 401) {
            callbacks.current.onUnauthorized?.()
            return
          }
          setOlderFailed(true)
        },
      )
      .finally(() => setLoadingOlder(false))
  }, [source, state.nextCursor])

  return { state, link, loadingOlder, olderFailed, loadOlder }
}

function LinkStatus({ link }: { link: Link }) {
  if (link === 'connecting') return null
  return (
    <span role="status">
      <SmallCaps muted>{link === 'live' ? 'live' : 'reconnecting'}</SmallCaps>
    </span>
  )
}

function Quiet({ children }: { children: string }) {
  return (
    <p className="serif mt-6" style={{ color: COLOR.muted, fontSize: 16, lineHeight: 1.5 }}>
      {children}
    </p>
  )
}

function standingLabel(standing: Standing): string {
  if (standing.kind === 'accrued') return 'accrued'
  return 'settled'
}

function standingDetail(standing: Standing, today: string): string | null {
  if (standing.kind === 'accrued') return null
  const how = standing.via === 'batch' ? 'in batch' : 'per request'
  return `${how} ${clockLabel(standing.at, today)}`
}

function Row({
  row,
  today,
  narrow,
  onOpen,
}: {
  row: FeedRow
  today: string
  narrow: boolean
  onOpen: (() => void) | undefined
}) {
  const [lifted, setLifted] = useState(false)
  const consumer = truncateMiddle(row.consumer, 13)
  const work = workPath(row.sourceId)
  const time = clockLabel(row.acceptedAt, today)
  const standing = standingOf(row)
  const label = standingLabel(standing)
  const detail = standingDetail(standing, today)
  const title = standing.kind === 'settled' ? `Settled ${standing.at}` : 'Accrued, not yet settled'

  const common = {
    className: row.arrived ? 'row-enter' : undefined,
    style: {
      borderBottom: `1px solid ${COLOR.hairline}`,
      background: lifted ? COLOR.lifted : 'transparent',
      cursor: onOpen ? 'pointer' : 'default',
    } as CSSProperties,
    onMouseEnter: () => setLifted(true),
    onMouseLeave: () => setLifted(false),
    ...(onOpen && {
      role: 'button' as const,
      tabIndex: 0,
      onClick: onOpen,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          onOpen()
        }
      },
      onFocus: () => setLifted(true),
      onBlur: () => setLifted(false),
    }),
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
          <div className="flex items-baseline justify-between gap-3">
            <span
              className="serif min-w-0 truncate"
              style={{ color: COLOR.muted, fontSize: 14, lineHeight: 1.4 }}
            >
              {work}
            </span>
            {detail !== null && (
              <span
                className="fig whitespace-nowrap"
                style={{ fontSize: 12, color: COLOR.muted }}
                title={title}
              >
                {detail}
              </span>
            )}
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-baseline gap-3">
              <span className="fig" style={{ fontSize: 13, color: COLOR.muted }}>
                {time}
              </span>
              <SmallCaps>{row.useType}</SmallCaps>
            </span>
            <span title={title}>
              <SmallCaps muted>{label}</SmallCaps>
            </span>
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
          gridTemplateColumns: '96px 168px minmax(0,1fr) 92px 150px 136px',
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
        <span
          title={title}
          className="flex flex-col items-end"
          style={{ textAlign: 'right', lineHeight: 1.2 }}
        >
          <SmallCaps muted>{label}</SmallCaps>
          {detail !== null && (
            <span className="fig" style={{ fontSize: 12, color: COLOR.muted }}>
              {detail}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
