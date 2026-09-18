import type { Domain, Work } from '@contentledger/chain'
import { domainPda, workPda } from '@contentledger/chain'
import { loadCorpus } from '@contentledger/fixtures'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { diffSeedPlan, type RegistrySnapshot } from './diff.js'
import { buildSeedPlan } from './plan.js'

const operator = Keypair.generate().publicKey
const corpus = loadCorpus()
const plan = buildSeedPlan(corpus, operator)

const EMPTY: RegistrySnapshot = { domains: new Map(), works: new Map() }

const acme = corpus.domains[0]
const suspendedWork = corpus.bySource.get('https://acme-news.test/archive/2019-open-web.md')
const ratedWork = corpus.bySource.get('https://acme-news.test/2026/solana-fee-market.html')

const domainAccount = (over: Partial<Domain> = {}): Domain => ({
  owner: acme?.owner ?? '',
  payoutOwner: acme?.payoutOwner ?? '',
  host: 'acme-news.test',
  rateTrain: 2_000n,
  rateInference: 500n,
  status: 'active',
  bump: 254,
  ...over,
})

const workAccount = (contentHash: string, over: Partial<Work> = {}): Work => ({
  domain: domainPda('acme-news.test')[0].toBase58(),
  sourceHash: '00'.repeat(32),
  contentHash,
  rateTrain: null,
  rateInference: null,
  status: 'active',
  attestedBy: 0,
  bump: 254,
  ...over,
})

const snapshotWith = (domains: [string, Domain][], works: [string, Work][]): RegistrySnapshot => ({
  domains: new Map(domains),
  works: new Map(works),
})

const stateOf = (statuses: ReturnType<typeof diffSeedPlan>, kind: string, subject: string) =>
  statuses.find((entry) => entry.step.kind === kind && entry.step.subject === subject)?.state

describe('порожня мережа', () => {
  it('лишає весь план до виконання', () => {
    const statuses = diffSeedPlan(plan, EMPTY)

    expect(statuses).toHaveLength(plan.length)
    expect(statuses.every((entry) => entry.state === 'todo')).toBe(true)
  })
})

describe('домен уже засіяний', () => {
  const key = domainPda('acme-news.test')[0].toBase58()

  it('збіг із корпусом закриває крок реєстрації', () => {
    const statuses = diffSeedPlan(plan, snapshotWith([[key, domainAccount()]], []))

    expect(stateOf(statuses, 'register_domain', 'acme-news.test')).toBe('done')
    expect(stateOf(statuses, 'register_domain', 'kyiv-photo.test')).toBe('todo')
  })

  it('інші ставки — це розбіжність, а не «зроблено»', () => {
    const statuses = diffSeedPlan(plan, snapshotWith([[key, domainAccount({ rateTrain: 1n })]], []))

    expect(stateOf(statuses, 'register_domain', 'acme-news.test')).toBe('mismatch')
  })

  it('інший власник — теж розбіжність: посів її не полагодить', () => {
    const statuses = diffSeedPlan(
      plan,
      snapshotWith([[key, domainAccount({ owner: Keypair.generate().publicKey.toBase58() })]], []),
    )

    expect(stateOf(statuses, 'register_domain', 'acme-news.test')).toBe('mismatch')
  })

  it('статус звіряється окремим кроком, а не разом із реєстрацією', () => {
    const devblog = domainPda('devblog.test')[0].toBase58()
    const account = domainAccount({
      host: 'devblog.test',
      owner: corpus.domains[2]?.owner ?? '',
      payoutOwner: corpus.domains[2]?.payoutOwner ?? '',
      rateTrain: 1_000n,
      rateInference: 300n,
      status: 'suspended',
    })
    const statuses = diffSeedPlan(plan, snapshotWith([[devblog, account]], []))

    expect(stateOf(statuses, 'register_domain', 'devblog.test')).toBe('done')
    expect(stateOf(statuses, 'set_domain_status', 'devblog.test')).toBe('done')
  })
})

describe('твір уже засіяний', () => {
  it('той самий хеш вмісту закриває крок', () => {
    const key = workPda(suspendedWork?.sourceId ?? '')[0].toBase58()
    const statuses = diffSeedPlan(
      plan,
      snapshotWith([], [[key, workAccount(suspendedWork?.contentHash ?? '')]]),
    )

    expect(stateOf(statuses, 'register_work', suspendedWork?.sourceId ?? '')).toBe('done')
  })

  it('інший хеш вмісту — розбіжність: джерело змінилось після посіву', () => {
    const key = workPda(suspendedWork?.sourceId ?? '')[0].toBase58()
    const statuses = diffSeedPlan(plan, snapshotWith([], [[key, workAccount('ab'.repeat(32))]]))

    expect(stateOf(statuses, 'register_work', suspendedWork?.sourceId ?? '')).toBe('mismatch')
  })

  it('виставлені ставки й статус закривають свої кроки', () => {
    const rated = workPda(ratedWork?.sourceId ?? '')[0].toBase58()
    const suspended = workPda(suspendedWork?.sourceId ?? '')[0].toBase58()
    const statuses = diffSeedPlan(
      plan,
      snapshotWith(
        [],
        [
          [rated, workAccount(ratedWork?.contentHash ?? '', { rateTrain: 9_000n })],
          [suspended, workAccount(suspendedWork?.contentHash ?? '', { status: 'suspended' })],
        ],
      ),
    )

    expect(stateOf(statuses, 'set_work_rates', ratedWork?.sourceId ?? '')).toBe('done')
    expect(stateOf(statuses, 'set_work_status', suspendedWork?.sourceId ?? '')).toBe('done')
  })

  it('крок ставок лишається до виконання, поки твору немає', () => {
    const statuses = diffSeedPlan(plan, EMPTY)

    expect(stateOf(statuses, 'set_work_rates', ratedWork?.sourceId ?? '')).toBe('todo')
  })
})
