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

/** The gateway serves instants in one fixed ISO form, so the clock time sits at a fixed offset. */
export function timeOfDay(instant: string): string {
  return instant.slice(11, 19)
}

export function workPath(sourceId: string): string {
  try {
    const url = new URL(sourceId)
    return `${url.pathname}${url.search}`
  } catch {
    return sourceId
  }
}
