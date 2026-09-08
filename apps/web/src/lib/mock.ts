/**
 * ContentLedger — single source of truth.
 * Every value rendered anywhere in this app comes from this module.
 * Nothing here is fetched, computed at random, or derived from the clock.
 */

export type Use = 'train' | 'inference'
export type PayMethod = 'escrow' | 'per request'
export type PayoutState = 'SETTLED' | 'ACCRUED' | 'PAID'
export type RateSource = 'domain' | 'work'
export type Media = 'text' | 'csv' | 'image'

/* ------------------------------------------------------------------ money */

/** USDC has 6 decimals. All amounts in this module are integer base units. */
export const USDC_DECIMALS = 6

/** 4246900n -> "4.246900 USDC". Always six decimals, always the suffix. */
export function formatUsdc(baseUnits: bigint): string {
  const negative = baseUnits < 0n
  const abs = negative ? -baseUnits : baseUnits
  const whole = abs / 1_000_000n
  const frac = abs % 1_000_000n
  const fracText = frac.toString().padStart(6, '0')
  return `${negative ? '-' : ''}${whole}.${fracText} USDC`
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

/* -------------------------------------------------------------- publisher */

export interface Publisher {
  readonly name: string
  readonly domain: string
  readonly payoutWallet: string
  readonly domainRateTrain: bigint
  readonly domainRateInference: bigint
}

export const PUBLISHER: Publisher = {
  name: 'Atlas Quarterly',
  domain: 'atlasquarterly.org',
  payoutWallet: 'PZRKRfN3hMWycz7RYXviNcFz68PFQ4ocQkBB3W9dYenc',
  domainRateTrain: 2000n,
  domainRateInference: 500n,
}

export const TODAY = '3 September 2026'
export const PERIOD_LABEL = '28 August – 3 September 2026'

/* ------------------------------------------------------------------ works */

export interface Work {
  readonly id: string
  readonly title: string
  /** Shortened form used only inside the flow map, where space is fixed. */
  readonly mapLabel: string
  readonly path: string
  readonly media: Media
  readonly rateTrain: bigint
  readonly rateInference: bigint
  readonly rateSource: RateSource
  readonly registeredHash: string
  readonly servedHash: string
  readonly hashMatches: boolean
}

export const WORKS: readonly Work[] = [
  {
    id: 'W1',
    title: 'The Salt Line: field notes from the Aral basin',
    mapLabel: 'The Salt Line',
    path: '/2026/04/salt-line',
    media: 'text',
    rateTrain: 2000n,
    rateInference: 500n,
    rateSource: 'domain',
    registeredHash: 'bd4fc50240c281804fab6e470b98483e4b1c6d73e228c13474a81485128e127b',
    servedHash: 'bd4fc50240c281804fab6e470b98483e4b1c6d73e228c13474a81485128e127b',
    hashMatches: true,
  },
  {
    id: 'W2',
    title: 'Forty years of tide gauges',
    mapLabel: 'Forty years of tide gauges',
    path: '/2026/03/tide-gauges',
    media: 'text',
    rateTrain: 3500n,
    rateInference: 905n,
    rateSource: 'work',
    registeredHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
    servedHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
    hashMatches: true,
  },
  {
    id: 'W3',
    title: 'Sediment cores, 1961–2019',
    mapLabel: 'Sediment cores, 1961–2019',
    path: '/data/sediment-cores',
    media: 'csv',
    rateTrain: 12000n,
    rateInference: 2000n,
    rateSource: 'work',
    registeredHash: '4d82dddea0e15271ca4b7dffdabc9ae9340339284c8a3ca189525dc9732892dd',
    servedHash: '4d82dddea0e15271ca4b7dffdabc9ae9340339284c8a3ca189525dc9732892dd',
    hashMatches: true,
  },
  {
    id: 'W4',
    title: 'The dry port',
    mapLabel: 'The dry port',
    path: '/2026/02/dry-port',
    media: 'image',
    rateTrain: 6000n,
    rateInference: 1500n,
    rateSource: 'work',
    registeredHash: 'a6957693417d99daaccb7dc37103dd2f677c8180ec0c76a67ece2f26a0450dab',
    servedHash: '9350e6a715d54ee9962de7aeab04cd0f2ddfc796675da25e09969de8e952c129',
    hashMatches: false,
  },
  {
    id: 'W5',
    title: 'Expedition logs, 1974',
    mapLabel: 'Expedition logs, 1974',
    path: '/archive/1974-logs',
    media: 'text',
    rateTrain: 2000n,
    rateInference: 500n,
    rateSource: 'domain',
    registeredHash: '05f68b6befe9fa1dea99e4f823a4883392009fe42b2793eb00738320a77ccb78',
    servedHash: '05f68b6befe9fa1dea99e4f823a4883392009fe42b2793eb00738320a77ccb78',
    hashMatches: true,
  },
]

export const WORK_BY_ID: Readonly<Record<string, Work>> = WORKS.reduce<Record<string, Work>>(
  (acc, w) => {
    acc[w.id] = w
    return acc
  },
  {},
)

/** The one sentence attached to the one unverified work. */
export const UNVERIFIED_SENTENCE =
  'Content changed since it was registered. The payment stands; the work is unverified until it is attested again.'

/* -------------------------------------------------------------- consumers */

export interface Consumer {
  readonly id: string
  readonly name: string
  readonly wallet: string
  readonly paysBy: PayMethod
}

export const CONSUMERS: readonly Consumer[] = [
  {
    id: 'corvid',
    name: 'Corvid Labs',
    wallet: 'WfzXVJ34K3EdMXKDD3GWVyvMAv55PtmkULMTHD4V8e3G',
    paysBy: 'escrow',
  },
  {
    id: 'meridian',
    name: 'Meridian AI',
    wallet: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
    paysBy: 'escrow',
  },
  {
    id: 'pallas',
    name: 'Pallas Research',
    wallet: 'ECHVGPW27FXB8HkaPX7Rb9rX1oY4JnxJcGSicVJtCPDB',
    paysBy: 'escrow',
  },
  {
    id: 'halcyon',
    name: 'Halcyon Systems',
    wallet: 'kR8aexnLNwSAHA95hZ2XpBMyefMQYD16Dyp3WKtnGziM',
    paysBy: 'per request',
  },
]

export const CONSUMER_BY_ID: Readonly<Record<string, Consumer>> = CONSUMERS.reduce<
  Record<string, Consumer>
>((acc, c) => {
  acc[c.id] = c
  return acc
}, {})

/* ------------------------------------------------------------------ edges */

export interface Edge {
  readonly id: string
  readonly consumerId: string
  readonly workId: string
  readonly use: Use
  readonly requests: number
  readonly amount: bigint
}

const edge = (
  consumerId: string,
  workId: string,
  use: Use,
  requests: number,
  amount: bigint,
): Edge => ({
  id: `${consumerId}~${workId}`,
  consumerId,
  workId,
  use,
  requests,
  amount,
})

export const EDGES: readonly Edge[] = [
  edge('corvid', 'W1', 'train', 420, 840000n),
  edge('corvid', 'W3', 'train', 60, 720000n),
  edge('corvid', 'W5', 'train', 310, 620000n),
  edge('meridian', 'W1', 'inference', 1240, 620000n),
  edge('meridian', 'W2', 'inference', 380, 343900n),
  edge('meridian', 'W4', 'inference', 150, 225000n),
  edge('pallas', 'W3', 'train', 12, 144000n),
  edge('pallas', 'W5', 'inference', 900, 450000n),
  edge('halcyon', 'W2', 'train', 40, 140000n),
  edge('halcyon', 'W4', 'train', 24, 144000n),
]

export const LARGEST_EDGE_AMOUNT = 840000n

export function edgeId(consumerId: string, workId: string): string {
  return `${consumerId}~${workId}`
}

/* ----------------------------------------------------------------- totals */

export interface ConsumerTotal {
  readonly consumerId: string
  readonly requests: number
  readonly amount: bigint
}

/** Descending by amount. */
export const CONSUMER_TOTALS: readonly ConsumerTotal[] = [
  { consumerId: 'corvid', requests: 790, amount: 2180000n },
  { consumerId: 'meridian', requests: 1770, amount: 1188900n },
  { consumerId: 'pallas', requests: 912, amount: 594000n },
  { consumerId: 'halcyon', requests: 64, amount: 284000n },
]

export interface WorkTotal {
  readonly workId: string
  readonly requests: number
  readonly amount: bigint
  /** Pre-rounded, given. Never summed. */
  readonly share: string
}

/** Descending by amount. */
export const WORK_TOTALS: readonly WorkTotal[] = [
  { workId: 'W1', requests: 1660, amount: 1460000n, share: '34.38%' },
  { workId: 'W5', requests: 1210, amount: 1070000n, share: '25.19%' },
  { workId: 'W3', requests: 72, amount: 864000n, share: '20.34%' },
  { workId: 'W2', requests: 420, amount: 483900n, share: '11.39%' },
  { workId: 'W4', requests: 174, amount: 369000n, share: '8.69%' },
]

export const PERIOD_REQUESTS = 3536
export const PERIOD_RECEIVED = 4246900n
export const PERIOD_PAID_BY_AGENTS = 4671780n
export const PERIOD_PROTOCOL_FEE = 424880n

export const SETTLEMENT = {
  settled: 3907900n,
  accrued: 55000n,
  paidPerRequest: 284000n,
} as const

/* ----------------------------------------------------------------- stream */

export interface StreamRow {
  readonly id: string
  readonly time: string
  readonly consumerId: string
  readonly workId: string
  readonly use: Use
  readonly amount: bigint
  readonly state: PayoutState
}

/** Newest first, exactly as given. */
export const STREAM_INITIAL: readonly StreamRow[] = [
  {
    id: 's01',
    time: '14:52:11',
    consumerId: 'meridian',
    workId: 'W1',
    use: 'inference',
    amount: 500n,
    state: 'ACCRUED',
  },
  {
    id: 's02',
    time: '14:52:07',
    consumerId: 'corvid',
    workId: 'W5',
    use: 'train',
    amount: 2000n,
    state: 'ACCRUED',
  },
  {
    id: 's03',
    time: '14:51:58',
    consumerId: 'meridian',
    workId: 'W1',
    use: 'inference',
    amount: 500n,
    state: 'ACCRUED',
  },
  {
    id: 's04',
    time: '14:51:44',
    consumerId: 'pallas',
    workId: 'W5',
    use: 'inference',
    amount: 500n,
    state: 'ACCRUED',
  },
  {
    id: 's05',
    time: '14:51:30',
    consumerId: 'halcyon',
    workId: 'W2',
    use: 'train',
    amount: 3500n,
    state: 'PAID',
  },
  {
    id: 's06',
    time: '14:51:12',
    consumerId: 'corvid',
    workId: 'W3',
    use: 'train',
    amount: 12000n,
    state: 'ACCRUED',
  },
  {
    id: 's07',
    time: '14:50:55',
    consumerId: 'meridian',
    workId: 'W4',
    use: 'inference',
    amount: 1500n,
    state: 'SETTLED',
  },
  {
    id: 's08',
    time: '14:50:41',
    consumerId: 'meridian',
    workId: 'W2',
    use: 'inference',
    amount: 905n,
    state: 'SETTLED',
  },
  {
    id: 's09',
    time: '14:50:22',
    consumerId: 'corvid',
    workId: 'W1',
    use: 'train',
    amount: 2000n,
    state: 'SETTLED',
  },
  {
    id: 's10',
    time: '14:50:03',
    consumerId: 'pallas',
    workId: 'W3',
    use: 'train',
    amount: 12000n,
    state: 'SETTLED',
  },
  {
    id: 's11',
    time: '14:49:47',
    consumerId: 'halcyon',
    workId: 'W4',
    use: 'train',
    amount: 6000n,
    state: 'PAID',
  },
  {
    id: 's12',
    time: '14:49:26',
    consumerId: 'meridian',
    workId: 'W1',
    use: 'inference',
    amount: 500n,
    state: 'SETTLED',
  },
]

/** Six arrivals, one every four seconds after mount. Then it stops for good. */
export const STREAM_INCOMING: readonly StreamRow[] = [
  {
    id: 'a01',
    time: '14:52:15',
    consumerId: 'meridian',
    workId: 'W2',
    use: 'inference',
    amount: 905n,
    state: 'ACCRUED',
  },
  {
    id: 'a02',
    time: '14:52:19',
    consumerId: 'corvid',
    workId: 'W1',
    use: 'train',
    amount: 2000n,
    state: 'ACCRUED',
  },
  {
    id: 'a03',
    time: '14:52:23',
    consumerId: 'halcyon',
    workId: 'W4',
    use: 'train',
    amount: 6000n,
    state: 'PAID',
  },
  {
    id: 'a04',
    time: '14:52:27',
    consumerId: 'pallas',
    workId: 'W5',
    use: 'inference',
    amount: 500n,
    state: 'ACCRUED',
  },
  {
    id: 'a05',
    time: '14:52:31',
    consumerId: 'meridian',
    workId: 'W1',
    use: 'inference',
    amount: 500n,
    state: 'ACCRUED',
  },
  {
    id: 'a06',
    time: '14:52:35',
    consumerId: 'corvid',
    workId: 'W3',
    use: 'train',
    amount: 12000n,
    state: 'ACCRUED',
  },
]

export const STREAM_INTERVAL_MS = 4000
export const ROW_ENTER_MS = 240
export const EDGE_FLASH_MS = 600

/* ---------------------------------------------------------------- receipt */

export interface Receipt {
  readonly id: string
  readonly issuedAt: string
  readonly consumerId: string
  readonly workId: string
  readonly source: string
  readonly use: Use
  readonly rateSourceLabel: string
  readonly yourRate: bigint
  readonly protocolFee: bigint
  readonly agentPaid: bigint
  readonly youReceive: bigint
  readonly registeredHash: string
  readonly servedHash: string
  readonly match: string
  readonly method: PayMethod
  readonly escrowAccount: string
  readonly voucherSequence: string
  readonly runningBefore: bigint
  readonly runningAfter: bigint
  readonly batchFrom: string
  readonly batchTo: string
  readonly batchCount: number
  readonly merkleRoot: string
  readonly voucherChain: string
  readonly transaction: string
  readonly settledAt: string
}

export const RECEIPT: Receipt = {
  id: 'rc_2b8febf3f2cc3b7b',
  issuedAt: '3 September 2026, 14:50:41 UTC',
  consumerId: 'meridian',
  workId: 'W2',
  source: 'atlasquarterly.org/2026/03/tide-gauges',
  use: 'inference',
  rateSourceLabel: 'set on this work',
  yourRate: 905n,
  protocolFee: 91n,
  agentPaid: 996n,
  youReceive: 905n,
  registeredHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
  servedHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
  match: 'yes',
  method: 'escrow',
  escrowAccount: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
  voucherSequence: '1742',
  runningBefore: 1236504n,
  runningAfter: 1237500n,
  batchFrom: '1701',
  batchTo: '1742',
  batchCount: 42,
  merkleRoot: '2b8febf3f2cc3b7bcde03d97f17f1c30f3e97d4674b3623c2eb4111ff48416da',
  voucherChain: 'baf3324d17be332cd5eefa21d8235b00c0151d46a86cf1995b04444dbf7f7d1c',
  transaction:
    'U7kAUVNnP6cCjvyAV9P9i6PqJcmnrHZeP8hmrFhvnXS27F3awFVYB2Acx8FfKUTDAaK9JCEycor6BzmZmxEdrwL7',
  settledAt: '3 September 2026, 14:51:00 UTC',
}

/** The edge this receipt belongs to — the one edge Screen 3 leaves lit. */
export const RECEIPT_EDGE_ID = edgeId(RECEIPT.consumerId, RECEIPT.workId)

export interface VerifyStep {
  readonly n: number
  readonly text: string
  readonly value: string | null
}

export const VERIFY_STEPS: readonly VerifyStep[] = [
  { n: 1, text: 'Read the batch root from the chain', value: '2b8febf3…f48416da' },
  { n: 2, text: 'Prove this receipt is in that batch — inclusion path, 6 steps', value: null },
  { n: 3, text: 'Recompute the voucher chain across the whole batch', value: 'baf3324d…bf7f7d1c' },
  { n: 4, text: 'Check the sum charged matches the batch', value: '0.041832 USDC' },
]

export const INCLUSION_PATH: readonly string[] = [
  '84cf0501f86a94c50718204d966badc623ff87330f3a5cf2159be9c323a9aad7',
  '416e9cbef1f49405c80486dcf90c065e9d11ec7aad6d94bf5013432b05412106',
  '3cd51ef618af9f1c982a36461afa3d71e8e48c016860d3c4a2dcddadd9be057c',
  '323417c207ed47584afe3477184d695e2938865339ba03d10089bd1fe8eaae2c',
  'bd4fc50240c281804fab6e470b98483e4b1c6d73e228c13474a81485128e127b',
  'a6957693417d99daaccb7dc37103dd2f677c8180ec0c76a67ece2f26a0450dab',
]

export const LEDGER_PROSE =
  'Over the last seven days, four AI systems took 3,536 pieces of Atlas Quarterly.'
export const FEE_PROSE =
  'The fee is charged on top of the rate you set. You receive the rate you set, exactly.'
export const ACCRUAL_PROSE = 'Accrued takings are paid out in the next batch, about once a minute.'
export const RECEIPT_FEE_PROSE =
  'The fee is 10% of the rate, rounded up to the smallest unit, and is added on top. Rounding never comes out of your share.'
export const VERIFY_PROSE =
  'Step 2 alone is not enough — a batch invented from nothing can be internally consistent. Step 3 is what makes it impossible.'

/* ------------------------------------------------------------------ theme */

export const COLOR = {
  ground: '#101317',
  lifted: '#151A20',
  ink: '#E8E3D9',
  muted: '#8A9099',
  hairline: '#232830',
  sage: '#8FB3A3',
  terracotta: '#C4795F',
} as const
