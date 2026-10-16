import { createHash } from 'node:crypto'
import { coder, domainPda, hostSeed, PROGRAM_ID, sourceSeed, workPda } from '@contentledger/chain'
import { BN } from '@coral-xyz/anchor'
import { type AccountInfo, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ContentOrigin } from '../origin.js'
import {
  prepareRegistration,
  type RegistrationChain,
  registrationStatus,
  type SignatureChain,
} from './registration.js'

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed))
const ALICE = key(1)
const BOB = key(2)
const HOST = 'tide-notes.test'
const SOURCE = 'https://tide-notes.test/2026/neap-tides.html'
const BODY = new TextEncoder().encode('<h1>Neap tides</h1>')
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'

const account = (data: Buffer, owner = PROGRAM_ID): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1_000_000,
  owner,
  rentEpoch: 0,
})

const domainOf = (owner: PublicKey) =>
  coder.accounts.encode('Domain', {
    owner,
    payout_owner: owner,
    host: HOST,
    rate_train: new BN(2000),
    rate_inference: new BN(500),
    status: { Active: {} },
    bump: 254,
    reserved: Array(32).fill(0),
  })

const workData = () =>
  coder.accounts.encode('Work', {
    domain: domainPda(HOST)[0],
    source_hash: Array.from(sourceSeed(SOURCE)),
    content_hash: Array(32).fill(0x22),
    rate_train: null,
    rate_inference: null,
    status: { Active: {} },
    attested_by: 0,
    bump: 253,
    reserved: Array(32).fill(0),
  })

function chain(accounts: Map<string, AccountInfo<Buffer>>) {
  const reads: string[][] = []
  const fake: RegistrationChain = {
    getMultipleAccountsInfo: async (keys, commitment) => {
      expect(commitment).toBe('confirmed')
      reads.push(keys.map((k) => k.toBase58()))
      return keys.map((k) => accounts.get(k.toBase58()) ?? null)
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 412_000_150 }),
  }
  return { reads, fake }
}

const origin = (body: Uint8Array | Error): ContentOrigin & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    fetch: async (source) => {
      asked.push(source)
      if (body instanceof Error) throw body
      return { bytes: new Uint8Array(body), mediaType: 'text/html' }
    },
  }
}

const registered = async (owner: PublicKey, withWork = false) =>
  new Map([
    [domainPda(HOST)[0].toBase58(), account(await domainOf(owner))],
    ...(withWork ? [[workPda(SOURCE)[0].toBase58(), account(await workData())] as const] : []),
  ])

const decoded = (base64: string) => {
  const tx = Transaction.from(Buffer.from(base64, 'base64'))
  return {
    tx,
    instructions: tx.instructions.map((ix) =>
      ix.programId.equals(PROGRAM_ID) ? coder.instruction.decode(ix.data) : null,
    ),
  }
}

const workRequest = (rateTrain: bigint | null, rateInference: bigint | null) => ({
  kind: 'work' as const,
  source: SOURCE,
  rateTrain,
  rateInference,
})

