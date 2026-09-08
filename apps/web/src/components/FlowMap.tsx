import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import {
  COLOR,
  CONSUMER_BY_ID,
  CONSUMER_TOTALS,
  EDGE_FLASH_MS,
  EDGES,
  LARGEST_EDGE_AMOUNT,
  WORK_BY_ID,
  WORK_TOTALS,
} from '@/lib/mock'

export interface EdgeFlash {
  readonly edgeId: string
  readonly seq: number
}

interface FlowMapProps {
  /** When set, that one edge is drawn at 0.9 and every other edge at 0.06. */
  readonly soloEdgeId?: string
  /** A momentary brightening of one edge, 600ms, then back to rest. */
  readonly flash?: EdgeFlash | null
  readonly title?: string
}

interface PlacedNode {
  readonly id: string
  readonly label: string
  readonly barStart: number
  readonly barEnd: number
  readonly y: number
  readonly side: 'left' | 'right'
}

export function FlowMap({ soloEdgeId, flash = null, title = 'Flow of payments' }: FlowMapProps) {
  const narrow = useIsNarrow()
  const [hovered, setHovered] = useState<string | null>(null)
  const [flashedEdge, setFlashedEdge] = useState<string | null>(null)

  const flashSeq = flash?.seq ?? null
  const flashId = flash?.edgeId ?? null

  useEffect(() => {
    if (flashId === null || flashSeq === null) return
    setFlashedEdge(flashId)
    const timer = window.setTimeout(() => setFlashedEdge(null), EDGE_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [flashId, flashSeq])

  const geometry = useMemo(() => {
    /* Narrow keeps the shape but works in its own coordinate space, so the
           band still reads at 220px tall instead of shrinking to a sliver. */
    const viewW = narrow ? 375 : 1100
    const height = narrow ? 220 : 320
    const pad = narrow ? 20 : 32
    const leftBarX = narrow ? 8 : 250
    const maxLen = narrow ? 118 : 220
    const rightBarX = narrow ? 252 : 630
    const barH = narrow ? 8 : 10
    const usable = height - pad * 2

    /* Geometry is fractions of a pixel, so amounts cross into Number here
           and only here — every stored amount stays an integer base unit. */
    const maxConsumer = CONSUMER_TOTALS.reduce((m, t) => Math.max(m, Number(t.amount)), 1)
    const maxWork = WORK_TOTALS.reduce((m, t) => Math.max(m, Number(t.amount)), 1)

    const consumerNodes: PlacedNode[] = CONSUMER_TOTALS.map((total, index) => {
      const consumer = CONSUMER_BY_ID[total.consumerId]
      const len = Math.max(12, (Number(total.amount) / maxConsumer) * maxLen)
      return {
        id: `c:${total.consumerId}`,
        label: consumer ? consumer.name : total.consumerId,
        barStart: leftBarX,
        barEnd: leftBarX + len,
        y: pad + ((index + 0.5) * usable) / CONSUMER_TOTALS.length,
        side: 'left',
      }
    })

    const workNodes: PlacedNode[] = WORK_TOTALS.map((total, index) => {
      const work = WORK_BY_ID[total.workId]
      const len = Math.max(12, (Number(total.amount) / maxWork) * maxLen)
      return {
        id: `w:${total.workId}`,
        label: work ? work.mapLabel : total.workId,
        barStart: rightBarX,
        barEnd: rightBarX + len,
        y: pad + ((index + 0.5) * usable) / WORK_TOTALS.length,
        side: 'right',
      }
    })

    return { viewW, height, barH, rightBarX, consumerNodes, workNodes }
  }, [narrow])

  const nodeY = useMemo(() => {
    const map: Record<string, number> = {}
    for (const node of geometry.consumerNodes) map[node.id] = node.y
    for (const node of geometry.workNodes) map[node.id] = node.y
    return map
  }, [geometry])

  const nodeEnd = useMemo(() => {
    const map: Record<string, number> = {}
    for (const node of geometry.consumerNodes) map[node.id] = node.barEnd
    return map
  }, [geometry])

  const dx = narrow ? 46 : 110

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${geometry.viewW} ${geometry.height}`}
        width="100%"
        height={narrow ? undefined : geometry.height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={title}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g>
          {EDGES.map((item) => {
            const cId = `c:${item.consumerId}`
            const wId = `w:${item.workId}`
            const y1 = nodeY[cId]
            const y2 = nodeY[wId]
            const x1 = nodeEnd[cId]
            if (y1 === undefined || y2 === undefined || x1 === undefined) return null
            const x2 = geometry.rightBarX

            const weight = Number(item.amount) / Number(LARGEST_EDGE_AMOUNT)
            const width = 1 + 7 * weight
            const rest = 0.22 + 0.38 * weight

            let opacity = rest
            if (soloEdgeId !== undefined) {
              opacity = item.id === soloEdgeId ? 0.9 : 0.06
            } else if (hovered !== null) {
              opacity = hovered === cId || hovered === wId ? 0.85 : 0.08
            }
            if (flashedEdge === item.id) opacity = 0.9

            const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`

            return (
              <path
                key={item.id}
                d={d}
                fill="none"
                stroke={COLOR.sage}
                strokeWidth={width}
                strokeOpacity={opacity}
                strokeLinecap="round"
                style={{ transition: 'stroke-opacity 160ms ease' }}
              />
            )
          })}
        </g>

        <g>
          {[...geometry.consumerNodes, ...geometry.workNodes].map((node) => {
            const isDim = soloEdgeId === undefined && hovered !== null && hovered !== node.id
            const labelX = node.side === 'left' ? node.barStart - 14 : node.barEnd + 14
            return (
              /* Deliberately not focusable and not a button: hovering a node only
                 emphasises edges already listed in the tables below, so there is
                 nothing here for a keyboard to activate. */
              <g
                key={node.id}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x={node.barStart - 6}
                  y={node.y - 18}
                  width={node.barEnd - node.barStart + 12}
                  height={36}
                  fill="transparent"
                />
                <rect
                  x={node.barStart}
                  y={node.y - geometry.barH / 2}
                  width={node.barEnd - node.barStart}
                  height={geometry.barH}
                  fill={COLOR.ink}
                  fillOpacity={isDim ? 0.28 : 0.72}
                  style={{ transition: 'fill-opacity 160ms ease' }}
                />
                {!narrow && (
                  <text
                    x={labelX}
                    y={node.y + 5}
                    textAnchor={node.side === 'left' ? 'end' : 'start'}
                    fill={COLOR.ink}
                    fillOpacity={isDim ? 0.4 : 0.9}
                    style={{
                      fontFamily:
                        '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
                      fontSize: 15,
                      transition: 'fill-opacity 160ms ease',
                    }}
                  >
                    {node.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

interface MapBandProps {
  readonly children: ReactNode
}

/** The one lifted band in the app: hairline above and below, #151A20 ground. */
export function MapBand({ children }: MapBandProps) {
  return (
    <div
      style={{
        background: COLOR.lifted,
        borderTop: `1px solid ${COLOR.hairline}`,
        borderBottom: `1px solid ${COLOR.hairline}`,
      }}
    >
      <div className="mx-auto w-full max-w-[1100px] px-5 py-[28px] md:px-10 md:py-[40px]">
        {children}
      </div>
    </div>
  )
}
