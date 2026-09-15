import type { UseType } from './money.js'

/**
 * Правило «ставка твору, інакше ставка домену» живе тут, а не в програмі.
 *
 * Ончейн цю ставку ніхто не читає: сетлмент вірить підписаному ваучеру, у
 * якому `tariff` і `fee` уже зафіксовані підписом агента. Єдиний споживач —
 * шлюз, коли він виставляє ціну (FR-008) і заповнює `rateLevel` у квитанції
 * (FR-002a). Друга реалізація в Rust була б мертвим кодом у задеплоєному
 * бінарнику і другим джерелом правди про ціну.
 */

export type LicenceStatus = 'active' | 'suspended'

export type RateLevel = 'domain' | 'work'

/** Дзеркало ончейн-`Domain` у частині, що впливає на ціну. */
export interface DomainRates {
  status: LicenceStatus
  rateTrain: bigint
  rateInference: bigint
}

/**
 * Дзеркало ончейн-`Work`. `null` — «перекриття не задано»; нуль ним бути не
 * може, бо нульова ставка легітимна (безкоштовно за цим типом використання).
 */
export interface WorkRates {
  status: LicenceStatus
  rateTrain: bigint | null
  rateInference: bigint | null
}

export type RateResolution =
  | { licensed: true; tariff: bigint; level: RateLevel }
  | { licensed: false; reason: 'domain-suspended' | 'work-suspended' }

/**
 * Ціна конкретного запиту і рівень, з якого вона взята (FR-002a).
 *
 * Знятий домен закриває всі свої твори незалежно від їхніх власних тарифів, а
 * знятий твір не впливає на решту творів домену (FR-002b). Ончейн жодного
 * розповсюдження статусу немає й не потрібно: `set_status` на домені міняє
 * один акаунт, а закриття творів — саме це правило на читанні.
 */
export function resolveRate(
  domain: DomainRates,
  work: WorkRates,
  useType: UseType,
): RateResolution {
  if (domain.status === 'suspended') {
    return { licensed: false, reason: 'domain-suspended' }
  }
  if (work.status === 'suspended') {
    return { licensed: false, reason: 'work-suspended' }
  }

  const override = useType === 'train' ? work.rateTrain : work.rateInference
  if (override !== null) {
    return { licensed: true, tariff: override, level: 'work' }
  }

  const base = useType === 'train' ? domain.rateTrain : domain.rateInference
  return { licensed: true, tariff: base, level: 'domain' }
}
