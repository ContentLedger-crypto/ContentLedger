import { z } from 'zod'

export const USDC_DECIMALS = 6

const BASE_UNITS_PER_USDC = 10n ** BigInt(USDC_DECIMALS)

/** Ончейн-суми живуть у `u64`; більше програма не прийме, тож межа стоїть на вході. */
export const MAX_USDC_BASE_UNITS = 2n ** 64n - 1n

const CANONICAL_BASE_UNITS = /^(0|[1-9][0-9]*)$/

export const usdcAmountSchema = z
  .string()
  .regex(CANONICAL_BASE_UNITS, 'expected USDC base units: digits only, no leading zeros')
  .transform((digits) => BigInt(digits))
  .refine((units) => units <= MAX_USDC_BASE_UNITS, 'amount exceeds u64')

export type UsdcAmount = z.infer<typeof usdcAmountSchema>

export function formatUsdc(baseUnits: bigint): string {
  if (baseUnits < 0n) {
    throw new RangeError(`USDC amounts are never negative, got ${baseUnits}`)
  }
  const whole = baseUnits / BASE_UNITS_PER_USDC
  const frac = baseUnits % BASE_UNITS_PER_USDC
  return `${whole}.${frac.toString().padStart(USDC_DECIMALS, '0')}`
}

export const useTypeSchema = z.enum(['train', 'inference'])

export type UseType = z.infer<typeof useTypeSchema>
