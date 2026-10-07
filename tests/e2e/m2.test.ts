import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  createAgent,
  deposit,
  fileJournal,
  type Outcome,
  rpcPaymentRail,
  settledPosition,
} from '@contentledger/agent-sim'
import {
  associatedTokenAddress,
  configPda,
  decodeConfig,
  sendAndAwait,
  workPda,
} from '@contentledger/chain'
import { loadCorpus } from '@contentledger/fixtures'
import { publisherSummarySchema, receiptsPageSchema, type UseType } from '@contentledger/shared'
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { type Browser, chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { type Dashboard, openDashboard } from './dashboard.js'
import { errorChain } from './error-chain.js'
import { tokenFlows } from './measure.js'
import { uncommitted } from './provenance.js'
import { arrivalVerdict, type Issued, isolationVerdict, takingsVerdict } from './publishers.js'
import { runTool, type Service, startService } from './services.js'
import { serveStatic } from './static.js'

const ROOT = resolve(import.meta.dirname, '../..')
const REQUESTS = 300
const X402_EVERY = 10
const AGENT_LAMPORTS = 50_000_000n
const SETTLE_DEADLINE_MS = 15 * 60_000
// Rows still in flight when the agent stops get this long; one that needs more has failed SC-003 anyway.
const ARRIVAL_GRACE_MS = 30_000
const MAX_LISTING_PAGES = 40
const PUBLISHER_HOSTS = ['acme-news.test', 'kyiv-photo.test', 'harbour-almanac.test'] as const

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    OPERATOR_KEYPAIR_PATH: z.string().min(1),
  })
  .parse(parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')))

const corpus = loadCorpus()
const publishers = PUBLISHER_HOSTS.map((host) => {
  const domain = corpus.domains.find((d) => d.host === host)
  if (domain === undefined || domain.status !== 'active')
    throw new Error(`${host} is not an active domain`)
  return domain
})
const ownerOfWork = new Map(
  publishers.flatMap((d) =>
    d.works.map((w) => [workPda(w.sourceId)[0].toBase58(), d.owner] as const),
  ),
)

// Only works that cost something for both uses: a free one would issue receipts of zero.
const paidWorks = publishers.map((domain) =>
  domain.works
    .filter((w) => w.status === 'active')
    .filter(
      (w) =>
        (w.rateTrain ?? domain.rateTrain) > 0n && (w.rateInference ?? domain.rateInference) > 0n,
    )
    .map((w) => w.sourceId),
)
// Round-robin across the three, so every publisher's window is busy for the whole run.
const works = Array.from({ length: Math.max(...paidWorks.map((w) => w.length)) }, (_, i) =>
  paidWorks.flatMap((list) => (i < list.length ? [list[i] as string] : [])),
).flat()

type Pay = 'escrow' | 'x402'
const plan = Array.from({ length: REQUESTS }, (_, i) => ({
  source: works[i % works.length] as string,
  use: (Math.floor(i / works.length) % 2 === 0 ? 'train' : 'inference') as UseType,
  pay: (i % X402_EVERY === X402_EVERY - 1 ? 'x402' : 'escrow') as Pay,
}))

const quoteSchema = z.object({ total: z.string().transform(BigInt) })
const anchorSchema = z.object({
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pending') }),
    z.object({ kind: z.literal('batch'), txSig: z.string() }),
    z.object({ kind: z.literal('payment'), paymentRef: z.string() }),
  ]),
})

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const loadKeypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
const redact = (text: string) => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise((done) => server.close(done))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

type Receipt = Extract<Outcome, { kind: 'delivered' }>['receipt']

