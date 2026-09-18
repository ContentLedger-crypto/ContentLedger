import type { Domain, Work } from '@contentledger/chain'
import type { SeedStep } from './plan.js'

export interface RegistrySnapshot {
  /** Ключі — base58 адрес PDA, тобто те саме, що `SeedStep.account`. */
  domains: ReadonlyMap<string, Domain>
  works: ReadonlyMap<string, Work>
}

export type SeedStepState = 'todo' | 'done' | 'mismatch'

export interface SeedStepStatus {
  step: SeedStep
  state: SeedStepState
  /** Заповнюється тільки для `mismatch` — що саме розійшлося. */
  note?: string
}

/**
 * `mismatch` — не «зроблено» і не «зробити»: акаунт існує, але його зміст не той,
 * що в корпусі, а посів це полагодити не може. Власника не міняє жодна
 * інструкція взагалі, а хеш вмісту після реєстрації правиться лише атестацією.
 * Мовчазний пропуск таких кроків давав би зелений посів над чужим реєстром.
 */
export function diffSeedPlan(plan: SeedStep[], snapshot: RegistrySnapshot): SeedStepStatus[] {
  return plan.map((step) => ({ step, ...evaluate(step, snapshot) }))
}

function evaluate(
  step: SeedStep,
  snapshot: RegistrySnapshot,
): { state: SeedStepState; note?: string } {
  const key = step.account.toBase58()

  switch (step.kind) {
    case 'register_domain': {
      const onChain = snapshot.domains.get(key)
      if (onChain === undefined) {
        return { state: 'todo' }
      }
      return compare([
        ['host', onChain.host, step.domain.host],
        ['owner', onChain.owner, step.domain.owner],
        ['payout_owner', onChain.payoutOwner, step.domain.payoutOwner],
        ['rate_train', onChain.rateTrain, step.domain.rateTrain],
        ['rate_inference', onChain.rateInference, step.domain.rateInference],
      ])
    }

    case 'set_domain_status': {
      const onChain = snapshot.domains.get(key)
      return applied(onChain?.status === step.domain.status, onChain !== undefined)
    }

    case 'register_work': {
      const onChain = snapshot.works.get(key)
      if (onChain === undefined) {
        return { state: 'todo' }
      }
      return compare([['content_hash', onChain.contentHash, step.work.contentHash]])
    }

    case 'set_work_rates': {
      const onChain = snapshot.works.get(key)
      const equal =
        onChain?.rateTrain === step.work.rateTrain &&
        onChain?.rateInference === step.work.rateInference
      return applied(equal, onChain !== undefined)
    }

    case 'set_work_status': {
      const onChain = snapshot.works.get(key)
      return applied(onChain?.status === step.work.status, onChain !== undefined)
    }
  }
}

/** Крок-зміна не буває розбіжністю: поки акаунта немає — його просто ще не час. */
const applied = (equal: boolean, exists: boolean): { state: SeedStepState } => ({
  state: exists && equal ? 'done' : 'todo',
})

function compare(fields: [string, string | bigint, string | bigint][]): {
  state: SeedStepState
  note?: string
} {
  const differing = fields.filter(([, onChain, wanted]) => onChain !== wanted)
  if (differing.length === 0) {
    return { state: 'done' }
  }

  return {
    state: 'mismatch',
    note: differing.map(([name, onChain, wanted]) => `${name}: ${onChain} != ${wanted}`).join(', '),
  }
}
