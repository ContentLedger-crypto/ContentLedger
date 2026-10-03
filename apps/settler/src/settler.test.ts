import {
  type Config,
  type Domain,
  decodeInstruction,
  domainPda,
  type Escrow,
  escrowPda,
} from '@contentledger/chain'
import { batches, domains, MIGRATIONS_DIR, receipts, vouchers, works } from '@contentledger/db'
import { chainGenesis, chainStep, merkleRoot } from '@contentledger/shared'
import { PGlite } from '@electric-sql/pglite'
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { asc, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChainState, FoundSettlement, SettlementChain } from './chain.js'
import { settleAll } from './settler.js'

const HOSTS = ['acme-news.test', 'devblog.test', 'kyiv-photo.test', 'fourth.test']
const NOW = new Date('2026-10-03T12:00:00.000Z')
const operator = Keypair.generate().publicKey
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const at = <T>(items: readonly T[], i: number): T => {
  const item = items[i]
  if (item === undefined) throw new Error(`no item ${i}`)
  return item
}
const genesisOf = (agent: PublicKey) => chainGenesis(escrowPda(agent)[0].toBytes())

let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  const client = new PGlite()
  await client.exec('create role anon; create role authenticated;')
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(async () => {
  await db.execute(sql`truncate vouchers, receipts, batches, works, domains cascade`)
  for (const host of HOSTS) {
    await db.insert(domains).values({
      host,
      owner: operator.toBase58(),
      payoutOwner: operator.toBase58(),
      rateTrain: 2000n,
      rateInference: 500n,
      status: 'active',
      slot: 1n,
    })
    await db.insert(works).values({
      id: `work-${host}`,
      host,
      sourceId: `https://${host}/a`,
      contentHash: '22'.repeat(32),
      status: 'active',
      mediaType: 'text/html',
      byteLen: 10,
      slot: 1n,
    })
  }
})

interface Issued {
  leaves: Uint8Array[]
  chains: Uint8Array[]
  cumulative: bigint
}

/** Vouchers the gateway would have accepted: each chain folds the previous over its leaf. */
async function issue(
  agent: PublicKey,
  lines: readonly { host?: string; tariff?: bigint; ageS?: number }[],
): Promise<Issued> {
  let chain = genesisOf(agent)
  let cumulative = 0n
  const issued: Issued = { leaves: [], chains: [], cumulative }
  for (const [i, { host = HOSTS[0], tariff = 2000n, ageS = 0 }] of lines.entries()) {
    const seq = i + 1
    const leaf = new Uint8Array(32).fill(seq)
    leaf.set(agent.toBytes().subarray(0, 8))
    chain = chainStep(chain, leaf)
    cumulative += tariff + tariff / 10n
    const acceptedTs = new Date(NOW.getTime() - ageS * 1000)
    await db.insert(receipts).values({
      id: hex(leaf),
      consumer: agent.toBase58(),
      workId: `work-${host}`,
      useType: 'train',
      tariff,
      fee: tariff / 10n,
      rateLevel: 'domain',
      servedHash: '22'.repeat(32),
      registryHash: '22'.repeat(32),
      hashMatch: true,
      paymentMethod: 'escrow',
      acceptedAt: acceptedTs.toISOString(),
      acceptedTs,
    })
    await db.insert(vouchers).values({
      consumer: agent.toBase58(),
      seq: BigInt(seq),
      cumulative,
      chain: hex(chain),
      signature: '1'.repeat(64),
      receiptId: hex(leaf),
    })
    issued.leaves.push(leaf)
    issued.chains.push(chain)
  }
  return { ...issued, cumulative }
}

const CONFIG: Config = {
  authority: operator.toBase58(),
  treasuryAta: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  protocolFeeBps: 1000,
  nodeShareBps: 0,
  voucherGraceS: 900n,
  paused: false,
  bump: 255,
}

const escrowAt = (
  agent: PublicKey,
  lastSeq = 0n,
  lastChain: Uint8Array = new Uint8Array(32),
): Escrow => ({
  consumer: agent.toBase58(),
  vault: Keypair.generate().publicKey.toBase58(),
  settledTotal: 0n,
  lastSeq,
  lastChain: hex(lastChain),
  withdrawAfter: 0n,
  bump: 254,
  vaultBump: 253,
})

