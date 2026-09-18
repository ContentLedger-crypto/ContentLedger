import { type Domain, decodeDomain, decodeWork, type Work } from '@contentledger/chain'
import {
  type Connection,
  type Keypair,
  type PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import type { RegistrySnapshot } from './diff.js'
import type { SeedStep } from './plan.js'

export interface SeedAccount {
  address: PublicKey
  kind: 'domain' | 'work'
}

/**
 * Тип акаунта береться з форми кроку (`'work' in step`), а не з імені виду.
 * За іменем `set_domain_status` не закінчується на `domain` і поїхав би в
 * декодер твору — на тому самому PDA, що й `register_domain` перед ним.
 */
export function seedAccounts(plan: SeedStep[]): SeedAccount[] {
  const accounts = new Map<string, SeedAccount>()

  for (const step of plan) {
    accounts.set(step.account.toBase58(), {
      address: step.account,
      kind: 'work' in step ? 'work' : 'domain',
    })
  }

  return [...accounts.values()]
}

/**
 * Один `getMultipleAccounts` на весь посів замість запиту на крок: акаунтів
 * пʼятнадцять, а безкоштовний ліміт RPC витрачається на демо (SC-008).
 */
export async function readRegistry(
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  plan: SeedStep[],
): Promise<RegistrySnapshot> {
  const accounts = seedAccounts(plan)
  const infos = await connection.getMultipleAccountsInfo(accounts.map(({ address }) => address))

  const domains = new Map<string, Domain>()
  const works = new Map<string, Work>()

  for (const [index, { address, kind }] of accounts.entries()) {
    const info = infos[index]
    if (info === null || info === undefined) {
      continue
    }

    const key = address.toBase58()
    if (kind === 'domain') {
      domains.set(key, decodeDomain(info.data))
    } else {
      works.set(key, decodeWork(info.data))
    }
  }

  return { domains, works }
}

/**
 * Комісію й ренту платить оператор навіть за кроки, які підписує видавець:
 * FR-010a каже, що вартість не перекладається на видавця в жодному вигляді,
 * тож ключі з корпусу тримають підпис, а не SOL.
 */
export function applyStep(
  connection: Connection,
  step: SeedStep,
  operator: Keypair,
  owners: ReadonlyMap<string, Keypair>,
): Promise<string> {
  const transaction = new Transaction().add(step.instruction)
  const signers = [operator]

  if (!step.signer.equals(operator.publicKey)) {
    const owner = owners.get(step.signer.toBase58())
    if (owner === undefined) {
      throw new Error(`немає ключа підписанта ${step.signer.toBase58()} для ${step.subject}`)
    }
    signers.push(owner)
  }

  return sendAndConfirmTransaction(connection, transaction, signers)
}
