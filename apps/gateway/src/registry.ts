import {
  type Config,
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
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'

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

export interface PaidRegistrySnapshot extends RegistrySnapshot {
  escrow: EscrowSnapshot | null
}

export interface RegistryReader {
  read(source: string): Promise<RegistrySnapshot>
}

export interface PaidRegistryReader extends RegistryReader {
  readWithEscrow(source: string, escrow: PublicKey): Promise<PaidRegistrySnapshot>
}

type AccountsReader = Pick<Connection, 'getMultipleAccountsInfo'>

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
    const [configInfo, domainInfo, workInfo, ...rest] = await connection.getMultipleAccountsInfo(
      [config, domain, work, ...extra],
      'confirmed',
    )
    if (!configInfo) throw new Error(`Config account ${config.toBase58()} does not exist`)

    const snapshot: RegistrySnapshot = {
      config: decodeConfig(configInfo.data),
      domain: domainInfo
        ? { address: domain.toBase58(), account: decodeDomain(domainInfo.data) }
        : null,
      work: workInfo ? { address: work.toBase58(), account: decodeWork(workInfo.data) } : null,
    }
    return { snapshot, rest }
  }

  return {
    async read(source) {
      return (await readAccounts(source, [])).snapshot
    },

    async readWithEscrow(source, escrow) {
      const vault = vaultPda(escrow)[0]
      const { snapshot, rest } = await readAccounts(source, [escrow, vault])
      return { ...snapshot, escrow: escrowSnapshot(escrow, rest[0] ?? null, rest[1] ?? null) }
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
