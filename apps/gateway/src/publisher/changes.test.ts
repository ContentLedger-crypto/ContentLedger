import {
  coder,
  decodeInstruction,
  domainPda,
  PROGRAM_ID,
  sourceSeed,
  workPda,
} from '@contentledger/chain'
import type { ChangeRequest } from '@contentledger/shared'
import { BN } from '@coral-xyz/anchor'
import { type AccountInfo, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { prepareChange } from './changes.js'
import type { RegistrationChain } from './registration.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed))
const ALICE = key(1)
const BOB = key(2)
const HOST = 'tide-notes.test'
const SOURCE = 'https://tide-notes.test/2026/neap-tides.html'
const DOMAIN = domainPda(HOST)[0]
const WORK = workPda(SOURCE)[0]
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'

const account = (data: Buffer, owner = PROGRAM_ID): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1_000_000,
  owner,
  rentEpoch: 0,
})

const domainOf = (owner: PublicKey, suspended = false) =>
  coder.accounts.encode('Domain', {
    owner,
    payout_owner: owner,
    host: HOST,
    rate_train: new BN(2000),
    rate_inference: new BN(500),
    status: suspended ? { Suspended: {} } : { Active: {} },
    bump: 254,
    reserved: Array(32).fill(0),
  })

const workOf = (rateTrain: number | null) =>
  coder.accounts.encode('Work', {
    domain: DOMAIN,
    source_hash: Array.from(sourceSeed(SOURCE)),
    content_hash: Array(32).fill(0x22),
    rate_train: rateTrain === null ? null : new BN(rateTrain),
    rate_inference: null,
    status: { Active: {} },
    attested_by: 0,
    bump: 253,
    reserved: Array(32).fill(0),
  })

async function chain(owner: PublicKey, { workRate = null as number | null } = {}) {
  const accounts = new Map([
    [DOMAIN.toBase58(), account(await domainOf(owner))],
    [WORK.toBase58(), account(await workOf(workRate))],
  ])
  const fake: RegistrationChain = {
    getMultipleAccountsInfo: async (keys, commitment) => {
      expect(commitment).toBe('confirmed')
      return keys.map((k) => accounts.get(k.toBase58()) ?? null)
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 412_000_150 }),
  }
  return { accounts, fake }
}

const decoded = (base64: string) => {
  const tx = Transaction.from(Buffer.from(base64, 'base64'))
  return {
    tx,
    instructions: tx.instructions.map((ix) => ({
      ...decodeInstruction(ix),
      keys: ix.keys.map(({ pubkey, isSigner, isWritable }) => ({
        pubkey: pubkey.toBase58(),
        isSigner,
        isWritable,
      })),
    })),
  }
}

const domainChange = (change: Partial<Extract<ChangeRequest, { kind: 'domain' }>> = {}) => ({
  kind: 'domain' as const,
  domain: DOMAIN.toBase58(),
  rateTrain: 2000n,
  rateInference: 500n,
  status: 'active' as const,
  ...change,
})

const workChange = (change: Partial<Extract<ChangeRequest, { kind: 'work' }>> = {}) => ({
  kind: 'work' as const,
  work: WORK.toBase58(),
  rateTrain: null,
  rateInference: null,
  status: 'active' as const,
  ...change,
})

