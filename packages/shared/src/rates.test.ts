import { describe, expect, it } from 'vitest'
import type { DomainRates, WorkRates } from './rates.js'
import { resolveRate } from './rates.js'

const domain = (over: Partial<DomainRates> = {}): DomainRates => ({
  status: 'active',
  rateTrain: 2_000n,
  rateInference: 500n,
  ...over,
})

const work = (over: Partial<WorkRates> = {}): WorkRates => ({
  status: 'active',
  rateTrain: null,
  rateInference: null,
  ...over,
})

describe('resolveRate — рівень ставки (FR-002a)', () => {
  it('бере ставку домену, коли твір не має власної', () => {
    expect(resolveRate(domain(), work(), 'train')).toEqual({
      licensed: true,
      tariff: 2_000n,
      level: 'domain',
    })
    expect(resolveRate(domain(), work(), 'inference')).toEqual({
      licensed: true,
      tariff: 500n,
      level: 'domain',
    })
  })

  it('ставка твору перекриває ставку домену', () => {
    const resolved = resolveRate(domain(), work({ rateTrain: 9_000n }), 'train')
    expect(resolved).toEqual({ licensed: true, tariff: 9_000n, level: 'work' })
  })

  it('перекриття діє на кожен тип використання окремо', () => {
    const w = work({ rateTrain: 9_000n })
    expect(resolveRate(domain(), w, 'train')).toEqual({
      licensed: true,
      tariff: 9_000n,
      level: 'work',
    })
    expect(resolveRate(domain(), w, 'inference')).toEqual({
      licensed: true,
      tariff: 500n,
      level: 'domain',
    })
  })

  it('нульова ставка твору — це ставка, а не «не задано»', () => {
    const resolved = resolveRate(domain(), work({ rateTrain: 0n }), 'train')
    expect(resolved).toEqual({ licensed: true, tariff: 0n, level: 'work' })
  })

  it('нульова ставка домену теж лишається ставкою', () => {
    const resolved = resolveRate(domain({ rateTrain: 0n }), work(), 'train')
    expect(resolved).toEqual({ licensed: true, tariff: 0n, level: 'domain' })
  })
})

describe('resolveRate — статус (FR-002b)', () => {
  it('знятий домен закриває твір навіть із власною ставкою', () => {
    const resolved = resolveRate(
      domain({ status: 'suspended' }),
      work({ rateTrain: 9_000n }),
      'train',
    )
    expect(resolved).toEqual({ licensed: false, reason: 'domain-suspended' })
  })

  it('знятий твір закритий під чинним доменом', () => {
    const resolved = resolveRate(domain(), work({ status: 'suspended' }), 'train')
    expect(resolved).toEqual({ licensed: false, reason: 'work-suspended' })
  })

  it('знятий домен називається першим, коли зняте й те, й те', () => {
    const resolved = resolveRate(
      domain({ status: 'suspended' }),
      work({ status: 'suspended' }),
      'train',
    )
    expect(resolved).toEqual({ licensed: false, reason: 'domain-suspended' })
  })

  it('знятий твір не впливає на інші твори домену', () => {
    const suspended = work({ status: 'suspended' })
    const other = work()
    expect(resolveRate(domain(), suspended, 'train').licensed).toBe(false)
    expect(resolveRate(domain(), other, 'train').licensed).toBe(true)
  })
})
