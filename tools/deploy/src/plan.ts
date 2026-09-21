import type { Config } from '@contentledger/chain'

export const USDC_DECIMALS = 6
export const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

export interface MintInfo {
  address: string
  decimals: number
  tokenProgram: string
}

export interface BootstrapSnapshot {
  operator: string
  programDeployed: boolean
  /** `USDC_MINT` з оточення; без нього мінт створюється або береться з `Config`. */
  requestedMint: string | null
  mint: MintInfo | null
  /** `null`, поки мінт невідомий: ATA виводиться з нього. */
  treasuryAta: { address: string; exists: boolean } | null
  config: Config | null
}

export type BootstrapStep = 'create_mint' | 'create_treasury_ata' | 'init_config'

export interface BootstrapPlan {
  /** `null` — мінт ще не існує і його створить перший крок. */
  mint: string | null
  steps: BootstrapStep[]
  /** Будь-яка розбіжність зупиняє план цілком: `Config` не має інструкцій, які б її виправили. */
  problems: string[]
}

export function bootstrapPlan(snapshot: BootstrapSnapshot): BootstrapPlan {
  const { operator, requestedMint, mint, treasuryAta, config } = snapshot
  const problems: string[] = []

  if (!snapshot.programDeployed) {
    problems.push('програми немає в мережі — спочатку tools/deploy/deploy.sh')
  }

  if (config !== null) {
    if (config.authority !== operator) {
      problems.push(`authority в Config — ${config.authority}, а операторський ключ — ${operator}`)
    }
    if (config.treasuryAta !== treasuryAta?.address) {
      problems.push(
        `скарбниця в Config — ${config.treasuryAta}, а ATA оператора — ${treasuryAta?.address}`,
      )
    }
    if (requestedMint !== null && config.mint !== requestedMint) {
      problems.push(`Config пинить мінт ${config.mint}, а USDC_MINT в оточенні — ${requestedMint}`)
    }
  }

  const expectedMint = config?.mint ?? requestedMint

  if (expectedMint !== null && mint === null) {
    problems.push(`мінт ${expectedMint} не знайдено в мережі`)
  }

  if (mint !== null) {
    if (mint.decimals !== USDC_DECIMALS) {
      problems.push(`мінт має ${mint.decimals} знаків, потрібно ${USDC_DECIMALS}`)
    }
    if (mint.tokenProgram !== LEGACY_TOKEN_PROGRAM) {
      problems.push('мінт під Token-2022 — програма приймає лише legacy SPL Token')
    }
  }

  if (problems.length > 0) {
    return { mint: expectedMint, steps: [], problems }
  }

  const steps: BootstrapStep[] = []
  if (expectedMint === null) {
    steps.push('create_mint')
  }
  if (treasuryAta === null || !treasuryAta.exists) {
    steps.push('create_treasury_ata')
  }
  if (config === null) {
    steps.push('init_config')
  }

  return { mint: expectedMint, steps, problems }
}