describe('prepareChange — domain', () => {
  it('builds set_domain_rates for the owner to sign, and only that when the status stays', async () => {
    const { fake } = await chain(ALICE)
    const result = await prepareChange(
      ALICE.toBase58(),
      domainChange({ rateTrain: 3000n, rateInference: 0n }),
      fake,
    )
    if (!result.ok) throw new Error(result.reason)

    expect(result.prepared).toMatchObject({
      address: DOMAIN.toBase58(),
      lastValidBlockHeight: 412_000_150,
    })
    const { tx, instructions } = decoded(result.prepared.transaction)
    expect(tx.feePayer?.equals(ALICE)).toBe(true)
    expect(tx.recentBlockhash).toBe(BLOCKHASH)
    expect(tx.signatures.every(({ signature }) => signature === null)).toBe(true)
    expect(instructions).toHaveLength(1)
    expect(instructions[0]?.name).toBe('set_domain_rates')
    expect(instructions[0]?.data.rate_train).toBe(3000n)
    expect(instructions[0]?.data.rate_inference).toBe(0n)
    expect(instructions[0]?.keys).toEqual([
      { pubkey: ALICE.toBase58(), isSigner: true, isWritable: true },
      { pubkey: DOMAIN.toBase58(), isSigner: false, isWritable: true },
    ])
  })

  it('suspends without touching the rates', async () => {
    const { fake } = await chain(ALICE)
    const result = await prepareChange(
      ALICE.toBase58(),
      domainChange({ status: 'suspended' }),
      fake,
    )
    if (!result.ok) throw new Error(result.reason)
    const { instructions } = decoded(result.prepared.transaction)
    expect(instructions.map(({ name }) => name)).toEqual(['set_domain_status'])
    expect(instructions[0]?.data.status).toEqual({ Suspended: {} })
  })

  it('changes rates and status in one transaction', async () => {
    const { fake } = await chain(ALICE)
    const result = await prepareChange(
      ALICE.toBase58(),
      domainChange({ rateInference: 900n, status: 'suspended' }),
      fake,
    )
    if (!result.ok) throw new Error(result.reason)
    expect(decoded(result.prepared.transaction).instructions.map(({ name }) => name)).toEqual([
      'set_domain_rates',
      'set_domain_status',
    ])
  })

  it('refuses a change that leaves the domain as it is, so nothing is paid for', async () => {
    const { fake } = await chain(ALICE)
    expect(await prepareChange(ALICE.toBase58(), domainChange(), fake)).toEqual({
      ok: false,
      reason: 'unchanged',
    })
  })

  it("refuses somebody else's domain", async () => {
    const { fake } = await chain(BOB)
    expect(await prepareChange(ALICE.toBase58(), domainChange({ rateTrain: 1n }), fake)).toEqual({
      ok: false,
      reason: 'not-yours',
    })
  })

  it('refuses an address that holds no domain: absent, only lamports, or a work', async () => {
    const { accounts, fake } = await chain(ALICE)
    const change = domainChange({ rateTrain: 1n })
    accounts.delete(DOMAIN.toBase58())
    expect(await prepareChange(ALICE.toBase58(), change, fake)).toEqual({
      ok: false,
      reason: 'not-registered',
    })
    accounts.set(DOMAIN.toBase58(), account(Buffer.alloc(0), SystemProgram.programId))
    expect(await prepareChange(ALICE.toBase58(), change, fake)).toEqual({
      ok: false,
      reason: 'not-registered',
    })
    expect(
      await prepareChange(ALICE.toBase58(), { ...change, domain: WORK.toBase58() }, fake),
    ).toEqual({ ok: false, reason: 'not-registered' })
  })
})

describe('prepareChange — work', () => {
  it('builds set_work_rates on the work by address, under its domain', async () => {
    const { fake } = await chain(ALICE)
    const result = await prepareChange(ALICE.toBase58(), workChange({ rateTrain: 0n }), fake)
    if (!result.ok) throw new Error(result.reason)

    expect(result.prepared.address).toBe(WORK.toBase58())
    const { tx, instructions } = decoded(result.prepared.transaction)
    expect(tx.feePayer?.equals(ALICE)).toBe(true)
    expect(instructions.map(({ name }) => name)).toEqual(['set_work_rates'])
    expect(instructions[0]?.data.rate_train).toBe(0n)
    expect(instructions[0]?.data.rate_inference).toBeNull()
    expect(instructions[0]?.keys).toEqual([
      { pubkey: ALICE.toBase58(), isSigner: true, isWritable: true },
      { pubkey: DOMAIN.toBase58(), isSigner: false, isWritable: false },
      { pubkey: WORK.toBase58(), isSigner: false, isWritable: true },
    ])
  })

  it('clears an override back to the domain rate', async () => {
    const { fake } = await chain(ALICE, { workRate: 2500 })
    const result = await prepareChange(ALICE.toBase58(), workChange(), fake)
    if (!result.ok) throw new Error(result.reason)
    const [rates] = decoded(result.prepared.transaction).instructions
    expect(rates?.name).toBe('set_work_rates')
    expect(rates?.data.rate_train).toBeNull()
  })

  it('suspends the work alone', async () => {
    const { fake } = await chain(ALICE)
    const result = await prepareChange(ALICE.toBase58(), workChange({ status: 'suspended' }), fake)
    if (!result.ok) throw new Error(result.reason)
    expect(decoded(result.prepared.transaction).instructions.map(({ name }) => name)).toEqual([
      'set_work_status',
    ])
  })

  it('tells a free work apart from one on the domain rate', async () => {
    const { fake } = await chain(ALICE, { workRate: 0 })
    expect(await prepareChange(ALICE.toBase58(), workChange({ rateTrain: 0n }), fake)).toEqual({
      ok: false,
      reason: 'unchanged',
    })
    expect((await prepareChange(ALICE.toBase58(), workChange(), fake)).ok).toBe(true)
  })

  it("refuses a work under somebody else's domain", async () => {
    const { fake } = await chain(BOB)
    expect(
      await prepareChange(ALICE.toBase58(), workChange({ status: 'suspended' }), fake),
    ).toEqual({ ok: false, reason: 'not-yours' })
  })

  it('refuses an address that holds no work', async () => {
    const { accounts, fake } = await chain(ALICE)
    const change = workChange({ status: 'suspended' })
    expect(
      await prepareChange(ALICE.toBase58(), { ...change, work: DOMAIN.toBase58() }, fake),
    ).toEqual({ ok: false, reason: 'not-registered' })
    accounts.delete(WORK.toBase58())
    expect(await prepareChange(ALICE.toBase58(), change, fake)).toEqual({
      ok: false,
      reason: 'not-registered',
    })
  })
})