/** Stands in for the network the way the program does: a settlement moves the escrow on. */
function fakeChain(escrows: Map<string, Escrow>, found: FoundSettlement | null = null) {
  const submitted: TransactionInstruction[][] = []
  const failFor = new Set<string>()
  const chain: SettlementChain = {
    async read(consumer, wanted): Promise<ChainState> {
      const domainsFound = new Map<string, Domain>(
        wanted.map((domain) => [
          domain,
          {
            owner: operator.toBase58(),
            // A wallet of its own per publisher: a shared one dedupes in the packet.
            payoutOwner: Keypair.generate().publicKey.toBase58(),
            host: 'x',
            rateTrain: 0n,
            rateInference: 0n,
            status: 'active',
            bump: 1,
          },
        ]),
      )
      return { config: CONFIG, escrow: escrows.get(consumer) ?? null, domains: domainsFound }
    },
    async submit(instructions) {
      const settle = instructions[1]
      if (settle === undefined) throw new Error('no settle_batch')
      const consumer = new PublicKey(instructions[0]?.data.subarray(16, 48) ?? []).toBase58()
      if (failFor.has(consumer)) throw new Error('blockhash expired')
      submitted.push([...instructions])
      const { data } = decodeInstruction(settle)
      const escrow = escrows.get(consumer)
      if (escrow === undefined) throw new Error('no escrow')
      escrows.set(consumer, {
        ...escrow,
        lastSeq: data.seq,
        settledTotal: data.cumulative,
        lastChain: hex(Uint8Array.from(data.chain)),
      })
      return `settled-${submitted.length}`
    },
    async findSettlement() {
      return found
    },
  }
  return { chain, submitted, failFor }
}

function run(
  chain: SettlementChain,
  policy: Partial<{ minReceipts: number; maxAgeMs: number; maxReceipts: number }> = {},
) {
  const logged: { level: string; message: string; fields: Record<string, unknown> }[] = []
  return {
    logged,
    done: settleAll({
      db,
      chain,
      operator,
      policy: { minReceipts: 3, maxAgeMs: 300_000, maxReceipts: 50, ...policy },
      now: () => NOW,
      log: (level, message, fields) => logged.push({ level, message, fields }),
    }),
  }
}

const settleArgs = (instructions: TransactionInstruction[] | undefined) =>
  decodeInstruction((instructions ?? [])[1] as TransactionInstruction).data