describe('prepareRegistration — domain', () => {
  const request = { kind: 'domain' as const, host: HOST, rateTrain: 2000n, rateInference: 0n }

  it('builds an unsigned register_domain the wallet pays for, owns and is paid by', async () => {
    const { fake } = chain(new Map())
    const result = await prepareRegistration(ALICE.toBase58(), request, {
      chain: fake,
      origin: origin(BODY),
    })
    if (!result.ok) throw new Error(result.reason)

    expect(result.prepared.address).toBe(domainPda(HOST)[0].toBase58())
    expect(result.prepared.lastValidBlockHeight).toBe(412_000_150)
    const { tx, instructions } = decoded(result.prepared.transaction)
    expect(tx.feePayer?.equals(ALICE)).toBe(true)
    expect(tx.recentBlockhash).toBe(BLOCKHASH)
    expect(tx.signatures.every(({ signature }) => signature === null)).toBe(true)
    expect(instructions).toHaveLength(1)
    const data = instructions[0]?.data as Record<string, unknown>
    expect(instructions[0]?.name).toBe('register_domain')
    expect(data.host).toBe(HOST)
    expect(Buffer.from(data.host_hash as number[]).equals(Buffer.from(hostSeed(HOST)))).toBe(true)
    expect((data.owner as PublicKey).equals(ALICE)).toBe(true)
    expect((data.payout_owner as PublicKey).equals(ALICE)).toBe(true)
    expect((data.rate_train as BN).toString()).toBe('2000')
    expect((data.rate_inference as BN).toString()).toBe('0')
  })

  it('does not fetch any content for a domain', async () => {
    const { fake } = chain(new Map())
    const content = origin(BODY)
    await prepareRegistration(ALICE.toBase58(), request, { chain: fake, origin: content })
    expect(content.asked).toEqual([])
  })

  it('refuses a host the program would refuse, before reading the chain', async () => {
    const { reads, fake } = chain(new Map())
    for (const host of ['Tide-Notes.test', 'https://tide-notes.test', 'tide-notes.test.', 'test']) {
      const result = await prepareRegistration(
        ALICE.toBase58(),
        { ...request, host },
        { chain: fake, origin: origin(BODY) },
      )
      expect(result, host).toEqual({ ok: false, reason: 'host-not-canonical' })
    }
    expect(reads).toEqual([])
  })

  it('refuses a domain somebody already registered, whoever it was', async () => {
    for (const owner of [ALICE, BOB]) {
      const { fake } = chain(await registered(owner))
      const result = await prepareRegistration(ALICE.toBase58(), request, {
        chain: fake,
        origin: origin(BODY),
      })
      expect(result).toEqual({ ok: false, reason: 'domain-taken' })
    }
  })

  it('does not count lamports sent to the domain address as a registration', async () => {
    const { fake } = chain(
      new Map([[domainPda(HOST)[0].toBase58(), account(Buffer.alloc(0), SystemProgram.programId)]]),
    )
    const result = await prepareRegistration(ALICE.toBase58(), request, {
      chain: fake,
      origin: origin(BODY),
    })
    expect(result.ok).toBe(true)
  })
})

describe('prepareRegistration — work', () => {
  it('hashes what the origin serves and registers the work under the wallet’s domain', async () => {
    const { reads, fake } = chain(await registered(ALICE))
    const content = origin(BODY)
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
      chain: fake,
      origin: content,
    })
    if (!result.ok) throw new Error(result.reason)

    expect(content.asked).toEqual([SOURCE])
    expect(reads).toEqual([[domainPda(HOST)[0].toBase58(), workPda(SOURCE)[0].toBase58()]])
    expect(result.prepared.address).toBe(workPda(SOURCE)[0].toBase58())
    const { tx, instructions } = decoded(result.prepared.transaction)
    expect(tx.feePayer?.equals(ALICE)).toBe(true)
    expect(instructions.map((ix) => ix?.name)).toEqual(['register_work'])
    const data = instructions[0]?.data as Record<string, number[]>
    expect(Buffer.from(data.source_hash ?? []).equals(Buffer.from(sourceSeed(SOURCE)))).toBe(true)
    expect(Buffer.from(data.content_hash ?? []).toString('hex')).toBe(
      createHash('sha256').update(BODY).digest('hex'),
    )
  })

  it('sets the work’s own rates in the same transaction, keeping an inherited one null', async () => {
    const { fake } = chain(await registered(ALICE))
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(9000n, null), {
      chain: fake,
      origin: origin(BODY),
    })
    if (!result.ok) throw new Error(result.reason)

    const { instructions } = decoded(result.prepared.transaction)
    expect(instructions.map((ix) => ix?.name)).toEqual(['register_work', 'set_work_rates'])
    const rates = instructions[1]?.data as { rate_train: BN | null; rate_inference: BN | null }
    expect(rates.rate_train?.toString()).toBe('9000')
    expect(rates.rate_inference).toBeNull()
  })

  it('treats a free rate as the work’s own, not as inherited', async () => {
    const { fake } = chain(await registered(ALICE))
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(0n, 0n), {
      chain: fake,
      origin: origin(BODY),
    })
    if (!result.ok) throw new Error(result.reason)
    const { instructions } = decoded(result.prepared.transaction)
    expect(instructions.map((ix) => ix?.name)).toEqual(['register_work', 'set_work_rates'])
  })

  it('refuses a source that is not canonical, before reading the chain', async () => {
    const { reads, fake } = chain(await registered(ALICE))
    for (const source of [
      'http://tide-notes.test/2026/neap-tides.html',
      'https://tide-notes.test/',
      'https://Tide-Notes.test/2026/neap-tides.html',
      'https://tide-notes.test/a#part',
      'not a url',
    ]) {
      const result = await prepareRegistration(
        ALICE.toBase58(),
        { ...workRequest(null, null), source },
        { chain: fake, origin: origin(BODY) },
      )
      expect(result, source).toEqual({ ok: false, reason: 'source-not-canonical' })
    }
    expect(reads).toEqual([])
  })

  it('refuses a work whose host has no domain yet', async () => {
    const { fake } = chain(new Map())
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
      chain: fake,
      origin: origin(BODY),
    })
    expect(result).toEqual({ ok: false, reason: 'domain-missing' })
  })

  it('refuses a work under a domain another wallet owns, without fetching it', async () => {
    const { fake } = chain(await registered(BOB))
    const content = origin(BODY)
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
      chain: fake,
      origin: content,
    })
    expect(result).toEqual({ ok: false, reason: 'domain-not-yours' })
    expect(content.asked).toEqual([])
  })

  it('refuses a source that is already registered', async () => {
    const { fake } = chain(await registered(ALICE, true))
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
      chain: fake,
      origin: origin(BODY),
    })
    expect(result).toEqual({ ok: false, reason: 'source-taken' })
  })

  it('refuses a source the origin cannot serve, since no agent could be served it either', async () => {
    const { fake } = chain(await registered(ALICE))
    const result = await prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
      chain: fake,
      origin: origin(new Error(`origin answered 404 for ${SOURCE}`)),
    })
    expect(result).toEqual({ ok: false, reason: 'source-unreachable' })
  })

  it('fails when the chain cannot be read, rather than guessing the source is free', async () => {
    const fake: RegistrationChain = {
      getMultipleAccountsInfo: async () => {
        throw new Error('429 Too Many Requests')
      },
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    }
    await expect(
      prepareRegistration(ALICE.toBase58(), workRequest(null, null), {
        chain: fake,
        origin: origin(BODY),
      }),
    ).rejects.toThrow('429')
  })
})