it('M2 on devnet: three publishers at once, SC-003, SC-004, takings agree with the chain', async () => {
  const provider = new URL(env.SOLANA_RPC_URL).hostname
  if (provider !== 'devnet.helius-rpc.com') {
    throw new Error(`SOLANA_RPC_URL must be ContentLedger's own Helius devnet key, not ${provider}`)
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  const dirty = uncommitted(git('status', '--porcelain=v1', '-z', '--untracked-files=all'))
  if (dirty.length > 0) {
    throw new Error(`commit the code before the run, it would not be what ran: ${dirty.join(', ')}`)
  }
  const builtOn = git('rev-parse', 'HEAD').trim()

  const owners = new Map<string, Keypair>()
  const keysDir = join(ROOT, '.secrets/fixtures')
  for (const file of readdirSync(keysDir).filter((f) => f.endsWith('.keypair.json'))) {
    const keypair = loadKeypair(join(keysDir, file))
    owners.set(keypair.publicKey.toBase58(), keypair)
  }
  for (const domain of publishers) {
    if (!owners.has(domain.owner)) throw new Error(`no key in .secrets/fixtures for ${domain.host}`)
  }

  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-')
  const runDir = join(ROOT, '.secrets/e2e', `m2-${runId}`)
  mkdirSync(runDir, { recursive: true })
  const progress = (line: string) =>
    appendFileSync(join(runDir, 'progress.log'), `${new Date().toISOString()} ${line}\n`)
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed')
  const agentKeypair = Keypair.generate()
  const agent = agentKeypair.publicKey
  writeFileSync(
    join(runDir, 'agent.keypair.json'),
    JSON.stringify(Array.from(agentKeypair.secretKey)),
    {
      mode: 0o600,
    },
  )

  // Raw JSON, as `tokenFlows` reads it: web3.js would hand back classes without `accountKeys` for v0.
  async function finalizedTransaction(signature: string): Promise<unknown> {
    for (let tries = 0; tries < 30; tries += 1) {
      const res = await fetch(env.SOLANA_RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            signature,
            { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
          ],
        }),
      })
      const answer = (await res.json()) as { result?: unknown; error?: { message: string } }
      if (answer.error) throw new Error(`getTransaction: ${answer.error.message}`)
      if (answer.result != null) return answer.result
      await sleep(2_000)
    }
    throw new Error(`transaction ${signature} not finalized`)
  }

  const services: Service[] = []
  const assertServicesAlive = () => {
    for (const service of services) {
      const exit = service.exited()
      if (exit !== null) throw new Error(exit)
    }
  }
  let site: Awaited<ReturnType<typeof serveStatic>> | null = null
  let browser: Browser | null = null
  const dashboards: Dashboard[] = []

  const issued: Issued[] = []
  const served: Receipt[] = []
  const failures: { index: number; outcome: unknown }[] = []
  const clockOffsets: Record<string, number> = {}
  let sc003: ReturnType<typeof arrivalVerdict> | null = null
  let sc004: ReturnType<typeof isolationVerdict> | null = null
  let takings: ReturnType<typeof takingsVerdict> | null = null
  let transactions: Record<string, unknown> = {}
  let failure: string | null = null

  try {
    const fixturesPort = await freePort()
    const gatewayPort = await freePort()
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

    // The dashboard as it ships: a production build, pointed at this run's gateway.
    const webDir = join(runDir, 'web')
    await runTool(
      ['--filter', '@contentledger/web', 'build', '--outDir', webDir, '--emptyOutDir'],
      {
        cwd: ROOT,
        env: { VITE_API_URL: gatewayUrl, PAGES_BASE: '/' },
      },
    )
    site = await serveStatic(webDir)

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
          PORT: String(gatewayPort),
          FIXTURES_BASE_URL: `http://127.0.0.1:${fixturesPort}`,
          DASHBOARD_ORIGIN: site.origin,
        },
        ready: /gateway listening/,
        logPath: join(runDir, 'gateway.log'),
      }),
    )
    services.push(
      await startService({
        name: 'settler',
        cwd: join(ROOT, 'apps/settler'),
        env: {},
        ready: /settler started/,
        logPath: join(runDir, 'settler.log'),
      }),
    )
    progress(`services up, dashboard at ${site.origin}`)

    const quotes = new Map<string, bigint>()
    for (const source of works) {
      for (const use of ['train', 'inference'] as const) {
        const res = await fetch(
          `${gatewayUrl}/v1/quote?source=${encodeURIComponent(source)}&use=${use}`,
        )
        if (res.status !== 200) throw new Error(`no quote for ${use} ${source}: HTTP ${res.status}`)
        quotes.set(`${use} ${source}`, quoteSchema.parse(await res.json()).total)
      }
    }
    const totalOf = (pay: Pay) =>
      plan
        .filter((p) => p.pay === pay)
        .reduce((total, p) => total + (quotes.get(`${p.use} ${p.source}`) as bigint), 0n)
    const depositAmount = totalOf('escrow')
    await runTool(
      [
        '--filter',
        '@contentledger/deploy',
        'fund',
        '--to',
        agent.toBase58(),
        '--usdc',
        String(depositAmount + totalOf('x402')),
        '--lamports',
        String(AGENT_LAMPORTS),
        '--apply',
      ],
      { cwd: ROOT, env: {} },
    )
    const depositSig = await deposit(connection, agentKeypair, depositAmount)
    transactions = { deposit: depositSig }
    progress(`agent ${agent.toBase58()} funded, deposit ${depositSig}`)

    browser = await chromium.launch()
    for (const domain of publishers) {
      dashboards.push(
        await openDashboard(browser, `${site.origin}/`, owners.get(domain.owner) as Keypair),
      )
      clockOffsets[domain.host] = await (dashboards.at(-1) as Dashboard).clockOffset()
    }
    progress(`three dashboards live, clock offsets ${JSON.stringify(clockOffsets)}`)

    const client = createAgent({
      keypair: agentKeypair,
      rail: rpcPaymentRail(connection, agentKeypair),
      gatewayUrl,
      fetch,
      journal: fileJournal(join(runDir, 'agent.journal.json')),
      settledPosition: () => settledPosition(connection, agent),
      log: () => {},
    })
    for (const [index, request] of plan.entries()) {
      const outcome = await client.request(request.source, request.use, { pay: request.pay })
      if (
        outcome.kind !== 'delivered' ||
        outcome.receipt.paymentMethod !== request.pay ||
        !outcome.receipt.hashMatch ||
        outcome.receipt.work !== workPda(request.source)[0].toBase58()
      ) {
        failures.push({ index, outcome: outcome.kind === 'delivered' ? outcome.receipt : outcome })
      } else {
        const receipt = outcome.receipt
        served.push(receipt)
        issued.push({
          id: receipt.id,
          owner: ownerOfWork.get(receipt.work) as string,
          acceptedAt: receipt.acceptedAt,
          tariff: BigInt(receipt.tariff),
        })
      }
      if ((index + 1) % 50 === 0) {
        progress(`${index + 1}/${REQUESTS} requests, ${failures.length} failed`)
        assertServicesAlive()
      }
    }

    const seenAll = () =>
      issued.every((r) => dashboards.find((d) => d.owner === r.owner)?.sightings.has(r.id))
    const graceEnds = Date.now() + ARRIVAL_GRACE_MS
    while (!seenAll() && Date.now() < graceEnds) await sleep(500)
    for (const [i, dashboard] of dashboards.entries()) {
      await dashboard.page.screenshot({ path: join(runDir, `${publishers[i]?.host}.png`) })
    }
    sc003 = arrivalVerdict(issued, new Map(dashboards.map((d) => [d.owner, d.sightings])))
    progress(`SC-003 ${sc003.verdict}, p95 ${sc003.all?.p95} ms`)

    const escrowServed = served.filter((r) => r.paymentMethod === 'escrow')
    const anchorOf = async (id: string) =>
      anchorSchema.parse(await (await fetch(`${gatewayUrl}/v1/receipts/${id}`)).json()).anchor
    const last = escrowServed.at(-1)
    const deadline = Date.now() + SETTLE_DEADLINE_MS
    while (last && (await anchorOf(last.id)).kind !== 'batch') {
      assertServicesAlive()
      if (Date.now() > deadline) throw new Error('the settler did not anchor the session in time')
      await sleep(10_000)
    }
    const batchSigs = new Set<string>()
    for (const receipt of escrowServed) {
      const anchor = await anchorOf(receipt.id)
      if (anchor.kind !== 'batch') throw new Error(`receipt ${receipt.id} is not anchored`)
      batchSigs.add(anchor.txSig)
    }
    const x402Sigs = served.flatMap((r) => (r.paymentMethod === 'x402' ? [r.paymentRef] : []))
    transactions = { deposit: depositSig, batches: [...batchSigs], x402: x402Sigs }
    progress(`settled in ${batchSigs.size} batches`)

    // What each publisher reads, read as it does: through its own session.
    const publisherGet = async (token: string, path: string): Promise<unknown> => {
      for (;;) {
        const res = await fetch(`${gatewayUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 429) {
          await sleep(Number(res.headers.get('retry-after') ?? '1') * 1_000)
          continue
        }
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
        return res.json()
      }
    }
    const period = new URLSearchParams({
      from: startedAt.toISOString(),
      to: new Date(Date.now() + 1_000).toISOString(),
    })
    const summaries = new Map<string, z.output<typeof publisherSummarySchema>>()
    const listed = new Map<string, { id: string; sourceId: string }[]>()
    for (const dashboard of dashboards) {
      const token = await dashboard.token()
      summaries.set(
        dashboard.owner,
        publisherSummarySchema.parse(await publisherGet(token, `/v1/publisher/summary?${period}`)),
      )
      const wanted = new Set([
        ...dashboard.sightings.keys(),
        ...issued.filter((r) => r.owner === dashboard.owner).map((r) => r.id),
      ])
      const rows: { id: string; sourceId: string }[] = []
      let cursor: string | null = null
      for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
        const query: string = cursor === null ? '' : `?${new URLSearchParams({ cursor })}`
        const listing = receiptsPageSchema.parse(
          await publisherGet(token, `/v1/publisher/receipts${query}`),
        )
        rows.push(...listing.items.map(({ id, sourceId }) => ({ id, sourceId })))
        for (const { id } of listing.items) wanted.delete(id)
        cursor = listing.nextCursor
        if (cursor === null || wanted.size === 0) break
      }
      listed.set(dashboard.owner, rows)
    }
    sc004 = isolationVerdict({
      hosts: new Map(publishers.map((d) => [d.owner, new Set([d.host])])),
      issued,
      windows: new Map(dashboards.map((d) => [d.owner, new Set(d.sightings.keys())])),
      listed,
    })
    progress(`SC-004 ${sc004.verdict}, ${sc004.foreignRows} foreign rows`)

    const configInfo = await connection.getAccountInfo(configPda()[0])
    if (configInfo === null) throw new Error('Config is missing')
    const mint = decodeConfig(configInfo.data).mint
    const settled = await Promise.all([...batchSigs, ...x402Sigs].map(finalizedTransaction))
    takings = takingsVerdict({
      consumer: agent.toBase58(),
      issued,
      summaries,
      payouts: new Map(
        publishers.map((d) => [
          d.owner,
          associatedTokenAddress(new PublicKey(d.payoutOwner), new PublicKey(mint)).toBase58(),
        ]),
      ),
      flows: settled.map((tx) => tokenFlows(tx, mint)),
    })
    progress(`takings ${takings.verdict}`)
  } catch (error) {
    failure = redact(errorChain(error))
    progress(`failed: ${failure}`)
  } finally {
    await browser?.close()
    for (const service of services.reverse()) await service.stop()
    await site?.close()
    const operator = loadKeypair(resolve(ROOT, env.OPERATOR_KEYPAIR_PATH)).publicKey
    const left = await connection.getBalance(agent).catch(() => 0)
    if (left > 5_000) {
      await sendAndAwait(
        connection,
        [SystemProgram.transfer({ fromPubkey: agent, toPubkey: operator, lamports: left - 5_000 })],
        [agentKeypair],
        { commitment: 'confirmed', pollMs: 400 },
      ).catch((error: unknown) => progress(`SOL not returned: ${redact(String(error))}`))
    }
  }

  const unmeasured = (why: string) => ({ verdict: 'unmeasured' as const, why })
  const result = {
    milestone: 'M2',
    status: failure === null ? 'complete' : 'broken',
    failure,
    cluster: 'devnet',
    builtOn,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    agent: agent.toBase58(),
    publishers: publishers.map((d) => ({
      host: d.host,
      owner: d.owner,
      payoutOwner: d.payoutOwner,
    })),
    requests: {
      planned: REQUESTS,
      delivered: served.length,
      escrow: served.filter((r) => r.paymentMethod === 'escrow').length,
      x402: served.filter((r) => r.paymentMethod === 'x402').length,
      failures,
    },
    // The gateway stamps acceptedAt on this machine's clock; each page's offset from it, ms.
    clockOffsets,
    sc003: sc003 ?? unmeasured('the run broke before the requests'),
    sc004: sc004 ?? unmeasured('the run broke before the dashboards were read back'),
    takings: takings ?? unmeasured('the run broke before the session was settled'),
    transactions,
  }
  const resultsDir = join(ROOT, 'tests/e2e/results')
  mkdirSync(resultsDir, { recursive: true })
  const resultPath = join(resultsDir, `m2-${runId.slice(0, 16)}.json`)
  writeFileSync(
    resultPath,
    `${JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
  )
  progress(`result: ${resultPath}`)

  expect(failure).toBeNull()
  expect(failures).toEqual([])
  expect(Object.values(clockOffsets).every((offset) => offset === 0)).toBe(true)
  for (const verdict of [result.sc003, result.sc004, result.takings]) {
    expect(verdict).toMatchObject({ verdict: 'pass' })
  }
})
