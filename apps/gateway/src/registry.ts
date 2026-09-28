import {
  type Config,
  configPda,
  type Domain,
  decodeConfig,
  decodeDomain,
  decodeWork,
  domainPda,
  hostOf,
  type Work,
  workPda,
} from '@contentledger/chain'
import type { Connection } from '@solana/web3.js'

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

export interface RegistryReader {
  read(source: string): Promise<RegistrySnapshot>
}

type AccountsReader = Pick<Connection, 'getMultipleAccountsInfo'>

/**
 * Read on every request rather than cached: a price the agent signs into a voucher
 * must be the one in force now (FR-004), and a cache fed by a dropped subscription
 * would serve a stale one without any error.
 */
export function rpcRegistry(connection: AccountsReader): RegistryReader {
  return {
    async read(source) {
      const config = configPda()[0]
      const domain = domainPda(hostOf(source))[0]
      const work = workPda(source)[0]
      const [configInfo, domainInfo, workInfo] = await connection.getMultipleAccountsInfo(
        [config, domain, work],
        'confirmed',
      )
      if (!configInfo) throw new Error(`Config account ${config.toBase58()} does not exist`)

      return {
        config: decodeConfig(configInfo.data),
        domain: domainInfo
          ? { address: domain.toBase58(), account: decodeDomain(domainInfo.data) }
          : null,
        work: workInfo ? { address: work.toBase58(), account: decodeWork(workInfo.data) } : null,
      }
    },
  }
}
