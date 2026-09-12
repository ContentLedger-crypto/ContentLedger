import { z } from 'zod'

export const USDC_DECIMALS = 6

const BASE_UNITS_PER_USDC = 10n ** BigInt(USDC_DECIMALS)

/** Ончейн-суми живуть у `u64`; більше програма не прийме, тож межа стоїть на вході. */
export const MAX_USDC_BASE_UNITS = 2n ** 64n - 1n

const CANONICAL_BASE_UNITS = /^(0|[1-9][0-9]*)$/

/**
 * Повторний тест регексом усередині `refine` не зайвий: Zod 4 не спиняється на
 * першій невдалій перевірці, тож без нього `BigInt()` покликався б на
 * нецифровому вводі й перетворив би 400 на 500.
 */
export const usdcBaseUnitsSchema = z
  .string()
  .regex(CANONICAL_BASE_UNITS, 'expected USDC base units: digits only, no leading zeros')
  .refine(
    (digits) => CANONICAL_BASE_UNITS.test(digits) && BigInt(digits) <= MAX_USDC_BASE_UNITS,
    'amount exceeds u64',
  )

export const usdcAmountSchema = usdcBaseUnitsSchema.transform((digits) => BigInt(digits))

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
