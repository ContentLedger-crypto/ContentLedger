import {
  type Config,
  coder,
  configPda,
  type Domain,
  decodeConfig,
  decodeDomain,
  decodeEscrow,
  decodeTokenAmount,
  decodeWork,
  domainPda,
  type Escrow,
  hostOf,
  PROGRAM_ID,
  vaultPda,
  type Work,
  workPda,
} from '@contentledger/chain'
import type { AccountInfo, Connection, GetProgramAccountsConfig, PublicKey } from '@solana/web3.js'

export interface Located<T> {
  address: string
  account: T
}

export interface RegistrySnapshot {
  config: Config
  /** The domain named by the source's host, not the one the work points at. */
  domain: Located<Domain> | null
  work: Located<Work> | null
}

export interface EscrowSnapshot {
  address: string
  account: Escrow
  /** Still holds every voucher signed above `settledTotal`. */
  vaultBalance: bigint
}

export interface SlottedRegistrySnapshot extends RegistrySnapshot {
  /** Orders the registry mirror written from this snapshot. */
  slot: bigint
}

export interface PaidRegistrySnapshot extends SlottedRegistrySnapshot {
  escrow: EscrowSnapshot | null
}

export interface RegistryReader {
  read(source: string): Promise<RegistrySnapshot>
}

export interface PaidRegistryReader extends RegistryReader {
  read(source: string): Promise<SlottedRegistrySnapshot>
  readWithEscrow(source: string, escrow: PublicKey): Promise<PaidRegistrySnapshot>
}

type AccountsReader = Pick<Connection, 'getMultipleAccountsInfoAndContext'>

/**
 * Read on every request rather than cached: a price the agent signs into a voucher
 * must be the one in force now (FR-004), and a cache fed by a dropped subscription
 * would serve a stale one without any error. The escrow rides in the same call, so
 * its balance is as fresh as the price at no extra RPC cost.
 */
export function rpcRegistry(connection: AccountsReader): PaidRegistryReader {
  const readAccounts = async (source: string, extra: PublicKey[]) => {
    const config = configPda()[0]
    const domain = domainPda(hostOf(source))[0]
    const work = workPda(source)[0]
    const { context, value } = await connection.getMultipleAccountsInfoAndContext(
      [config, domain, work, ...extra],
      'confirmed',
    )
    const [configInfo, domainInfo, workInfo, ...rest] = value
    if (!configInfo) throw new Error(`Config account ${config.toBase58()} does not exist`)

    const snapshot: RegistrySnapshot = {
      config: decodeConfig(configInfo.data),
      domain: domainInfo
        ? { address: domain.toBase58(), account: decodeDomain(domainInfo.data) }
        : null,
      work: workInfo ? { address: work.toBase58(), account: decodeWork(workInfo.data) } : null,
    }
    return { snapshot, rest, slot: BigInt(context.slot) }
  }

  return {
    async read(source) {
      const { snapshot, slot } = await readAccounts(source, [])
      return { ...snapshot, slot }
    },

    async readWithEscrow(source, escrow) {
      const vault = vaultPda(escrow)[0]
      const { snapshot, rest, slot } = await readAccounts(source, [escrow, vault])
      return {
        ...snapshot,
        escrow: escrowSnapshot(escrow, rest[0] ?? null, rest[1] ?? null),
        slot,
      }
    },
  }
}

function escrowSnapshot(
  address: PublicKey,
  escrowInfo: AccountInfo<Buffer> | null,
  vaultInfo: AccountInfo<Buffer> | null,
): EscrowSnapshot | null {
  // Anyone can send lamports to the escrow address before the agent opens it; that
  // leaves a system-owned empty account, which is still "no escrow".
  if (!escrowInfo?.owner.equals(PROGRAM_ID)) return null
  if (!vaultInfo) throw new Error(`Escrow ${address.toBase58()} has no vault account`)
  return {
    address: address.toBase58(),
    account: decodeEscrow(escrowInfo.data),
    vaultBalance: decodeTokenAmount(vaultInfo.data),
  }
}

export interface OwnedWorksReader {
  countWorks(owner: string): Promise<number>
}

interface ProgramAccountsReader {
  getProgramAccounts(
    programId: PublicKey,
    config: GetProgramAccountsConfig,
  ): Promise<ReadonlyArray<{ pubkey: PublicKey }>>
}

// Both accounts open with an 8-byte discriminator followed by the key we filter on:
// Domain.owner and Work.domain. The discriminator filter keeps an Escrow, whose
// consumer sits at the same offset, from passing for a domain.
const KEY_OFFSET = 8

/**
 * Read from the chain, not the database mirror: the mirror holds only works that have
 * been served, so a publisher who has just registered would be told they have none.
 */
export function rpcOwnedWorks(connection: ProgramAccountsReader): OwnedWorksReader {
  const addresses = (account: 'Domain' | 'Work', key: string) =>
    connection.getProgramAccounts(PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: coder.accounts.memcmp(account) as { offset: number; bytes: string } },
        { memcmp: { offset: KEY_OFFSET, bytes: key } },
      ],
    })

  return {
    async countWorks(owner) {
      const domains = await addresses('Domain', owner)
      const works = await Promise.all(
        domains.map(({ pubkey }) => addresses('Work', pubkey.toBase58())),
      )
      return works.reduce((sum, list) => sum + list.length, 0)
    },
  }
}