describe('registrationStatus', () => {
  const SIGNATURE = '5'.repeat(88)

  function signatures(
    status: Awaited<ReturnType<SignatureChain['getSignatureStatuses']>>['value'][number],
    height = 100,
  ) {
    const order: string[] = []
    const fake: SignatureChain = {
      getBlockHeight: async () => {
        order.push('height')
        return height
      },
      getSignatureStatuses: async (list) => {
        order.push('status')
        expect(list).toEqual([SIGNATURE])
        return { context: { slot: 1 }, value: [status] }
      },
    }
    return { order, fake }
  }

  const landed = (
    confirmationStatus: 'processed' | 'confirmed' | 'finalized',
    err: unknown = null,
  ) => ({
    slot: 1,
    confirmations: null,
    err: err as never,
    confirmationStatus,
  })

  it('is confirmed once the cluster confirms it, and pending while only processed', async () => {
    for (const level of ['confirmed', 'finalized'] as const) {
      const { fake } = signatures(landed(level))
      expect(await registrationStatus(SIGNATURE, 150, fake)).toEqual({ state: 'confirmed' })
    }
    const { fake } = signatures(landed('processed'))
    expect(await registrationStatus(SIGNATURE, 150, fake)).toEqual({ state: 'pending' })
  })

  it('is pending while unseen and the blockhash is still valid', async () => {
    const { fake } = signatures(null, 150)
    expect(await registrationStatus(SIGNATURE, 150, fake)).toEqual({ state: 'pending' })
  })

  it('is expired when unseen past its last valid block height, read before the status', async () => {
    const { order, fake } = signatures(null, 151)
    expect(await registrationStatus(SIGNATURE, 150, fake)).toEqual({ state: 'expired' })
    expect(order).toEqual(['height', 'status'])
  })

  it('names the reason a landed registration failed', async () => {
    const cases: Array<[unknown, string]> = [
      [{ InstructionError: [0, { Custom: 0 }] }, 'already-registered'],
      [{ InstructionError: [1, { Custom: 6004 }] }, 'unauthorized'],
      [{ InstructionError: [0, { Custom: 6003 }] }, 'host-not-canonical'],
      [{ InstructionError: [0, { Custom: 6005 }] }, 'host-not-canonical'],
      [{ InstructionError: [0, { Custom: 3012 }] }, 'rejected'],
      [{ InstructionError: [0, 'ProgramFailedToComplete'] }, 'rejected'],
      ['InsufficientFundsForFee', 'rejected'],
    ]
    for (const [err, reason] of cases) {
      const { fake } = signatures(landed('confirmed', err))
      expect(await registrationStatus(SIGNATURE, 150, fake), JSON.stringify(err)).toEqual({
        state: 'failed',
        reason,
      })
    }
  })
})