describe('settleAll', () => {
  it('settles a due agent and publishes the batch it anchored', async () => {
    const agent = Keypair.generate().publicKey
    const issued = await issue(agent, [
      { tariff: 2000n },
      { host: HOSTS[1], tariff: 500n },
      { tariff: 2000n },
    ])
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrowAt(agent)]]))

    await run(chain).done

    expect(submitted).toHaveLength(1)
    const args = settleArgs(submitted[0])
    expect(args.seq).toBe(3n)
    expect(args.cumulative).toBe(issued.cumulative)
    expect(args.chain).toEqual(Array.from(issued.chains[2] ?? []))
    expect(args.root).toEqual(Array.from(merkleRoot(issued.leaves)))
    expect(args.tariffs).toEqual([4000n, 500n])

    const [batch] = await db.select().from(batches)
    expect(batch).toMatchObject({ seqFrom: 1n, seqTo: 3n, txSig: 'settled-1' })
    const settled = await db.select({ settledAt: receipts.settledAt }).from(receipts)
    expect(settled.every((row) => row.settledAt?.getTime() === NOW.getTime())).toBe(true)
  })

  it('waits while an agent has few and fresh receipts', async () => {
    const agent = Keypair.generate().publicKey
    await issue(agent, [{}, {}])
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrowAt(agent)]]))

    await run(chain).done

    expect(submitted).toEqual([])
    expect(await db.select().from(batches)).toEqual([])
  })

  it('settles a single receipt at once when the agent has asked to withdraw', async () => {
    const agent = Keypair.generate().publicKey
    await issue(agent, [{}])
    const escrow = { ...escrowAt(agent), withdrawAfter: 1_791_000_900n }
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrow]]))

    await run(chain).done

    expect(submitted).toHaveLength(1)
  })

  it('splits four recipients over two transactions in one pass', async () => {
    const agent = Keypair.generate().publicKey
    await issue(
      agent,
      HOSTS.map((host) => ({ host })),
    )
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrowAt(agent)]]))

    await run(chain, { minReceipts: 1 }).done

    expect(submitted.map((ixs) => settleArgs(ixs).seq)).toEqual([3n, 4n])
    expect(
      (await db.select().from(batches).orderBy(asc(batches.seqTo))).map((b) => [
        b.seqFrom,
        b.seqTo,
      ]),
    ).toEqual([
      [1n, 3n],
      [4n, 4n],
    ])
  })

  it('records nothing for an agent whose settlement fails and goes on to the next', async () => {
    const failing = Keypair.generate().publicKey
    const healthy = Keypair.generate().publicKey
    await issue(failing, [{}, {}, {}])
    await issue(healthy, [{}, {}, {}])
    const { chain, submitted, failFor } = fakeChain(
      new Map([
        [failing.toBase58(), escrowAt(failing)],
        [healthy.toBase58(), escrowAt(healthy)],
      ]),
    )
    failFor.add(failing.toBase58())

    const { done, logged } = run(chain)
    await done

    expect(submitted).toHaveLength(1)
    expect((await db.select().from(batches)).map((b) => b.consumer)).toEqual([healthy.toBase58()])
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ consumer: failing.toBase58() }),
      }),
    )
  })

  // The transaction landed but the batch was never written: the chain is ahead of the
  // database, and the settler publishes what it already paid before paying anything else.
  it('recovers a landed settlement it did not record, without paying it again', async () => {
    const agent = Keypair.generate().publicKey
    const issued = await issue(agent, [{}, {}, {}])
    const escrow = escrowAt(agent, 2n, at(issued.chains, 1))
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrow]]), {
      txSig: 'landed',
      root: hex(merkleRoot(issued.leaves.slice(0, 2))),
      settledAt: new Date('2026-10-03T11:59:00.000Z'),
    })

    await run(chain).done

    expect(submitted).toEqual([])
    expect(await db.select().from(batches)).toEqual([
      expect.objectContaining({ seqFrom: 1n, seqTo: 2n, txSig: 'landed' }),
    ])
    const settledAt = await db
      .select({ settledAt: receipts.settledAt })
      .from(receipts)
      .orderBy(asc(receipts.acceptedTs))
    expect(settledAt.filter((row) => row.settledAt !== null)).toHaveLength(2)
  })

  it('publishes nothing when the landed root is not the one the vouchers give', async () => {
    const agent = Keypair.generate().publicKey
    const issued = await issue(agent, [{}, {}, {}])
    const escrow = escrowAt(agent, 2n, at(issued.chains, 1))
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrow]]), {
      txSig: 'landed',
      root: '00'.repeat(32),
      settledAt: NOW,
    })

    const { done, logged } = run(chain, { minReceipts: 1 })
    await done

    expect(submitted).toEqual([])
    expect(await db.select().from(batches)).toEqual([])
    expect(logged.map((entry) => entry.level)).toContain('error')
  })

  it('pays nothing while the landed settlement cannot be found', async () => {
    const agent = Keypair.generate().publicKey
    const issued = await issue(agent, [{}, {}, {}])
    const escrow = escrowAt(agent, 2n, at(issued.chains, 1))
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrow]]))

    const { done, logged } = run(chain, { minReceipts: 1 })
    await done

    expect(submitted).toEqual([])
    expect(await db.select().from(batches)).toEqual([])
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ error: expect.stringMatching(/no transaction found/) }),
      }),
    )
  })

  it('pays nothing for vouchers of an escrow that does not exist', async () => {
    const agent = Keypair.generate().publicKey
    await issue(agent, [{}, {}, {}])
    const { chain, submitted } = fakeChain(new Map())

    const { done, logged } = run(chain)
    await done

    expect(submitted).toEqual([])
    expect(logged.map((entry) => entry.level)).toContain('error')
  })

  it('leaves the domain of every leg to the work the receipt was for', async () => {
    const agent = Keypair.generate().publicKey
    await issue(agent, [{ host: HOSTS[2] }, {}, {}])
    const { chain, submitted } = fakeChain(new Map([[agent.toBase58(), escrowAt(agent)]]))

    await run(chain).done

    const legs = (submitted[0]?.[1]?.keys ?? []).slice(11)
    expect([legs[0]?.pubkey, legs[3]?.pubkey].map((key) => key?.toBase58())).toEqual([
      domainPda(HOSTS[2] ?? '')[0].toBase58(),
      domainPda(HOSTS[0] ?? '')[0].toBase58(),
    ])
  })
})
