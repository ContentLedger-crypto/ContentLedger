import { createHash } from 'node:crypto'
import {
  associatedTokenAddress,
  type Config,
  type Domain,
  domainPda,
  escrowPda,
  type LicenceStatus,
  type Work,
  workPda,
  type X402Transaction,
  x402ProofMessage,
} from '@contentledger/chain'
import { MIGRATIONS_DIR, receipts, vouchers, works } from '@contentledger/db'
import {
  chainGenesis,
  chainStep,
  receiptId,
  receiptLeaf,
  voucherMessage,
} from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { PGlite } from '@electric-sql/pglite'
import { ed25519 } from '@noble/curves/ed25519'
import { Keypair, PublicKey } from '@solana/web3.js'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { offerStore } from '../offers.js'
import type { ContentOrigin } from '../origin.js'
import type { PaymentReader } from '../payments.js'
import { tokenBucket } from '../rate-limit.js'
import type { EscrowSnapshot, PaidRegistryReader, PaidRegistrySnapshot } from '../registry.js'
import type { EscrowReceiptBody } from '../voucher.js'
import { type ContentDeps, contentRoutes } from './content.js'

const SOURCE = 'https://acme-news.test/2026/ai-act-explained.html'
const OTHER_SOURCE = 'https://acme-news.test/2026/solana-fee-market.html'
const CONTENT = Uint8Array.from(
  Buffer.from('<h1>AI Act, explained</h1>\n\xff binary tail', 'latin1'),
)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const OWNER = Keypair.generate().publicKey.toBase58()

let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  const client = new PGlite()
  // Supabase ships these roles; the RLS migration names them in its policies.
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

interface World {
  rateTrain: bigint
  domainStatus: LicenceStatus
  escrowOpen: boolean
  vaultBalance: bigint
  withdrawAfter: bigint
  served: Uint8Array<ArrayBuffer>
  slot: bigint
  now: number
  originCalls: number
  ledger: Map<string, X402Transaction>
  rpcDown: boolean
}

let world: World
let agent: Keypair
let escrow: PublicKey
let app: ReturnType<typeof createApp>
let deps: ContentDeps
let issued: string[]

const config: Config = {
  authority: OWNER,
  treasuryAta: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  protocolFeeBps: 1000,
  nodeShareBps: 0,
  voucherGraceS: 900n,
  paused: false,
  bump: 255,
}

