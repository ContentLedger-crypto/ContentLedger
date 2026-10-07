import type {
  publisherReceiptSchema,
  publisherSummarySchema,
  receiptBodySchema,
  receiptsPageSchema,
} from '@contentledger/shared'
import type { z } from 'zod'

/**
 * Stand-in for the gateway in the preview. Only `api.ts` imports it.
 * Wire JSON, exactly as `/v1/publisher/*` serves it, and the signed bodies of one batch:
 * `api.ts` hashes those into the receipt, root and path `/v1/receipts/:id` would serve.
 */

type WireReceipt = z.input<typeof publisherReceiptSchema>

export const SESSION_WALLET = 'PZRKRfN3hMWycz7RYXviNcFz68PFQ4ocQkBB3W9dYenc'

const SITE = 'https://atlasquarterly.org'

const WORK = {
  saltLine: 'DRymcLVcbysn4WrGESoKULe3bWRuQg7i7mzPz4175oey',
  tideGauges: '2hDmkNfqjBbCWDLM4XG1Rjp3trPYNuGCSJV25dnaDucT',
  sedimentCores: 'BvwZ6vgUbyKyo6g6x2qVWyaoDzeXWAHaK3mHF6xk1Lro',
  dryPort: 'HgZefttrXPZ2prGbXd9xaXvzRgPhFoeCBc5ufPCh6edX',
  logs1974: '3kwKSmcZxvwAfAiYsyYosvUcExG3SJ2S5dzbGLkK27DZ',
} as const

type WorkKey = keyof typeof WORK

const SOURCE: Readonly<Record<WorkKey, string>> = {
  saltLine: `${SITE}/2026/04/salt-line`,
  tideGauges: `${SITE}/2026/03/tide-gauges`,
  sedimentCores: `${SITE}/data/sediment-cores`,
  dryPort: `${SITE}/2026/02/dry-port`,
  logs1974: `${SITE}/archive/1974-logs`,
}

const AGENT = {
  corvid: 'WfzXVJ34K3EdMXKDD3GWVyvMAv55PtmkULMTHD4V8e3G',
  meridian: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
  pallas: 'ECHVGPW27FXB8HkaPX7Rb9rX1oY4JnxJcGSicVJtCPDB',
  halcyon: 'kR8aexnLNwSAHA95hZ2XpBMyefMQYD16Dyp3WKtnGziM',
} as const

type AgentKey = keyof typeof AGENT

const SETTLED_AT = '2026-09-03T14:51:00.000Z'

const receipt = (
  id: string,
  time: string,
  agent: AgentKey,
  work: WorkKey,
  useType: 'train' | 'inference',
  tariff: string,
  settled: boolean,
): WireReceipt => ({
  id,
  workId: WORK[work],
  sourceId: SOURCE[work],
  consumer: AGENT[agent],
  useType,
  tariff,
  paymentMethod: 'escrow',
  acceptedAt: `2026-09-03T${time}.000Z`,
  settledAt: settled ? SETTLED_AT : null,
})

/** Paid per request (x402): never batched, settled by its own payment, just before it was served. */
const paidDirect = (escrow: WireReceipt): WireReceipt => ({
  ...escrow,
  paymentMethod: 'x402',
  settledAt: escrow.acceptedAt,
})

