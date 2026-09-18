import { decodeInstruction, domainPda, PROGRAM_ID, workPda } from '@contentledger/chain'
import { loadCorpus } from '@contentledger/fixtures'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { buildSeedPlan } from './plan.js'

const operator = Keypair.generate().publicKey
const corpus = loadCorpus()
const plan = buildSeedPlan(corpus, operator)

const shape = plan.map((step) => `${step.kind} ${step.subject}`)

function decoded(kind: string, subject: string): Record<string, unknown> {
  const step = plan.find((entry) => entry.kind === kind && entry.subject === subject)
  if (step === undefined) {
    throw new Error(`у плані немає кроку ${kind} ${subject}`)
  }
  return decodeInstruction(step.instruction).data
}

describe('план посіву', () => {
  it('має рівно той склад і порядок, який потрібен програмі', () => {
    expect(shape).toEqual([
      'register_domain acme-news.test',
      'register_work https://acme-news.test/2026/ai-act-explained.html',
      'register_work https://acme-news.test/2026/solana-fee-market.html',
      'set_work_rates https://acme-news.test/2026/solana-fee-market.html',
      'register_work https://acme-news.test/data/2026-crawler-traffic.json',
      'register_work https://acme-news.test/archive/2019-open-web.md',
      'set_work_status https://acme-news.test/archive/2019-open-web.md',
      'register_domain kyiv-photo.test',
      'register_work https://kyiv-photo.test/gallery/podil-morning.png',
      'set_work_rates https://kyiv-photo.test/gallery/podil-morning.png',
      'register_work https://kyiv-photo.test/gallery/dnipro-bridge.png',
      'register_work https://kyiv-photo.test/about/licence.md',
      'set_work_rates https://kyiv-photo.test/about/licence.md',
      'register_work https://kyiv-photo.test/feeds/latest.json',
      'register_domain devblog.test',
      'set_domain_status devblog.test',
      'register_work https://devblog.test/posts/rust-zero-copy.md',
      'register_work https://devblog.test/posts/anchor-idl-traps.md',
      'register_work https://devblog.test/posts/hono-sse.html',
      'register_work https://devblog.test/feeds/atom.json',
    ])
  })

  it('домен реєструється перед своїми творами', () => {
    for (const [index, step] of plan.entries()) {
      if (step.kind !== 'register_work') {
        continue
      }
      const host = new URL(step.subject).hostname
      const registered = plan.findIndex(
        (other) => other.kind === 'register_domain' && other.subject === host,
      )
      expect(registered, step.subject).toBeGreaterThanOrEqual(0)
      expect(registered, step.subject).toBeLessThan(index)
    }
  })

  it('реєструє оператор, а ставки й статуси міняє тільки власник', () => {
    for (const step of plan) {
      const owner = corpus.domains.find(
        (domain) =>
          step.subject === domain.host || step.subject.startsWith(`https://${domain.host}/`),
      )?.owner
      const expected = step.kind.startsWith('register_') ? operator.toBase58() : owner

      expect(step.signer.toBase58(), `${step.kind} ${step.subject}`).toBe(expected)
    }
  })

  it('ставки твору виставляються тільки там, де корпус задає перекриття', () => {
    const withOverride = corpus.domains
      .flatMap((domain) => domain.works)
      .filter((work) => work.rateTrain !== null || work.rateInference !== null)

    expect(shape.filter((entry) => entry.startsWith('set_work_rates '))).toHaveLength(
      withOverride.length,
    )
  })
})

describe('інструкції плану', () => {
  it('усі належать нашій програмі й указують на правильний PDA', () => {
    for (const step of plan) {
      expect(step.instruction.programId.equals(PROGRAM_ID), step.subject).toBe(true)

      const expected = step.subject.startsWith('https://')
        ? workPda(step.subject)[0]
        : domainPda(step.subject)[0]
      expect(step.account.equals(expected), step.subject).toBe(true)
      expect(
        step.instruction.keys.some((meta) => meta.pubkey.equals(expected)),
        step.subject,
      ).toBe(true)
    }
  })

  it('підписант плану є підписантом самої інструкції', () => {
    for (const step of plan) {
      const signers = step.instruction.keys.filter((meta) => meta.isSigner)
      expect(
        signers.map((meta) => meta.pubkey.toBase58()),
        step.subject,
      ).toContain(step.signer.toBase58())
    }
  })

  /// Кодек Anchor на чужому регістрі не падає, а мовчки пише нулі й віддає
  /// буфер правильної довжини. Ловиться це лише зворотним декодуванням значень.
  it('декодується назад у ті самі числа, а не в нулі', () => {
    expect(decoded('set_work_rates', 'https://acme-news.test/2026/solana-fee-market.html')).toEqual(
      {
        rate_train: 9_000n,
        rate_inference: null,
      },
    )

    expect(decoded('set_work_rates', 'https://kyiv-photo.test/about/licence.md')).toEqual({
      rate_train: 0n,
      rate_inference: 0n,
    })

    expect(decoded('register_domain', 'acme-news.test')).toMatchObject({
      host: 'acme-news.test',
      owner: '7ddMq1eic5MmuNAvoUzBnFo7epc383GAMyoY1atS7PQZ',
      payout_owner: '7ddMq1eic5MmuNAvoUzBnFo7epc383GAMyoY1atS7PQZ',
      rate_train: 2_000n,
      rate_inference: 500n,
    })

    expect(decoded('set_domain_status', 'devblog.test')).toEqual({
      status: { Suspended: {} },
    })
  })

  it('несе хеш вмісту з корпусу, а не нулі', () => {
    for (const work of corpus.domains.flatMap((domain) => domain.works)) {
      const data = decoded('register_work', work.sourceId)
      const hash = Buffer.from(data.content_hash as number[]).toString('hex')

      expect(hash, work.sourceId).toBe(work.contentHash)
    }
  })
})