const snapshot = (source: string): PaidRegistrySnapshot => {
  const domain: Domain = {
    owner: OWNER,
    payoutOwner: OWNER,
    host: 'acme-news.test',
    rateTrain: world.rateTrain,
    rateInference: 500n,
    status: world.domainStatus,
    bump: 254,
  }
  const work: Work = {
    domain: domainPda('acme-news.test')[0].toBase58(),
    sourceHash: '11'.repeat(32),
    contentHash: sha256(CONTENT),
    rateTrain: null,
    rateInference: null,
    status: 'active',
    attestedBy: 0,
    bump: 253,
  }
  const onchain: EscrowSnapshot = {
    address: escrow.toBase58(),
    account: {
      consumer: agent.publicKey.toBase58(),
      vault: Keypair.generate().publicKey.toBase58(),
      settledTotal: 0n,
      lastSeq: 0n,
      lastChain: '00'.repeat(32),
      withdrawAfter: world.withdrawAfter,
      bump: 252,
      vaultBump: 251,
    },
    vaultBalance: world.vaultBalance,
  }
  world.slot += 1n
  return {
    config,
    domain: { address: work.domain, account: domain },
    work:
      source === SOURCE || source === OTHER_SOURCE
        ? { address: workPda(source)[0].toBase58(), account: work }
        : null,
    escrow: world.escrowOpen ? onchain : null,
    slot: world.slot,
  }
}

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, works, domains cascade`)
  world = {
    rateTrain: 2000n,
    domainStatus: 'active',
    escrowOpen: true,
    vaultBalance: 1_000_000n,
    withdrawAfter: 0n,
    served: CONTENT,
    slot: 100n,
    now: Date.parse('2026-09-30T10:00:00.000Z'),
    originCalls: 0,
    ledger: new Map(),
    rpcDown: false,
  }
  agent = Keypair.generate()
  escrow = escrowPda(agent.publicKey)[0]

  const registry: PaidRegistryReader = {
    read: async (source) => snapshot(source),
    readWithEscrow: async (source, key) => ({
      ...snapshot(source),
      ...(key.equals(escrow) ? {} : { escrow: null }),
    }),
  }
  const origin: ContentOrigin = {
    fetch: async () => {
      world.originCalls += 1
      return { bytes: world.served, mediaType: 'text/html; charset=utf-8' }
    },
  }
  const payments: PaymentReader = {
    transaction: async (signature) => {
      if (world.rpcDown) throw new Error('getTransaction answered HTTP 429')
      return world.ledger.get(signature) ?? null
    },
  }
  const now = () => new Date(world.now)
  const offers = offerStore({ ttlMs: 60_000, maxBytes: 1 << 20, now })
  const unlimited = tokenBucket({ capacity: 1e9, perSecond: 1e9, now: () => world.now })
  issued = []
  deps = {
    registry,
    db,
    origin,
    offers,
    payments,
    now,
    feed: {
      receiptIssued: async (id) => {
        issued.push(id)
      },
    },
    limits: {
      addressOf: (c) => c.req.header('X-Test-Address') ?? '127.0.0.1',
      requests: unlimited,
      drafts: unlimited,
    },
  }
  app = createApp(contentRoutes(deps))
})

const url = (use = 'train') => `/v1/content?source=${encodeURIComponent(SOURCE)}&use=${use}`

const request = (headers: Record<string, string> = {}) => app.request(url(), { headers })

interface OfferJson {
  id: string
  body: EscrowReceiptBody
  cumulativeAfter: string
  expiresAt: string
}

interface ErrorJson {
  code: string
  details: {
    reason?: string
    total?: string
    methods: Array<{ kind: string; unavailable?: string; offer: OfferJson }>
  }
}

const errorOf = async (res: Response) => ((await res.json()) as { error: ErrorJson }).error

async function draft(): Promise<OfferJson> {
  const res = await request({ 'X-ContentLedger-Consumer': agent.publicKey.toBase58() })
  expect(res.status).toBe(402)
  const offer = (await errorOf(res)).details.methods[0]?.offer
  if (offer === undefined) throw new Error('402 carried no draft')
  return offer
}

const genesis = () => chainGenesis(escrow.toBytes())

function sign(offer: OfferJson, previousChain: Uint8Array, signer = agent) {
  const chain = chainStep(previousChain, receiptLeaf(offer.body))
  const voucher = {
    escrow: escrow.toBytes(),
    seq: BigInt(offer.body.seq),
    cumulative: BigInt(offer.cumulativeAfter),
    chain,
  }
  const sig = ed25519.sign(voucherMessage(voucher), signer.secretKey.slice(0, 32))
  const header = Buffer.from(
    JSON.stringify({
      escrow: escrow.toBase58(),
      seq: offer.body.seq,
      cumulative: offer.cumulativeAfter,
      chain: Buffer.from(chain).toString('hex'),
      sig: utils.bytes.bs58.encode(sig),
    }),
  ).toString('base64url')
  return { header, chain }
}

const pay = (offer: OfferJson, voucher: string) =>
  request({
    'X-ContentLedger-Consumer': agent.publicKey.toBase58(),
    'X-ContentLedger-Voucher': voucher,
    'X-ContentLedger-Offer': offer.id,
  })

const receiptOf = (res: Response) =>
  JSON.parse(Buffer.from(res.headers.get('X-ContentLedger-Receipt') ?? '', 'base64url').toString())

describe('GET /v1/content without payment', () => {
  it('quotes without a draft when it does not know the payer, and fetches nothing', async () => {
    const res = await request()
    expect(res.status).toBe(402)
    const { details } = await errorOf(res)
    expect(details.total).toBe('2200')
    expect(details.methods[0]).toMatchObject({ kind: 'escrow', unavailable: 'consumer-required' })
    expect(details.methods[1]).toMatchObject({ kind: 'x402' })
    expect(world.originCalls).toBe(0)
  })

  it('drafts the receipt body for a known payer, over the bytes it will serve', async () => {
    const offer = await draft()
    expect(offer.body).toEqual({
      consumer: agent.publicKey.toBase58(),
      work: workPda(SOURCE)[0].toBase58(),
      useType: 'train',
      tariff: '2000',
      fee: '200',
      rateLevel: 'domain',
      servedHash: sha256(CONTENT),
      registryHash: sha256(CONTENT),
      acceptedAt: '2026-09-30T10:00:00.000Z',
      paymentMethod: 'escrow',
      seq: 1,
    })
    expect(offer.cumulativeAfter).toBe('2200')
    expect(offer.expiresAt).toBe('2026-09-30T10:01:00.000Z')
    expect(world.originCalls).toBe(1)
  })

  it.each([
    ['escrow-missing', { escrowOpen: false }],
    ['insufficient-funds', { vaultBalance: 2199n }],
    ['withdrawal-requested', { withdrawAfter: 1_790_000_000n }],
  ])('says %s instead of drafting, before touching the corpus', async (reason, change) => {
    Object.assign(world, change)
    const res = await request({ 'X-ContentLedger-Consumer': agent.publicKey.toBase58() })
    expect(res.status).toBe(402)
    expect((await errorOf(res)).details.methods[0]).toMatchObject({ unavailable: reason })
    expect(world.originCalls).toBe(0)
  })

  it('rejects a payer header that is not a public key', async () => {
    const res = await request({ 'X-ContentLedger-Consumer': 'not-a-key' })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('INVALID_INPUT')
  })

  it('answers 404 for an unregistered work and 403 for a withdrawn licence', async () => {
    world.domainStatus = 'suspended'
    expect((await request()).status).toBe(403)
    const res = await app.request(
      `/v1/content?source=${encodeURIComponent('https://other.test/x.html')}&use=train`,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /v1/content rate limits', () => {
  const ATTACKER = '198.51.100.66'
  const AGENT_HOST = '203.0.113.7'

  const limited = (requests: number, drafts: number) => {
    const bucket = (capacity: number) =>
      tokenBucket({ capacity, perSecond: 1 / 3600, now: () => world.now })
    app = createApp(
      contentRoutes({
        ...deps,
        limits: { ...deps.limits, requests: bucket(requests), drafts: bucket(drafts) },
      }),
    )
  }

  const from = (address: string, headers: Record<string, string> = {}) =>
    request({ 'X-Test-Address': address, ...headers })

  const asAgent = { 'X-ContentLedger-Consumer': '' }
  beforeEach(() => {
    asAgent['X-ContentLedger-Consumer'] = agent.publicKey.toBase58()
  })

  it('answers 429 with Retry-After once an address spends its budget, before any work', async () => {
    limited(2, 100)
    expect((await from(ATTACKER, asAgent)).status).toBe(402)
    expect((await from(ATTACKER, asAgent)).status).toBe(402)
    const refused = await from(ATTACKER, asAgent)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('3600')
    expect((await errorOf(refused)).code).toBe('RATE_LIMITED')
    expect(world.originCalls).toBe(2)
    expect((await from(AGENT_HOST)).status).toBe(402)
  })

  // The consumer header is unsigned at this point: a budget per escrow alone would let
  // anyone who names the agent's key starve the agent itself.
  it('spends the draft budget per address and escrow, so a flood naming the agent starves only itself', async () => {
    limited(100, 2)
    await from(ATTACKER, asAgent)
    await from(ATTACKER, asAgent)
    expect((await from(ATTACKER, asAgent)).status).toBe(429)
    expect(world.originCalls).toBe(2)
    expect((await from(AGENT_HOST, asAgent)).status).toBe(402)
    expect(world.originCalls).toBe(3)
  })

  it('leaves the draft budget alone when no draft is made', async () => {
    limited(100, 1)
    world.escrowOpen = false
    for (let i = 0; i < 3; i += 1) expect((await from(AGENT_HOST, asAgent)).status).toBe(402)
    expect((await from(AGENT_HOST)).status).toBe(402)
    world.escrowOpen = true
    expect((await from(AGENT_HOST, asAgent)).status).toBe(402)
    expect(world.originCalls).toBe(1)
  })
})

describe('GET /v1/content with an escrow voucher', () => {
  it('serves exactly the hashed bytes and hands over the receipt', async () => {
    const offer = await draft()
    const res = await pay(offer, sign(offer, genesis()).header)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(CONTENT)
    expect(sha256(bytes)).toBe(offer.body.servedHash)
    expect(receiptOf(res)).toEqual({ id: receiptId(offer.body), ...offer.body, hashMatch: true })
    expect(issued).toEqual([receiptId(offer.body)])

    expect(await db.select().from(receipts)).toHaveLength(1)
    expect(await db.select().from(vouchers)).toMatchObject([{ seq: 1n, cumulative: 2200n }])
    expect(await db.select().from(works)).toMatchObject([{ byteLen: CONTENT.length }])
  })

  it('continues the sequence from the stored voucher', async () => {
    const first = await draft()
    const { header, chain } = sign(first, genesis())
    await pay(first, header)

    const second = await draft()
    expect(second.body.seq).toBe(2)
    expect(second.cumulativeAfter).toBe('4400')
    expect((await pay(second, sign(second, chain).header)).status).toBe(200)
  })

  it('serves and charges when the origin no longer matches the registry, marking it (FR-011c)', async () => {
    world.served = Uint8Array.from(Buffer.from('edited after registration'))
    const offer = await draft()
    const res = await pay(offer, sign(offer, genesis()).header)

    expect(res.status).toBe(200)
    expect(receiptOf(res).hashMatch).toBe(false)
    const [receipt] = await db.select().from(receipts)
    expect(receipt).toMatchObject({ hashMatch: false, tariff: 2000n })
  })

  it('holds the offered price when the owner changes the tariff before payment', async () => {
    const offer = await draft()
    world.rateTrain = 9000n
    const res = await pay(offer, sign(offer, genesis()).header)
    expect(res.status).toBe(200)
    expect(receiptOf(res).tariff).toBe('2000')
  })

  it('refuses when the owner withdrew the licence before payment', async () => {
    const offer = await draft()
    world.domainStatus = 'suspended'
    expect((await pay(offer, sign(offer, genesis()).header)).status).toBe(403)
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('refuses a voucher signed by someone else, and keeps the offer', async () => {
    const offer = await draft()
    const res = await pay(offer, sign(offer, genesis(), Keypair.generate()).header)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('bad-signature')
    expect(await db.select().from(receipts)).toHaveLength(0)
    expect((await pay(offer, sign(offer, genesis()).header)).status).toBe(200)
  })

  it('refuses when the vault was drained between offer and payment', async () => {
    const offer = await draft()
    world.vaultBalance = 100n
    const res = await pay(offer, sign(offer, genesis()).header)
    expect(res.status).toBe(402)
    expect((await errorOf(res)).details.methods[0]).toMatchObject({
      unavailable: 'insufficient-funds',
    })
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('rejects a malformed voucher header', async () => {
    const offer = await draft()
    const res = await pay(offer, 'bm90IGEgdm91Y2hlcg')
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('malformed-voucher')
  })

  it('answers an expired offer with a fresh draft and records nothing', async () => {
    const offer = await draft()
    world.now += 60_000
    const res = await pay(offer, sign(offer, genesis()).header)

    expect(res.status).toBe(402)
    const { details } = await errorOf(res)
    expect(details.reason).toBe('offer-expired')
    expect(details.methods[0]?.offer.id).not.toBe(offer.id)
    expect(details.methods[0]?.offer.body.acceptedAt).toBe('2026-09-30T10:01:00.000Z')
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('does not honour an offer on a request for another use or another work', async () => {
    const offer = await draft()
    const { header } = sign(offer, genesis())
    const paidAs = (target: string) =>
      app.request(target, {
        headers: {
          'X-ContentLedger-Consumer': agent.publicKey.toBase58(),
          'X-ContentLedger-Voucher': header,
          'X-ContentLedger-Offer': offer.id,
        },
      })

    const otherUse = await paidAs(url('inference'))
    expect(otherUse.status).toBe(402)
    expect((await errorOf(otherUse)).details.reason).toBe('offer-expired')
    const otherWork = await paidAs(
      `/v1/content?source=${encodeURIComponent(OTHER_SOURCE)}&use=train`,
    )
    expect(otherWork.status).toBe(402)
    expect((await errorOf(otherWork)).details.reason).toBe('offer-expired')
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('never serves twice for one voucher, even when both requests race', async () => {
    const offer = await draft()
    const { header } = sign(offer, genesis())
    const [a, b] = await Promise.all([pay(offer, header), pay(offer, header)])

    expect([a.status, b.status].sort()).toEqual([200, 400])
    const loser = a.status === 400 ? a : b
    expect((await errorOf(loser)).details.reason).toBe('replayed')
    expect(await db.select().from(vouchers)).toHaveLength(1)
    expect(issued).toHaveLength(1)
  })

  it('does not serve again when a used voucher is presented later', async () => {
    const offer = await draft()
    const { header } = sign(offer, genesis())
    expect((await pay(offer, header)).status).toBe(200)

    const again = await pay(offer, header)
    expect(again.status).toBe(402)
    expect(await db.select().from(receipts)).toHaveLength(1)
  })
})

const PUBLISHER_ATA = associatedTokenAddress(
  new PublicKey(OWNER),
  new PublicKey(config.mint),
).toBase58()

/** Lands a transfer of each leg on the fake chain and returns the request headers for it. */
function payX402(
  legs: Array<[destination: string, amount: bigint]>,
  options: { payer?: Keypair; prover?: Keypair; blockTime?: number | null } = {},
) {
  const payer = options.payer ?? agent
  const signature = utils.bytes.bs58.encode(Keypair.generate().secretKey)
  world.ledger.set(signature, {
    blockTime: options.blockTime === undefined ? world.now / 1000 - 2 : options.blockTime,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      signatures: [signature],
      message: {
        instructions: legs.map(([destination, amount]) => ({
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          parsed: {
            type: 'transfer',
            info: {
              source: Keypair.generate().publicKey.toBase58(),
              destination,
              authority: payer.publicKey.toBase58(),
              amount: amount.toString(),
            },
          },
        })),
      },
    },
  })
  const prover = options.prover ?? payer
  const proof = ed25519.sign(x402ProofMessage(signature), prover.secretKey.slice(0, 32))
  return {
    signature,
    headers: {
      'X-ContentLedger-Payment': signature,
      'X-ContentLedger-Payment-Proof': utils.bytes.bs58.encode(proof),
    },
  }
}

const fullPrice = (): Array<[string, bigint]> => [
  [PUBLISHER_ATA, 2000n],
  [config.treasuryAta, 200n],
]

describe('GET /v1/content with an x402 payment', () => {
  it('serves exactly the hashed bytes and records a receipt anchored to the payment', async () => {
    const { signature, headers } = payX402(fullPrice())
    const res = await request(headers)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONTENT)
    const body = {
      consumer: agent.publicKey.toBase58(),
      work: workPda(SOURCE)[0].toBase58(),
      useType: 'train' as const,
      tariff: '2000',
      fee: '200',
      rateLevel: 'domain' as const,
      servedHash: sha256(CONTENT),
      registryHash: sha256(CONTENT),
      acceptedAt: '2026-09-30T10:00:00.000Z',
      paymentMethod: 'x402' as const,
      paymentRef: signature,
    }
    expect(receiptOf(res)).toEqual({ id: receiptId(body), ...body, hashMatch: true })
    expect(issued).toEqual([receiptId(body)])

    expect(await db.select().from(receipts)).toMatchObject([
      {
        paymentMethod: 'x402',
        paymentRef: signature,
        tariff: 2000n,
        settledAt: new Date('2026-09-30T09:59:58.000Z'),
        batchId: null,
      },
    ])
    expect(await db.select().from(vouchers)).toHaveLength(0)
    expect(await db.select().from(works)).toMatchObject([{ byteLen: CONTENT.length }])
  })

  it.each([
    ['has no block time', null],
    [
      'estimates the block later than the payment was accepted',
      Date.parse('2026-09-30T10:00:01Z') / 1000,
    ],
  ])('dates the payment at acceptance when the node %s', async (_, blockTime) => {
    const { headers } = payX402(fullPrice(), { blockTime })
    expect((await request(headers)).status).toBe(200)
    expect(await db.select().from(receipts)).toMatchObject([
      { settledAt: new Date('2026-09-30T10:00:00.000Z') },
    ])
  })

  it('needs no escrow and no consumer header', async () => {
    world.escrowOpen = false
    expect((await request(payX402(fullPrice()).headers)).status).toBe(200)
  })

  it('accepts a consumer header naming the payer and refuses one naming someone else', async () => {
    const own = payX402(fullPrice()).headers
    const ownRes = await request({ ...own, 'X-ContentLedger-Consumer': agent.publicKey.toBase58() })
    expect(ownRes.status).toBe(200)

    const other = payX402(fullPrice()).headers
    const res = await request({
      ...other,
      'X-ContentLedger-Consumer': Keypair.generate().publicKey.toBase58(),
    })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('consumer-mismatch')
    expect(await db.select().from(receipts)).toHaveLength(1)
  })

  it('does not serve twice for one payment, even when both requests race', async () => {
    const { headers } = payX402(fullPrice())
    const [a, b] = await Promise.all([request(headers), request(headers)])

    expect([a.status, b.status].sort()).toEqual([200, 400])
    const loser = a.status === 400 ? a : b
    expect((await errorOf(loser)).details.reason).toBe('replayed')
    expect(await db.select().from(receipts)).toHaveLength(1)
    expect(issued).toHaveLength(1)
  })

  it('does not serve again when a redeemed payment is presented later', async () => {
    const { headers } = payX402(fullPrice())
    expect((await request(headers)).status).toBe(200)
    world.now += 3_600_000

    const again = await request(headers)
    expect(again.status).toBe(400)
    expect((await errorOf(again)).details.reason).toBe('replayed')
    expect(await db.select().from(receipts)).toHaveLength(1)
  })

  it('answers 400, not 402, for a payment the node cannot see yet, and fetches nothing', async () => {
    const { headers } = payX402(fullPrice())
    world.ledger.clear()
    const res = await request(headers)

    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('payment-not-found')
    expect(world.originCalls).toBe(0)
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('lets a payment refused before the fetch be presented again', async () => {
    const { signature, headers } = payX402(fullPrice())
    const landed = world.ledger.get(signature)
    world.ledger.clear()
    expect((await request(headers)).status).toBe(400)

    if (landed) world.ledger.set(signature, landed)
    expect((await request(headers)).status).toBe(200)
  })

  it('refuses a payment at the old price once the owner has changed it', async () => {
    const { headers } = payX402(fullPrice())
    world.rateTrain = 3000n
    const res = await request(headers)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('leg-mismatch')
  })

  it('refuses a payment whose fee went to the publisher', async () => {
    const res = await request(payX402([[PUBLISHER_ATA, 2200n]]).headers)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('leg-mismatch')
  })

  it('refuses someone else redeeming a payment they watched land', async () => {
    const res = await request(payX402(fullPrice(), { prover: Keypair.generate() }).headers)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('proof-invalid')
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('refuses a payment for a work whose licence was withdrawn', async () => {
    world.domainStatus = 'suspended'
    expect((await request(payX402(fullPrice()).headers)).status).toBe(403)
    expect(await db.select().from(receipts)).toHaveLength(0)
  })

  it('does not take x402 for a free work, which is issued against a voucher', async () => {
    world.rateTrain = 0n
    const res = await request(payX402(fullPrice()).headers)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('x402-not-offered')
  })

  it.each([
    ['a missing proof', { 'X-ContentLedger-Payment': '5'.repeat(88) }],
    [
      'a signature of the wrong length',
      {
        'X-ContentLedger-Payment': '5'.repeat(40),
        'X-ContentLedger-Payment-Proof': '5'.repeat(88),
      },
    ],
  ])('rejects %s as malformed', async (_, headers) => {
    const res = await request(headers)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('malformed-payment')
  })

  it('refuses a request carrying both a voucher and a payment', async () => {
    const res = await request({ ...payX402(fullPrice()).headers, 'X-ContentLedger-Voucher': 'x' })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details.reason).toBe('two-payment-methods')
  })

  it('answers 500 when the RPC fails, leaving the payment unredeemed', async () => {
    const { headers } = payX402(fullPrice())
    world.rpcDown = true
    expect((await request(headers)).status).toBe(500)
    world.rpcDown = false
    expect((await request(headers)).status).toBe(200)
  })
})
