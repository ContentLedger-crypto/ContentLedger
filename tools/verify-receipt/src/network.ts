import {
  coder,
  decodeSettlementLog,
  decodeWork,
  PROGRAM_ID,
  type SettlementEntry,
  settlementLogPda,
} from '@contentledger/chain'
import { type BN, utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

export interface Leg {
  domain: string
  tariff: bigint
}

/** What a `settle_batch` transaction anchored and moved, as the cluster recorded it. */
export interface Settlement {
  succeeded: boolean
  escrow: string
  seq: bigint
  chain: string
  root: string
  legs: Leg[]
  vaultDebit: bigint
  treasuryCredit: bigint
}

/** The only source a verifier trusts: everything here is read back from the cluster. */
export interface Network {
  /** Occupied entries of the escrow's ring; empty when it has never settled. */
  ring(escrow: string): Promise<readonly SettlementEntry[]>
  /** `null` when the node has no such finalized transaction, or it holds no `settle_batch`. */
  settlement(signature: string): Promise<Settlement | null>
  /** Domain of each work account the program owns; any other key is left out. */
  workDomains(works: readonly string[]): Promise<ReadonlyMap<string, string>>
}

const rpcAnswer = z.union([
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ result: z.unknown() }),
])

const account = z.object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) })

const accountInfo = z.object({ value: account.nullable() })

const multipleAccounts = z.object({ value: z.array(account.nullable()) })

const tokenBalance = z.object({
  accountIndex: z.number().int(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
})

const settlementTransaction = z.object({
  meta: z.object({
    err: z.unknown(),
    preTokenBalances: z.array(tokenBalance),
    postTokenBalances: z.array(tokenBalance),
  }),
  transaction: z.object({
    message: z.object({
      accountKeys: z.array(z.string()),
      instructions: z.array(
        z.object({
          programIdIndex: z.number().int(),
          accounts: z.array(z.number().int()),
          data: z.string(),
        }),
      ),
    }),
  }),
})

// Positions in `SettleBatch`; the payout legs follow the named accounts in threes.
const ESCROW_ACCOUNT = 2
const VAULT_ACCOUNT = 3
const TREASURY_ACCOUNT = 4
const NAMED_ACCOUNTS = 11
const ACCOUNTS_PER_LEG = 3

const programOwned = (owner: string): boolean => owner === PROGRAM_ID.toBase58()

const accountData = ({ data }: z.infer<typeof account>): Uint8Array =>
  new Uint8Array(Buffer.from(data[0], 'base64'))

export function parseSettlement(raw: unknown): Settlement | null {
  const { meta, transaction } = settlementTransaction.parse(raw)
  const keys = transaction.message.accountKeys
  const keyAt = (index: number | undefined): string => {
    const found = index === undefined ? undefined : keys[index]
    if (found === undefined) throw new Error(`settlement names no account at index ${index}`)
    return found
  }

  for (const instruction of transaction.message.instructions) {
    if (keyAt(instruction.programIdIndex) !== PROGRAM_ID.toBase58()) continue
    const decoded = coder.instruction.decode(Buffer.from(utils.bytes.bs58.decode(instruction.data)))
    if (decoded?.name !== 'settle_batch') continue
    const args = decoded.data as { seq: BN; chain: number[]; root: number[]; tariffs: BN[] }
    const accounts = instruction.accounts
    // A token account the transaction creates has no balance before it.
    const balance = (list: z.infer<typeof tokenBalance>[], position: number): bigint => {
      const index = accounts[position]
      const entry = list.find((item) => item.accountIndex === index)
      return entry === undefined ? 0n : BigInt(entry.uiTokenAmount.amount)
    }
    return {
      succeeded: meta.err === null,
      escrow: keyAt(accounts[ESCROW_ACCOUNT]),
      seq: BigInt(args.seq.toString()),
      chain: Buffer.from(args.chain).toString('hex'),
      root: Buffer.from(args.root).toString('hex'),
      legs: args.tariffs.map((tariff, i) => ({
        domain: keyAt(accounts[NAMED_ACCOUNTS + i * ACCOUNTS_PER_LEG]),
        tariff: BigInt(tariff.toString()),
      })),
      vaultDebit:
        balance(meta.preTokenBalances, VAULT_ACCOUNT) -
        balance(meta.postTokenBalances, VAULT_ACCOUNT),
      treasuryCredit:
        balance(meta.postTokenBalances, TREASURY_ACCOUNT) -
        balance(meta.preTokenBalances, TREASURY_ACCOUNT),
    }
  }
  return null
}

/**
 * Raw JSON-RPC rather than `Connection`, so the answer is checked against the shape this
 * file reads instead of trusted to it. Everything is read at `finalized`: a verdict on a
 * batch that could still be rolled back is no verdict.
 */
export function rpcNetwork(rpcUrl: string, fetchImpl: typeof fetch = fetch): Network {
  async function call(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`)
    const answer = rpcAnswer.parse(await response.json())
    if ('error' in answer) {
      throw new Error(`${method} failed: ${answer.error.code} ${answer.error.message}`)
    }
    return answer.result
  }

  return {
    async ring(escrow) {
      const log = settlementLogPda(new PublicKey(escrow))[0].toBase58()
      const { value } = accountInfo.parse(
        await call('getAccountInfo', [log, { encoding: 'base64', commitment: 'finalized' }]),
      )
      return value !== null && programOwned(value.owner)
        ? decodeSettlementLog(accountData(value)).entries
        : []
    },

    async settlement(signature) {
      const raw = await call('getTransaction', [
        signature,
        { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ])
      return raw === null ? null : parseSettlement(raw)
    },

    async workDomains(works) {
      const { value } = multipleAccounts.parse(
        await call('getMultipleAccounts', [works, { encoding: 'base64', commitment: 'finalized' }]),
      )
      const domains = new Map<string, string>()
      works.forEach((work, i) => {
        const info = value[i]
        if (info && programOwned(info.owner))
          domains.set(work, decodeWork(accountData(info)).domain)
      })
      return domains
    },
  }
}
