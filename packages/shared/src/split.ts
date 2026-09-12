import { MAX_USDC_BASE_UNITS } from './money.js'

const BPS_DENOMINATOR = 10_000n
const MAX_BPS = 10_000

export interface SplitTerms {
  readonly tariff: bigint
  /** Комісія протоколу — **понад** тариф: її платить агент (`FR-017`). */
  readonly feeBps: number
  /** Частка вузла — **всередині** тарифу: це витрата видавця (`FR-017b`). */
  readonly nodeShareBps: number
}

export interface PaymentSplit {
  readonly tariff: bigint
  readonly fee: bigint
  readonly nodeCut: bigint
  readonly publisher: bigint
  readonly total: bigint
}

export interface SplitTotals {
  readonly publisher: bigint
  readonly nodeCut: bigint
  readonly fee: bigint
  readonly total: bigint
}

/**
 * `FR-015a`: комісія вгору, частка вузла вниз, а виплата видавцю береться
 * **відніманням**, а не другим множенням — тоді залишок від округлення не
 * зникає й не подвоюється за побудовою, і жодна сторона не виграє долю
 * базової одиниці на арифметиці.
 */
export function splitPayment({ tariff, feeBps, nodeShareBps }: SplitTerms): PaymentSplit {
  requireAmount(tariff, 'tariff')
  requireBps(feeBps, 'feeBps')
  requireBps(nodeShareBps, 'nodeShareBps')

  const fee = divideUp(tariff * BigInt(feeBps), BPS_DENOMINATOR)
  const nodeCut = (tariff * BigInt(nodeShareBps)) / BPS_DENOMINATOR
  const total = tariff + fee
  requireAmount(total, 'total')

  return { tariff, fee, nodeCut, publisher: tariff - nodeCut, total }
}

/**
 * Округлення живе на рівні окремої видачі, бо `fee` входить у підписане тіло
 * квитанції — звести батч і поділити один раз означало б інші суми, ніж ті,
 * під якими стоїть підпис агента.
 */
export function sumSplits(splits: readonly PaymentSplit[]): SplitTotals {
  return splits.reduce<SplitTotals>(
    (totals, split) => ({
      publisher: totals.publisher + split.publisher,
      nodeCut: totals.nodeCut + split.nodeCut,
      fee: totals.fee + split.fee,
      total: totals.total + split.total,
    }),
    { publisher: 0n, nodeCut: 0n, fee: 0n, total: 0n },
  )
}

const divideUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator

function requireAmount(value: bigint, name: string): void {
  if (value < 0n || value > MAX_USDC_BASE_UNITS) {
    throw new RangeError(`${name} does not fit in u64 base units: ${value}`)
  }
}

function requireBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_BPS) {
    throw new RangeError(`${name} must be an integer between 0 and ${MAX_BPS}, got ${value}`)
  }
}
