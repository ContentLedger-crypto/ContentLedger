import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  createAgent,
  deposit,
  fileJournal,
  type Outcome,
  parsePaymentRequired,
  paymentProof,
  rpcPaymentRail,
  settledPosition,
  signVoucher,
} from '@contentledger/agent-sim'
import {
  associatedTokenAddress,
  configPda,
  decodeConfig,
  escrowPda,
  PROGRAM_ID,
  vaultPda,
} from '@contentledger/chain'
import type { UseType } from '@contentledger/shared'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { attempt, tamperVoucher, unknownSignature } from './attacks.js'
import {
  type Attempt,
  costVerdict,
  latencySummary,
  reconcile,
  refusalVerdict,
  rpcVerdict,
  tokenFlows,
  txCost,
  type Verdict,
} from './measure.js'
import { readSolUsd } from './price.js'
import { uncommitted } from './provenance.js'
import { startRpcMeter } from './rpc-meter.js'
import { runTool, type Service, startService } from './services.js'

const ROOT = resolve(import.meta.dirname, '../..')
const REQUESTS = 1000
// Every tenth request pays by x402, spread across the session as a fallback would be.
const X402_EVERY = 10
const PRODUCT_LANES = ['gateway', 'settler', 'agent']
const AGENT_LAMPORTS = 50_000_000n
const SETTLE_DEADLINE_MS = 15 * 60_000

const WORKS = [
  'https://acme-news.test/2026/ai-act-explained.html',
  'https://acme-news.test/2026/solana-fee-market.html',
  // Rates 2001 and 333: the protocol fee does not divide them, so it rounds up (FR-015a).
  'https://acme-news.test/data/2026-crawler-traffic.json',
  'https://kyiv-photo.test/gallery/podil-morning.png',
  'https://kyiv-photo.test/gallery/dnipro-bridge.png',
  'https://kyiv-photo.test/feeds/latest.json',
] as const
const BOUNDARY_WORK = WORKS[2]

const CONSUMER = 'X-ContentLedger-Consumer'
const VOUCHER = 'X-ContentLedger-Voucher'
const OFFER = 'X-ContentLedger-Offer'
const PAYMENT = 'X-ContentLedger-Payment'
const PAYMENT_PROOF = 'X-ContentLedger-Payment-Proof'

type Pay = 'escrow' | 'x402'
interface Planned {
  source: string
  use: UseType
  pay: Pay
}

const plan: Planned[] = Array.from({ length: REQUESTS }, (_, i) => ({
  source: WORKS[i % WORKS.length] as string,
  use: Math.floor(i / WORKS.length) % 2 === 0 ? 'train' : 'inference',
  pay: i % X402_EVERY === X402_EVERY - 1 ? 'x402' : 'escrow',
}))

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    SOLANA_WS_URL: z.url(),
    OPERATOR_KEYPAIR_PATH: z.string().min(1),
  })
  .parse(parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')))

const quoteSchema = z.object({
  tariff: z.string().transform(BigInt),
  fee: z.string().transform(BigInt),
  total: z.string().transform(BigInt),
})
const anchorSchema = z.object({
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pending') }),
    z.object({ kind: z.literal('batch'), txSig: z.string(), seqTo: z.number() }),
    z.object({ kind: z.literal('payment'), paymentRef: z.string() }),
  ]),
})

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const loadKeypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise((done) => server.close(done))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

type Served = {
  pay: Pay
  proofMs: number
  cycleMs: number
  receipt: Extract<Outcome, { kind: 'delivered' }>['receipt']
}

type Settlement = {
  sc001: {
    escrow: { verdict: Verdict } & Record<string, unknown>
    x402: { verdict: Verdict } & Record<string, unknown>
  } & Record<string, unknown>
  sc005: { verdict: Verdict } & Record<string, unknown>
  transactions: Record<string, unknown>
} & Record<string, unknown>

const redact = (text: string) => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const unmeasured = (why: string) => ({ verdict: 'unmeasured' as const, why })

