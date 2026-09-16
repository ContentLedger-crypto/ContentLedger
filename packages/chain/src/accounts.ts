import type { BN } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'
import type { LicenceStatus } from './instructions.js'
import { coder } from './program.js'

/**
 * Декодери акаунтів.
 *
 * Поля з кодека приходять під іменами IDL (snake_case), а варіанти enum —
 * PascalCase; camelCase тут дав би `undefined` без жодної помилки.
 *
 * Кожен віддає **прикладну** форму, а не сиру anchor'івську: `u64` стає
 * `bigint` (Rules Check вимагає беззастережно — `BN` і `number` до грошей не
 * підпускаються), ключі стають base58-рядками, `{ active: {} }` стає `'active'`,
 * а `[u8; 32]` — hex-рядком. Інакше кожен споживач робив би це сам, і робив би
 * по-різному.
 */

export interface Config {
  authority: string
  treasuryAta: string
  mint: string
  protocolFeeBps: number
  nodeShareBps: number
  voucherGraceS: bigint
  paused: boolean
  bump: number
}

export interface Domain {
  owner: string
  payoutOwner: string
  host: string
  rateTrain: bigint
  rateInference: bigint
  status: LicenceStatus
  bump: number
}

export interface Work {
  domain: string
  sourceHash: string
  contentHash: string
  rateTrain: bigint | null
  rateInference: bigint | null
  status: LicenceStatus
  attestedBy: number
  bump: number
}

const big = (value: BN): bigint => BigInt(value.toString())

const optionalBig = (value: BN | null): bigint | null => (value === null ? null : big(value))

const key = (value: PublicKey): string => value.toBase58()

const hex = (bytes: number[] | Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const licenceStatus = (value: Record<string, unknown>): LicenceStatus =>
  'Active' in value ? 'active' : 'suspended'

// biome-ignore lint/suspicious/noExplicitAny: форма приходить від anchor-кодека
const raw = (name: string, data: Uint8Array): any => coder.accounts.decode(name, Buffer.from(data))

export function decodeConfig(data: Uint8Array): Config {
  const account = raw('Config', data)
  return {
    authority: key(account.authority),
    treasuryAta: key(account.treasury_ata),
    mint: key(account.mint),
    protocolFeeBps: account.protocol_fee_bps,
    nodeShareBps: account.node_share_bps,
    voucherGraceS: big(account.voucher_grace_s),
    paused: account.paused,
    bump: account.bump,
  }
}

export function decodeDomain(data: Uint8Array): Domain {
  const account = raw('Domain', data)
  return {
    owner: key(account.owner),
    payoutOwner: key(account.payout_owner),
    host: account.host,
    rateTrain: big(account.rate_train),
    rateInference: big(account.rate_inference),
    status: licenceStatus(account.status),
    bump: account.bump,
  }
}

export function decodeWork(data: Uint8Array): Work {
  const account = raw('Work', data)
  return {
    domain: key(account.domain),
    sourceHash: hex(account.source_hash),
    contentHash: hex(account.content_hash),
    rateTrain: optionalBig(account.rate_train),
    rateInference: optionalBig(account.rate_inference),
    status: licenceStatus(account.status),
    attestedBy: account.attested_by,
    bump: account.bump,
  }
}