export const RECEIPTS: z.input<typeof receiptsPageSchema> = {
  items: [
    receipt(
      '94c4cd94a881e614859d866225ceec948c92dbb5811113d3d265b5901405b496',
      '14:52:11',
      'meridian',
      'saltLine',
      'inference',
      '500',
      false,
    ),
    receipt(
      '4b226c3a44560920bc6478977cf902553da64244ba915608a9dc1eddf704ae89',
      '14:52:07',
      'corvid',
      'logs1974',
      'train',
      '2000',
      false,
    ),
    receipt(
      '9686330e0f9d40cd364310e12054cdefe806a64b038d533e28fef9b393551337',
      '14:51:58',
      'meridian',
      'saltLine',
      'inference',
      '500',
      false,
    ),
    paidDirect(
      receipt(
        'f02e88eed9cd67e320b99f268b7089303bb753dc1280f85437d462b871f38d84',
        '14:51:44',
        'pallas',
        'logs1974',
        'inference',
        '500',
        false,
      ),
    ),
    receipt(
      '55ddff20e51b0d1b1ee16414d54a064e4ee3e19424535b24af7c566df60b2454',
      '14:51:30',
      'halcyon',
      'tideGauges',
      'train',
      '3500',
      false,
    ),
    receipt(
      '59d89100b6323a4d449a0be59acd06073f6175ebd680fa28428fb6233e36c322',
      '14:51:12',
      'corvid',
      'sedimentCores',
      'train',
      '12000',
      false,
    ),
    receipt(
      'd213461e0b0309ffe206a0cbc77afaa6ad6bef0d361512e38b03127c8bc278a0',
      '14:50:55',
      'meridian',
      'dryPort',
      'inference',
      '1500',
      true,
    ),
    receipt(
      'f3c564b7d2455de487166eecde3a1571a53a6fba57658386350ae82dad53fd29',
      '14:50:41',
      'meridian',
      'tideGauges',
      'inference',
      '905',
      true,
    ),
    receipt(
      'd6cfbd8445abcf435e342752ac856b7bef0a9b03f4feedc435d8571b14852354',
      '14:50:22',
      'corvid',
      'saltLine',
      'train',
      '2000',
      true,
    ),
    receipt(
      '4391a3923281f92e61f87fefc30ed6364eeb8f1c71172ef98f7e7a244bf65a71',
      '14:50:03',
      'pallas',
      'sedimentCores',
      'train',
      '12000',
      true,
    ),
    receipt(
      '71d72b820691ec26288b9e8008cbcd35eb58ff641fe312af40a90ddd2b69bb1f',
      '14:49:47',
      'halcyon',
      'dryPort',
      'train',
      '6000',
      false,
    ),
    receipt(
      '70d560bc9b61242c05281e3da05eb7f377e91c799e85f3eadb28f7f21a5def88',
      '14:49:26',
      'meridian',
      'saltLine',
      'inference',
      '500',
      true,
    ),
  ],
  nextCursor: null,
}

/** Six arrivals, one every four seconds after mount. Then it stops for good. */
export const INCOMING: readonly WireReceipt[] = [
  receipt(
    '7d222c75f76183a83df1dbc1d82c524d1716e6b9409b48e7855cb016c97e4372',
    '14:52:15',
    'meridian',
    'tideGauges',
    'inference',
    '905',
    false,
  ),
  receipt(
    '1dd81134fb957bbcca6ba013ce871bdd9e9b7a01f4aa51594886f98732da752f',
    '14:52:19',
    'corvid',
    'saltLine',
    'train',
    '2000',
    false,
  ),
  receipt(
    '3be6be8e87e07456aa0be9d4073032d1f2a8c9297dacf24d632a499e512cdf11',
    '14:52:23',
    'halcyon',
    'dryPort',
    'train',
    '6000',
    false,
  ),
  paidDirect(
    receipt(
      'aa3719e085eebdfcd90d0b50399425fa01bc336cf2264104ce6118fadec3cdd3',
      '14:52:27',
      'pallas',
      'logs1974',
      'inference',
      '500',
      false,
    ),
  ),
  receipt(
    '57ffc1a93987b8537ba56678f3f94064619cfed31f0b80ab2dfc1d0dc2540c7d',
    '14:52:31',
    'meridian',
    'saltLine',
    'inference',
    '500',
    false,
  ),
  receipt(
    'b7f5afae5c02dfb19db528ceb98fe73f0e328c1fb8ce13bfd3dec39a9e97fe40',
    '14:52:35',
    'corvid',
    'sedimentCores',
    'train',
    '12000',
    false,
  ),
]

export const INCOMING_INTERVAL_MS = 4000