it('M1 on devnet: 1000 paid requests, SC-001, SC-002, SC-005, SC-006, SC-008', async () => {
  // Decision 5: the budget SC-008 is judged against is Helius Free, so the run goes there.
  const provider = new URL(env.SOLANA_RPC_URL).hostname
  if (provider !== 'devnet.helius-rpc.com') {
    throw new Error(`SOLANA_RPC_URL must be ContentLedger's own Helius devnet key, not ${provider}`)
  }
  // Decision 8: anyone checks the measurements against the commit the result names.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  const dirty = uncommitted(git('status', '--porcelain=v1', '-z', '--untracked-files=all'))
  if (dirty.length > 0) {
    throw new Error(`commit the code before the run, it would not be what ran: ${dirty.join(', ')}`)
  }
  const builtOn = git('rev-parse', 'HEAD').trim()

  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-')
  const runDir = join(ROOT, '.secrets/e2e', runId)
  mkdirSync(runDir, { recursive: true })
  // Vitest holds console output back until the test ends; a file shows a run in progress.
  const progress = (line: string) =>
    appendFileSync(join(runDir, 'progress.log'), `${new Date().toISOString()} ${line}\n`)
  const meter = await startRpcMeter({ http: env.SOLANA_RPC_URL, ws: env.SOLANA_WS_URL })
  const services: Service[] = []
  const harness = new Connection(meter.url('harness'), 'confirmed')
  const agentKeypair = Keypair.generate()
  const agent = agentKeypair.publicKey
  writeFileSync(
    join(runDir, 'agent.keypair.json'),
    JSON.stringify(Array.from(agentKeypair.secretKey)),
    { mode: 0o600 },
  )

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(meter.url('harness'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const answer = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (answer.error) throw new Error(`${method}: ${answer.error.message}`)
    return answer.result
  }

  async function finalizedTransaction(signature: string): Promise<unknown> {
    for (let tries = 0; tries < 30; tries += 1) {
      const tx = await rpc('getTransaction', [
        signature,
        { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ])
      if (tx !== null) return tx
      await sleep(2_000)
    }
    throw new Error(`transaction ${signature} not finalized`)
  }

  const assertServicesAlive = () => {
    for (const service of services) {
      const exit = service.exited()
      if (exit !== null) throw new Error(exit)
    }
  }

  // Everything the result is made of lives out here, so a run that breaks halfway still
  // reports what it measured before it broke.
  const served: Served[] = []
  const failures: { index: number; outcome: unknown }[] = []
  const attempts: (Attempt & { reason?: string })[] = []
  const events: Record<string, number> = {}
  let depositAmount: bigint | null = null
  let depositSig: string | null = null
  let settlement: Settlement | null = null
  let failure: string | null = null

  try {
    const fixturesPort = await freePort()
    const gatewayPort = await freePort()
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
    services.push(
      await startService({
        name: 'fixtures',
        cwd: join(ROOT, 'apps/fixtures'),
        env: { FIXTURES_PORT: String(fixturesPort) },
        ready: /http:\/\/localhost:\d+/,
        logPath: join(runDir, 'fixtures.log'),
      }),
    )
    services.push(
      await startService({
        name: 'gateway',
        cwd: join(ROOT, 'apps/gateway'),
        env: {
          SOLANA_RPC_URL: meter.url('gateway'),
          PORT: String(gatewayPort),
          FIXTURES_BASE_URL: `http://127.0.0.1:${fixturesPort}`,
        },
        ready: /gateway listening/,
        logPath: join(runDir, 'gateway.log'),
      }),
    )
    services.push(
      await startService({
        name: 'settler',
        cwd: join(ROOT, 'apps/settler'),
        env: { SOLANA_RPC_URL: meter.url('settler') },
        ready: /settler started/,
        logPath: join(runDir, 'settler.log'),
      }),
    )
    progress('services up')

    const quotes = new Map<string, z.infer<typeof quoteSchema>>()
    for (const source of WORKS) {
      for (const use of ['train', 'inference'] as const) {
        const res = await fetch(
          `${gatewayUrl}/v1/quote?source=${encodeURIComponent(source)}&use=${use}`,
        )
        if (res.status !== 200) throw new Error(`no quote for ${use} ${source}: HTTP ${res.status}`)
        quotes.set(`${use} ${source}`, quoteSchema.parse(await res.json()))
      }
    }
    const quoteOf = ({ source, use }: Pick<Planned, 'source' | 'use'>) =>
      quotes.get(`${use} ${source}`) as z.infer<typeof quoteSchema>
    if (quoteOf({ source: BOUNDARY_WORK, use: 'train' }).tariff !== 2001n) {
      throw new Error('the boundary tariff is not on chain yet: seed-registry seed --apply')
    }

    // The deposit covers the escrow requests exactly, plus one request's worth so the refusal
    // set can still be offered a draft at the end; the vault must end holding just that.
    const escrowTotal = plan
      .filter((p) => p.pay === 'escrow')
      .reduce((total, p) => total + quoteOf(p).total, 0n)
    const x402Total = plan
      .filter((p) => p.pay === 'x402')
      .reduce((total, p) => total + quoteOf(p).total, 0n)
    const reserve = [...quotes.values()].reduce((max, q) => (q.total > max ? q.total : max), 0n)
    depositAmount = escrowTotal + reserve

    await runTool(
      [
        '--filter',
        '@contentledger/deploy',
        'fund',
        '--to',
        agent.toBase58(),
        '--usdc',
        String(depositAmount + x402Total),
        '--lamports',
        String(AGENT_LAMPORTS),
        '--apply',
      ],
      { cwd: ROOT, env: { SOLANA_RPC_URL: meter.url('harness') } },
    )
    const agentConnection = new Connection(meter.url('agent'), 'confirmed')
    depositSig = await deposit(agentConnection, agentKeypair, depositAmount)
    progress(`agent ${agent.toBase58()} funded, deposit ${depositSig}`)

    let proofStartedAt: number | null = null
    let proofAnsweredAt: number | null = null
    const usedVouchers: Record<string, string>[] = []
    const usedPayments: Record<string, string>[] = []
    const timedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const proof = headers.has(VOUCHER) || headers.has(PAYMENT)
      if (proof && proofStartedAt === null) proofStartedAt = performance.now()
      const res = await fetch(input, init)
      if (!proof || res.status !== 200) return res
      const body = await res.arrayBuffer()
      proofAnsweredAt = performance.now()
      const sent = Object.fromEntries(headers.entries())
      ;(headers.has(VOUCHER) ? usedVouchers : usedPayments).push({ url: String(input), ...sent })
      return new Response(body, { status: res.status, headers: res.headers })
    }

    const journalPath = join(runDir, 'agent.journal.json')
    const client = createAgent({
      keypair: agentKeypair,
      rail: rpcPaymentRail(agentConnection, agentKeypair),
      gatewayUrl,
      fetch: timedFetch,
      journal: fileJournal(journalPath),
      settledPosition: () => settledPosition(agentConnection, agent),
      log: (event) => {
        events[event] = (events[event] ?? 0) + 1
      },
    })

    for (const [index, request] of plan.entries()) {
      proofStartedAt = null
      proofAnsweredAt = null
      const started = performance.now()
      const outcome = await client.request(request.source, request.use, { pay: request.pay })
      const cycleMs = performance.now() - started
      if (
        outcome.kind !== 'delivered' ||
        outcome.receipt.paymentMethod !== request.pay ||
        !outcome.receipt.hashMatch ||
        proofStartedAt === null ||
        proofAnsweredAt === null
      ) {
        failures.push({ index, outcome: outcome.kind === 'delivered' ? outcome.receipt : outcome })
      } else {
        served.push({
          pay: request.pay,
          proofMs: proofAnsweredAt - proofStartedAt,
          cycleMs,
          receipt: outcome.receipt,
        })
      }
      if ((index + 1) % 50 === 0) {
        progress(`${index + 1}/${REQUESTS} requests, ${failures.length} failed`)
        assertServicesAlive()
      }
    }

    // SC-006: nothing here carries a valid, unused proof of payment.
    const attacker = Keypair.generate()
    const journal = fileJournal(journalPath)
    const contentUrl = (source: string, use: UseType) =>
      `${gatewayUrl}/v1/content?source=${encodeURIComponent(source)}&use=${use}`
    const pick = <T>(items: readonly T[], count: number): T[] =>
      Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)] as T)
    const freshVoucher = async (source: string, use: UseType) => {
      const quoted = await fetch(contentUrl(source, use), {
        headers: { [CONSUMER]: agent.toBase58() },
      })
      const required = parsePaymentRequired(await quoted.json())
      if (required === null || !('offer' in required.escrow)) {
        throw new Error('no draft to attack with')
      }
      const state = await journal.read()
      if (state === null) throw new Error('agent journal is missing')
      return { offer: required.escrow.offer, position: state.position }
    }
    for (const [i, source] of pick(WORKS, 10).entries()) {
      const url = contentUrl(source, i % 2 === 0 ? 'train' : 'inference')
      attempts.push(
        await attempt(fetch, url, 'no-proof', i < 5 ? {} : { [CONSUMER]: agent.toBase58() }),
      )
    }
    for (const { url, ...headers } of pick(usedVouchers, 10)) {
      attempts.push(await attempt(fetch, url as string, 'replayed-voucher', headers))
    }
    for (const { url, ...headers } of pick(usedPayments, 10)) {
      attempts.push(await attempt(fetch, url as string, 'replayed-x402', headers))
    }
    for (const how of ['forged-signature', 'inflated-cumulative', 'wrong-chain'] as const) {
      for (const source of pick(WORKS, 5)) {
        const { offer, position } = await freshVoucher(source, 'train')
        const signed = signVoucher(agentKeypair, position, offer)
        attempts.push(
          await attempt(fetch, contentUrl(source, 'train'), how, {
            [CONSUMER]: agent.toBase58(),
            [VOUCHER]: tamperVoucher(signed.header, how),
            [OFFER]: offer.id,
          }),
        )
      }
    }
    for (const source of pick(WORKS, 5)) {
      const { offer, position } = await freshVoucher(source, 'train')
      attempts.push(
        await attempt(fetch, contentUrl(source, 'train'), 'foreign-key', {
          [CONSUMER]: agent.toBase58(),
          [VOUCHER]: signVoucher(attacker, position, offer).header,
          [OFFER]: offer.id,
        }),
      )
    }
    for (const source of pick(WORKS, 5)) {
      const { offer, position } = await freshVoucher(source, 'train')
      attempts.push(
        await attempt(fetch, contentUrl(source, 'train'), 'unknown-offer', {
          [CONSUMER]: agent.toBase58(),
          [VOUCHER]: signVoucher(agentKeypair, position, offer).header,
          [OFFER]: `${offer.id}-not-issued`,
        }),
      )
    }
    for (const used of pick(usedPayments, 5)) {
      const signature = used[PAYMENT.toLowerCase()] as string
      attempts.push(
        await attempt(fetch, used.url as string, 'x402-foreign-proof', {
          [CONSUMER]: agent.toBase58(),
          [PAYMENT]: signature,
          [PAYMENT_PROOF]: paymentProof(attacker, signature),
        }),
      )
    }
    for (const { url: _paidFor, ...headers } of pick(usedPayments, 5)) {
      // The dearest work, paid for with the receipt of whatever this payment bought.
      attempts.push(await attempt(fetch, contentUrl(WORKS[3], 'train'), 'x402-other-work', headers))
    }
    for (const source of pick(WORKS, 5)) {
      const signature = unknownSignature()
      attempts.push(
        await attempt(fetch, contentUrl(source, 'train'), 'x402-unknown-signature', {
          [CONSUMER]: agent.toBase58(),
          [PAYMENT]: signature,
          [PAYMENT_PROOF]: paymentProof(agentKeypair, signature),
        }),
      )
    }
    progress(`${attempts.length} refusal attempts made`)

    // The settler anchors in seq order, so the last escrow receipt anchored means all are.
    const escrowServed = served.filter((s) => s.pay === 'escrow')
    const anchorOf = async (id: string) =>
      anchorSchema.parse(await (await fetch(`${gatewayUrl}/v1/receipts/${id}`)).json()).anchor
    const last = escrowServed.at(-1)
    const deadline = Date.now() + SETTLE_DEADLINE_MS
    while (last && (await anchorOf(last.receipt.id)).kind !== 'batch') {
      assertServicesAlive()
      if (Date.now() > deadline) throw new Error('the settler did not anchor the session in time')
      await sleep(10_000)
    }
    const batchSigs = new Set<string>()
    for (const { receipt } of escrowServed) {
      const anchor = await anchorOf(receipt.id)
      if (anchor.kind !== 'batch') throw new Error(`receipt ${receipt.id} is not anchored`)
      batchSigs.add(anchor.txSig)
    }
    const x402Sigs = served.flatMap((s) =>
      s.receipt.paymentMethod === 'x402' ? [s.receipt.paymentRef] : [],
    )
    progress(`settled in ${batchSigs.size} batches`)

    const configInfo = await harness.getAccountInfo(configPda()[0])
    if (configInfo === null) throw new Error('Config is missing')
    const config = decodeConfig(configInfo.data)
    const escrow = escrowPda(agent)[0]
    const vault = vaultPda(escrow)[0]
    const agentAta = associatedTokenAddress(agent, new PublicKey(config.mint))
    const batches = await Promise.all([...batchSigs].map(finalizedTransaction))
    const payments = []
    for (const sig of x402Sigs) payments.push(await finalizedTransaction(sig))
    const depositTx = await finalizedTransaction(depositSig)
    const vaultLeft = BigInt(
      z
        .object({ value: z.object({ amount: z.string() }) })
        .parse(await rpc('getTokenAccountBalance', [vault.toBase58(), { commitment: 'finalized' }]))
        .value.amount,
    )

    const sc005 = reconcile({
      charged: served.map(({ receipt }) => ({
        tariff: BigInt(receipt.tariff),
        fee: BigInt(receipt.fee),
      })),
      flows: [...batches, ...payments].map((tx) => tokenFlows(tx, config.mint)),
      payers: new Set([vault.toBase58(), agentAta.toBase58()]),
      treasury: config.treasuryAta,
    })
    const escrowCharged = escrowServed.reduce(
      (total, s) => total + BigInt(s.receipt.tariff) + BigInt(s.receipt.fee),
      0n,
    )
    const batchCosts = batches.map(txCost)
    const paymentCosts = payments.map(txCost)
    const depositCost = txCost(depositTx)
    const price = await readSolUsd(fetch, new Date())
    const solUsd = 'usd' in price ? price.usd : null
    settlement = {
      escrow: escrow.toBase58(),
      mint: config.mint,
      sc001: {
        budget: 'under 0.1 cent per licensed request, network fees for the payment and its anchor',
        solUsd: price,
        escrow: {
          ...costVerdict(
            (sum(batchCosts.map((c) => c.feeLamports)) + depositCost.feeLamports) /
              escrowServed.length,
            solUsd,
          ),
          batches: batches.length,
          batchFeeLamports: sum(batchCosts.map((c) => c.feeLamports)),
          depositFeeLamports: depositCost.feeLamports,
          // Not a fee: rent the escrow, its vault and the SettlementLog ring lock per consumer.
          rentLamports: sum(batchCosts.map((c) => c.rentLamports)) + depositCost.rentLamports,
        },
        x402: {
          ...costVerdict(
            sum(paymentCosts.map((c) => c.feeLamports)) / Math.max(x402Sigs.length, 1),
            solUsd,
          ),
          rentLamports: sum(paymentCosts.map((c) => c.rentLamports)),
        },
      },
      sc005: {
        ...sc005,
        verdict: (sc005.verdict === 'pass' && vaultLeft === depositAmount - escrowCharged
          ? 'pass'
          : 'fail') as Verdict,
        boundaryReceipts: served.filter(({ receipt }) => BigInt(receipt.tariff) % 10n !== 0n)
          .length,
        deposit: depositAmount,
        vaultLeft,
        vaultExpected: depositAmount - escrowCharged,
      },
      transactions: { deposit: depositSig, batches: [...batchSigs], x402: x402Sigs },
    }
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error))
    progress(`failed: ${failure}`)
  } finally {
    for (const service of services.reverse()) await service.stop()
    // A throwaway agent's leftover SOL goes back to the operator who funded it.
    const operator = loadKeypair(resolve(ROOT, env.OPERATOR_KEYPAIR_PATH)).publicKey
    const left = await harness.getBalance(agent).catch(() => 0)
    if (left > 5_000) {
      await sendAndConfirmTransaction(
        harness,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: agent, toPubkey: operator, lamports: left - 5_000 }),
        ),
        [agentKeypair],
      ).catch((error: unknown) => progress(`SOL not returned: ${redact(String(error))}`))
    }
  }

  const proofMs = (pay: Pay) => served.filter((s) => s.pay === pay).map((s) => s.proofMs)
  const cycleMs = (pay: Pay) => served.filter((s) => s.pay === pay).map((s) => s.cycleMs)
  const latency = (samples: number[]) =>
    samples.length > 0 ? latencySummary(samples) : unmeasured('no request was served')
  const complete = failure === null && failures.length === 0
  const result = {
    milestone: 'M1',
    status: failure === null ? 'complete' : 'broken',
    failure,
    cluster: 'devnet',
    program: PROGRAM_ID.toBase58(),
    builtOn,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    rpcProvider: provider,
    agent: agent.toBase58(),
    requests: {
      planned: REQUESTS,
      delivered: served.length,
      escrow: served.filter((s) => s.pay === 'escrow').length,
      x402: served.filter((s) => s.pay === 'x402').length,
      failures,
      agentEvents: events,
    },
    sc001: settlement?.sc001 ?? unmeasured('the run broke before the session was settled'),
    sc002: {
      budget: 'p95 under 3 s from the request carrying the proof to the last byte of content',
      escrow: latency(proofMs('escrow')),
      x402: latency(proofMs('x402')),
      fullCycle: { escrow: latency(cycleMs('escrow')), x402: latency(cycleMs('x402')) },
    },
    sc005: settlement?.sc005 ?? unmeasured('the run broke before the session was settled'),
    sc006:
      attempts.length > 0
        ? { ...refusalVerdict(attempts), refusals: attempts }
        : unmeasured('the run broke before the refusal set'),
    sc008: {
      ...(complete
        ? rpcVerdict(meter.usage(), PRODUCT_LANES, REQUESTS)
        : {
            ...rpcVerdict(meter.usage(), PRODUCT_LANES, Math.max(served.length, 1)),
            ...unmeasured('fewer than 1000 requests were served'),
          }),
      priceList: 'https://www.helius.dev/docs/billing/credits',
      usage: meter.usage(),
    },
    deposit: depositAmount,
    transactions: settlement?.transactions ?? { deposit: depositSig },
  }
  await meter.close()
  const resultsDir = join(ROOT, 'tests/e2e/results')
  mkdirSync(resultsDir, { recursive: true })
  const resultPath = join(resultsDir, `m1-${runId.slice(0, 16)}.json`)
  writeFileSync(
    resultPath,
    `${JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
  )
  progress(`result: ${resultPath}`)

  expect(failure).toBeNull()
  expect(failures).toEqual([])
  for (const verdict of [
    settlement?.sc001.escrow ?? result.sc001,
    settlement?.sc001.x402 ?? result.sc001,
    result.sc002.escrow,
    result.sc002.x402,
    result.sc005,
    result.sc006,
    result.sc008,
  ]) {
    expect(verdict).toMatchObject({ verdict: 'pass' })
  }
})
