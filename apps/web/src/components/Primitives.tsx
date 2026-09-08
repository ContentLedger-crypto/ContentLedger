import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { COLOR, truncateMiddle } from '@/lib/mock'

export function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1100px] px-5 md:px-10">{children}</div>
}

export function Section({ children, ruled = false }: { children: ReactNode; ruled?: boolean }) {
  return (
    <section
      className="py-[36px] md:py-[56px]"
      style={ruled ? { borderTop: `1px solid ${COLOR.hairline}` } : undefined}
    >
      {children}
    </section>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <span style={{ color: COLOR.muted }}>{children}</span>
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="serif" style={{ color: COLOR.muted, fontSize: 14, lineHeight: 1.4 }}>
      {children}
    </div>
  )
}

export function Figure({
  value,
  size = 28,
  align = 'right',
}: {
  value: string
  size?: number
  align?: 'right' | 'left'
}) {
  return (
    <div className="fig" style={{ fontSize: size, textAlign: align, lineHeight: 1.3 }}>
      {value}
    </div>
  )
}

export function SmallCaps({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <span className="smallcaps" style={{ color: muted ? COLOR.muted : COLOR.ink, fontSize: 15 }}>
      {children.toLowerCase()}
    </span>
  )
}

/**
 * A label/value line for the receipt. Hashes, addresses and signatures are set
 * in the mono, truncated in the middle when they do not fit, and carry a copy
 * affordance that reports back in muted ink for two seconds.
 */
export function Line({
  label,
  value,
  mono = false,
  copyable = false,
  fullValue,
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
  fullValue?: string
}) {
  const narrow = useIsNarrow()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const source = fullValue ?? value
  const shown = mono ? truncateMiddle(value, narrow ? 20 : 64) : value

  const copy = () => {
    const clipboard = navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      void clipboard.writeText(source)
    }
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col gap-1 py-[10px] md:flex-row md:items-baseline md:justify-between md:gap-8">
      <div className="serif shrink-0" style={{ color: COLOR.muted, fontSize: 15 }}>
        {label}
      </div>
      <div className="flex min-w-0 items-baseline justify-start gap-3 md:justify-end">
        <span
          className={mono ? 'mono' : 'fig'}
          style={{
            color: COLOR.ink,
            fontSize: mono ? 12 : 15,
            wordBreak: mono ? 'break-all' : 'normal',
            textAlign: 'right',
          }}
        >
          {shown}
        </span>
        {copyable && (
          <button
            type="button"
            onClick={copy}
            className="serif shrink-0"
            style={{
              color: copied ? COLOR.muted : COLOR.ink,
              fontSize: 13,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              opacity: copied ? 1 : 0.6,
              transition: 'opacity 160ms ease',
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        )}
      </div>
    </div>
  )
}

/** The one terracotta mark in the app. Nothing else may use this colour. */
export function UnverifiedMark({ sentence }: { sentence: string }) {
  return (
    <span
      className="serif"
      style={{ color: COLOR.terracotta, fontSize: 13.5, lineHeight: 1.5 }}
      title={sentence}
    >
      <span style={{ letterSpacing: '0.06em' }}>unverified</span>
      <span className="hidden md:inline"> — {sentence}</span>
    </span>
  )
}