const flow = (agent: AgentKey, work: WorkKey, count: number, total: string) => ({
  consumer: AGENT[agent],
  workId: WORK[work],
  count,
  total,
})

/** In the order the gateway sends it: works by `sourceId`, consumers by amount, flows by consumer. */
export const SUMMARY: z.input<typeof publisherSummarySchema> = {
  total: '4246900',
  fee: '424880',
  count: 3536,
  byWork: [
    { workId: WORK.dryPort, sourceId: SOURCE.dryPort, count: 174, total: '369000' },
    { workId: WORK.tideGauges, sourceId: SOURCE.tideGauges, count: 420, total: '483900' },
    { workId: WORK.saltLine, sourceId: SOURCE.saltLine, count: 1660, total: '1460000' },
    { workId: WORK.logs1974, sourceId: SOURCE.logs1974, count: 1210, total: '1070000' },
    { workId: WORK.sedimentCores, sourceId: SOURCE.sedimentCores, count: 72, total: '864000' },
  ],
  byConsumer: [
    { consumer: AGENT.corvid, count: 790, total: '2180000', paymentMethods: ['escrow'] },
    { consumer: AGENT.meridian, count: 1770, total: '1188900', paymentMethods: ['escrow'] },
    { consumer: AGENT.pallas, count: 912, total: '594000', paymentMethods: ['escrow'] },
    { consumer: AGENT.halcyon, count: 64, total: '284000', paymentMethods: ['x402'] },
  ],
  flows: [
    flow('corvid', 'saltLine', 420, '840000'),
    flow('corvid', 'sedimentCores', 60, '720000'),
    flow('corvid', 'logs1974', 310, '620000'),
    flow('meridian', 'saltLine', 1240, '620000'),
    flow('meridian', 'tideGauges', 380, '343900'),
    flow('meridian', 'dryPort', 150, '225000'),
    flow('pallas', 'sedimentCores', 12, '144000'),
    flow('pallas', 'logs1974', 900, '450000'),
    flow('halcyon', 'tideGauges', 40, '140000'),
    flow('halcyon', 'dryPort', 24, '144000'),
  ],
  settlement: { inBatch: '3907900', accrued: '55000', perRequest: '284000' },
  registeredWorks: 5,
}

/* ------------------------- /v1/batches: the batch the sample receipt was settled in */

type WireBody = z.input<typeof receiptBodySchema>

const MERIDIAN_RATES = {
  0: ['tideGauges', 'inference', 905],
  1: ['saltLine', 'inference', 500],
  2: ['dryPort', 'train', 1500],
} as const

const batchBody = (seq: number): WireBody => {
  const [work, useType, tariff] = MERIDIAN_RATES[(seq % 3) as 0 | 1 | 2]
  const second = 41 - (42 - seq) * 7
  return {
    consumer: AGENT.meridian,
    work: WORK[work],
    useType,
    tariff: String(tariff),
    fee: String(Math.ceil(tariff / 10)),
    rateLevel: work === 'tideGauges' ? 'work' : 'domain',
    servedHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
    registryHash: 'dcd29263d24f8959f871dad6a2afe032ace4a0877c1ff114957caf87a616f805',
    acceptedAt: new Date(Date.UTC(2026, 8, 3, 14, 50, second)).toISOString(),
    paymentMethod: 'escrow',
    seq,
  }
}

/** Escrow vouchers 1–42 of one agent; the last is the receipt the preview opens. */
export const SAMPLE_BATCH = {
  escrow: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
  sourceId: SOURCE.tideGauges,
  txSig: 'U7kAUVNnP6cCjvyAV9P9i6PqJcmnrHZeP8hmrFhvnXS27F3awFVYB2Acx8FfKUTDAaK9JCEycor6BzmZmxEdrwL7',
  publishedAt: '2026-09-03T14:51:00.000Z',
  receipts: Array.from({ length: 42 }, (_, i) => batchBody(i + 1)),
} as const
