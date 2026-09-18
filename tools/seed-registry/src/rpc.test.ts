import { domainPda, workPda } from '@contentledger/chain'
import { loadCorpus } from '@contentledger/fixtures'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { buildSeedPlan } from './plan.js'
import { seedAccounts } from './rpc.js'

const plan = buildSeedPlan(loadCorpus(), Keypair.generate().publicKey)
const accounts = seedAccounts(plan)

describe('акаунти посіву', () => {
  it('кожен унікальний, хоч кроків удвічі більше', () => {
    expect(accounts).toHaveLength(15)
    expect(new Set(accounts.map(({ address }) => address.toBase58())).size).toBe(15)
    expect(plan.length).toBeGreaterThan(accounts.length)
  })

  /// `set_domain_status` ділить PDA з `register_domain`, і за іменем виду його
  /// прийняли б за твір — тобто домен пішов би в декодер твору.
  it('PDA домену лишається доменом навіть після кроку зміни статусу', () => {
    const devblog = domainPda('devblog.test')[0].toBase58()
    const entry = accounts.find(({ address }) => address.toBase58() === devblog)

    expect(entry?.kind).toBe('domain')
    expect(accounts.filter(({ kind }) => kind === 'domain')).toHaveLength(3)
  })

  it('PDA твору зі ставками лишається твором', () => {
    const rated = workPda('https://acme-news.test/2026/solana-fee-market.html')[0].toBase58()

    expect(accounts.find(({ address }) => address.toBase58() === rated)?.kind).toBe('work')
    expect(accounts.filter(({ kind }) => kind === 'work')).toHaveLength(12)
  })
})
