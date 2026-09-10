import { describe, expect, it } from 'vitest'
import {
  formatUsdc,
  MAX_USDC_BASE_UNITS,
  USDC_DECIMALS,
  usdcAmountSchema,
  useTypeSchema,
} from './money.js'

describe('formatUsdc', () => {
  it('renders base units as a fixed six-decimal string', () => {
    expect(formatUsdc(4_246_900n)).toBe('4.246900')
    expect(formatUsdc(2_200n)).toBe('0.002200')
  })

  it('keeps zero, sub-cent and whole amounts distinguishable', () => {
    expect(formatUsdc(0n)).toBe('0.000000')
    expect(formatUsdc(1n)).toBe('0.000001')
    expect(formatUsdc(999_999n)).toBe('0.999999')
    expect(formatUsdc(1_000_000n)).toBe('1.000000')
  })

  it('does not lose precision at the u64 ceiling', () => {
    expect(formatUsdc(MAX_USDC_BASE_UNITS)).toBe('18446744073709.551615')
  })

  it('rejects negative amounts instead of rendering garbage', () => {
    expect(() => formatUsdc(-1n)).toThrow(RangeError)
  })
})

describe('usdcAmountSchema', () => {
  it('parses canonical base-unit strings into bigint', () => {
    expect(usdcAmountSchema.parse('2200')).toBe(2200n)
    expect(usdcAmountSchema.parse('0')).toBe(0n)
    expect(usdcAmountSchema.parse(MAX_USDC_BASE_UNITS.toString())).toBe(MAX_USDC_BASE_UNITS)
  })

  it('round-trips through the wire form', () => {
    const amount = 4_246_900n
    expect(usdcAmountSchema.parse(amount.toString())).toBe(amount)
  })

  it('rejects anything that is not canonical digits, without throwing', () => {
    for (const input of ['', 'abc', '-1', '1.5', '007', '2 200', ' 2200', '2200 ', '1e6']) {
      expect(usdcAmountSchema.safeParse(input).success, input).toBe(false)
    }
  })

  it('rejects amounts the on-chain u64 cannot hold', () => {
    expect(usdcAmountSchema.safeParse((MAX_USDC_BASE_UNITS + 1n).toString()).success).toBe(false)
  })

  it('rejects non-string input rather than coercing it', () => {
    expect(usdcAmountSchema.safeParse(2200).success).toBe(false)
    expect(usdcAmountSchema.safeParse(2200n).success).toBe(false)
    expect(usdcAmountSchema.safeParse(null).success).toBe(false)
  })
})

describe('useTypeSchema', () => {
  it('accepts both licensed use types', () => {
    expect(useTypeSchema.parse('train')).toBe('train')
    expect(useTypeSchema.parse('inference')).toBe('inference')
  })

  it('rejects near-misses and unknown uses', () => {
    for (const input of ['training', 'Train', 'TRAIN', '', 'browse']) {
      expect(useTypeSchema.safeParse(input).success, input).toBe(false)
    }
  })
})

describe('USDC_DECIMALS', () => {
  it('matches the six decimals USDC-SPL is minted with', () => {
    expect(USDC_DECIMALS).toBe(6)
  })
})
