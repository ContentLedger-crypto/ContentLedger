import { describe, expect, it } from 'vitest'
import { clockLabel, formatUsdc, instantLabel, shareOf, truncateMiddle, workPath } from './format'

describe('formatUsdc', () => {
  it('names the currency after the shared six-decimal form', () => {
    expect(formatUsdc(4_246_900n)).toBe('4.246900 USDC')
    expect(formatUsdc(0n)).toBe('0.000000 USDC')
  })
})

describe('shareOf', () => {
  it('rounds to hundredths of a percent, half up', () => {
    expect(shareOf(1_460_000n, 4_246_900n)).toBe('34.38%')
    expect(shareOf(369_000n, 4_246_900n)).toBe('8.69%')
    expect(shareOf(1n, 8n)).toBe('12.50%')
    expect(shareOf(1n, 80_000n)).toBe('0.00%')
    expect(shareOf(1n, 20_000n)).toBe('0.01%')
  })

  it('gives the whole and nothing exactly', () => {
    expect(shareOf(905n, 905n)).toBe('100.00%')
    expect(shareOf(0n, 905n)).toBe('0.00%')
  })

  it('has no share of an empty period instead of dividing by zero', () => {
    expect(shareOf(0n, 0n)).toBeNull()
  })
})

describe('clockLabel', () => {
  it('reads the UTC clock time off an instant served today', () => {
    expect(clockLabel('2026-09-03T14:52:11.000Z', '2026-09-03')).toBe('14:52:11')
  })

  it('names the day of an earlier instant, to the minute', () => {
    expect(clockLabel('2026-09-03T14:52:11.000Z', '2026-09-04')).toBe('3 Sep 14:52')
    expect(clockLabel('2025-12-31T23:59:59.000Z', '2026-01-01')).toBe('31 Dec 23:59')
  })
})

describe('instantLabel', () => {
  it('spells out the UTC day and time to the second', () => {
    expect(instantLabel('2026-09-03T14:50:41.000Z')).toBe('3 Sep 2026, 14:50:41 UTC')
    expect(instantLabel('2025-12-31T23:59:59.999Z')).toBe('31 Dec 2025, 23:59:59 UTC')
  })
})

describe('workPath', () => {
  it('shows a work by the path of its canonical URL', () => {
    expect(workPath('https://atlasquarterly.org/2026/04/salt-line')).toBe('/2026/04/salt-line')
  })

  it('keeps a query, which is part of what identifies the work', () => {
    expect(workPath('https://example.com/a?id=7')).toBe('/a?id=7')
  })

  it('falls back to the identifier as served when it is not a URL', () => {
    expect(workPath('not a url')).toBe('not a url')
  })
})

describe('truncateMiddle', () => {
  it('keeps both ends of an address', () => {
    expect(truncateMiddle('Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T', 13)).toBe('Kzb7q9…vbuQ2T')
  })

  it('leaves a short value alone', () => {
    expect(truncateMiddle('W1', 13)).toBe('W1')
  })
})
