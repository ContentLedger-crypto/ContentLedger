import {
  buildRegisterDomain,
  buildRegisterWork,
  buildSetDomainStatus,
  buildSetWorkRates,
  buildSetWorkStatus,
  domainPda,
  workPda,
} from '@contentledger/chain'
import type { Corpus, CorpusDomain, CorpusWork } from '@contentledger/fixtures'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'

export type SeedStepKind =
  | 'register_domain'
  | 'set_domain_status'
  | 'register_work'
  | 'set_work_rates'
  | 'set_work_status'

interface SeedStepBase {
  /** Хост для кроків домену, канонічне джерело для кроків твору. */
  subject: string
  signer: PublicKey
  /** Акаунт, який крок створює або змінює. Ключ для звірки зі станом мережі. */
  account: PublicKey
  instruction: TransactionInstruction
  /** Очікуваний стан бере корпус, а не декодована інструкція: одне джерело правди. */
  domain: CorpusDomain
}

export type SeedStep =
  | (SeedStepBase & { kind: 'register_domain' | 'set_domain_status' })
  | (SeedStepBase & {
      kind: 'register_work' | 'set_work_rates' | 'set_work_status'
      work: CorpusWork
    })

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))

/**
 * Хто що підписує — не наш вибір, а форма інструкцій: `register_*` бере
 * `Config::authority` або власника, `set_*` — **тільки** власника (T015, T016).
 * Тому посів не обходиться операторським ключем: перекриття ставок і зняті
 * статуси підписують ключі видавців із корпусу.
 *
 * Ставки й статус не входять у `register_work` узагалі, тож твір із
 * перекриттям — це завжди два кроки, а не один із додатковими аргументами.
 */
export function buildSeedPlan(corpus: Corpus, operator: PublicKey): SeedStep[] {
  return corpus.domains.flatMap((domain) => [
    ...domainSteps(domain, operator),
    ...domain.works.flatMap((work) => workSteps(domain, work, operator)),
  ])
}

function domainSteps(domain: CorpusDomain, operator: PublicKey): SeedStep[] {
  const owner = new PublicKey(domain.owner)
  const account = domainPda(domain.host)[0]

  const steps: SeedStep[] = [
    {
      kind: 'register_domain',
      subject: domain.host,
      signer: operator,
      account,
      domain,
      instruction: buildRegisterDomain({
        payer: operator,
        host: domain.host,
        owner,
        payoutOwner: new PublicKey(domain.payoutOwner),
        rateTrain: domain.rateTrain,
        rateInference: domain.rateInference,
      }),
    },
  ]

  if (domain.status !== 'active') {
    steps.push({
      kind: 'set_domain_status',
      subject: domain.host,
      signer: owner,
      account,
      domain,
      instruction: buildSetDomainStatus({ owner, host: domain.host, status: domain.status }),
    })
  }

  return steps
}

function workSteps(domain: CorpusDomain, work: CorpusWork, operator: PublicKey): SeedStep[] {
  const owner = new PublicKey(domain.owner)
  const account = workPda(work.sourceId)[0]

  const steps: SeedStep[] = [
    {
      kind: 'register_work',
      subject: work.sourceId,
      signer: operator,
      account,
      domain,
      work,
      instruction: buildRegisterWork({
        payer: operator,
        host: domain.host,
        source: work.sourceId,
        contentHash: hexToBytes(work.contentHash),
      }),
    },
  ]

  if (work.rateTrain !== null || work.rateInference !== null) {
    steps.push({
      kind: 'set_work_rates',
      subject: work.sourceId,
      signer: owner,
      account,
      domain,
      work,
      instruction: buildSetWorkRates({
        owner,
        host: domain.host,
        source: work.sourceId,
        rateTrain: work.rateTrain,
        rateInference: work.rateInference,
      }),
    })
  }

  if (work.status !== 'active') {
    steps.push({
      kind: 'set_work_status',
      subject: work.sourceId,
      signer: owner,
      account,
      domain,
      work,
      instruction: buildSetWorkStatus({
        owner,
        host: domain.host,
        source: work.sourceId,
        status: work.status,
      }),
    })
  }

  return steps
}
