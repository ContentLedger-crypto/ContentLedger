import { formatUsdc as formatBaseUnits } from '@contentledger/shared'

/** 4246900n -> "4.246900 USDC". Always six decimals, always the suffix. */
export function formatUsdc(baseUnits: bigint): string {
  return `${formatBaseUnits(baseUnits)} USDC`
}

/** 3536 -> "3,536" */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** Truncate in the middle, never at the end. */
export function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.ceil((maxChars - 1) / 2)
  const tail = Math.floor((maxChars - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/** Hundredths of a percent, half up; `null` when there is nothing to take a share of. */
export function shareOf(part: bigint, whole: bigint): string | null {
  if (whole === 0n) return null
  const basisPoints = (part * 20_000n + whole) / (2n * whole)
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, '0')}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * UTC clock time for an instant on `today` (`YYYY-MM-DD`), with the day for anything earlier.
 * The gateway serves instants in one fixed ISO form, so each part sits at a fixed offset.
 */
export function clockLabel(instant: string, today: string): string {
  const time = instant.slice(11, 19)
  if (instant.slice(0, 10) === today) return time
  return `${Number(instant.slice(8, 10))} ${MONTHS[Number(instant.slice(5, 7)) - 1]} ${time.slice(0, 5)}`
}

/** The full UTC instant, for a receipt that may be any age. */
export function instantLabel(instant: string): string {
  const day = `${Number(instant.slice(8, 10))} ${MONTHS[Number(instant.slice(5, 7)) - 1]} ${instant.slice(0, 4)}`
  return `${day}, ${instant.slice(11, 19)} UTC`
}

export function workPath(sourceId: string): string {
  try {
    const url = new URL(sourceId)
    return `${url.pathname}${url.search}`
  } catch {
    return sourceId
  }
}
