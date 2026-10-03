import { voucherMessage } from '@contentledger/shared'
import { BN } from '@coral-xyz/anchor'
import {
  Ed25519Program,
  type PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  type TransactionInstruction,
  TransactionInstruction as Web3TransactionInstruction,
} from '@solana/web3.js'
import { hostSeed, sourceSeed } from './identifiers.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  configPda,
  domainPda,
  escrowPda,
  settlementLogPda,
  TOKEN_PROGRAM_ID,
  vaultPda,
  workPda,
} from './pda.js'
import { coder, IDL, PROGRAM_ID } from './program.js'

/**
 * Білдери інструкцій.
 *
 * **Імена полів для кодека — snake_case, як в IDL, а варіанти enum —
 * PascalCase.** Це не косметика: на camelCase anchor-кодувальник не падає, а
 * мовчки пише нулі й віддає буфер правильної довжини. `register_domain` із
 * camelCase дає ті самі 127 байтів, але з нульовим `host_hash` і нульовими
 * ставками — тобто валідну транзакцію, яка робить не те.
 *
 * Тому тут два незалежні запобіжники: `build` звіряє набір полів із IDL перед
 * кодуванням, а кожен білдер має тест на зворотне декодування значень.
 */

export type LicenceStatus = 'active' | 'suspended'

const status = (value: LicenceStatus) => (value === 'active' ? { Active: {} } : { Suspended: {} })

const u64 = (value: bigint) => new BN(value.toString())

const optionalU64 = (value: bigint | null) => (value === null ? null : u64(value))

/** Імена аргументів кожної інструкції, узяті з IDL, а не переписані руками. */
const argumentNames = new Map<string, string[]>(
  IDL.instructions.map((instruction) => [
    instruction.name,
    instruction.args.map((argument) => argument.name),
  ]),
)

const build = (name: string, data: Record<string, unknown>, keys: AccountMetaLike[]) => {
  const expected = argumentNames.get(name)
  if (expected === undefined) {
    throw new TypeError(`інструкції ${name} немає в IDL`)
  }
  for (const field of expected) {
    if (!(field in data)) {
      throw new TypeError(`поле ${field} не передане в ${name}: кодек записав би нуль`)
    }
  }

  return new Web3TransactionInstruction({
    programId: PROGRAM_ID,
    keys: keys.map(({ pubkey, isSigner = false, isWritable = false }) => ({
      pubkey,
      isSigner,
      isWritable,
    })),
    data: coder.instruction.encode(name, data),
  })
}

interface AccountMetaLike {
  pubkey: PublicKey
  isSigner?: boolean
  isWritable?: boolean
}

export interface InitConfigArgs {
  authority: PublicKey
  mint: PublicKey
  treasuryAta: PublicKey
  protocolFeeBps: number
  nodeShareBps: number
  voucherGraceS: bigint
}

export function buildInitConfig(args: InitConfigArgs): TransactionInstruction {
  return build(
    'init_config',
    {
      protocol_fee_bps: args.protocolFeeBps,
      node_share_bps: args.nodeShareBps,
      voucher_grace_s: u64(args.voucherGraceS),
    },
    [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: configPda()[0], isWritable: true },
      { pubkey: args.mint },
      { pubkey: args.treasuryAta },
      { pubkey: SystemProgram.programId },
    ],
  )
}

export interface RegisterDomainArgs {
  payer: PublicKey
  host: string
  owner: PublicKey
  payoutOwner: PublicKey
  rateTrain: bigint
  rateInference: bigint
}

export function buildRegisterDomain(args: RegisterDomainArgs): TransactionInstruction {
  return build(
    'register_domain',
    {
      host_hash: Array.from(hostSeed(args.host)),
      host: args.host,
      owner: args.owner,
      payout_owner: args.payoutOwner,
      rate_train: u64(args.rateTrain),
      rate_inference: u64(args.rateInference),
    },
    [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: configPda()[0] },
      { pubkey: domainPda(args.host)[0], isWritable: true },
      { pubkey: SystemProgram.programId },
    ],
  )
}

export interface RegisterWorkArgs {
  payer: PublicKey
  host: string
  source: string
  contentHash: Uint8Array
}

export function buildRegisterWork(args: RegisterWorkArgs): TransactionInstruction {
  return build(
    'register_work',
    {
      source_hash: Array.from(sourceSeed(args.source)),
      content_hash: Array.from(args.contentHash),
    },
    [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: configPda()[0] },
      { pubkey: domainPda(args.host)[0] },
      { pubkey: workPda(args.source)[0], isWritable: true },
      { pubkey: SystemProgram.programId },
    ],
  )
}

const updateDomainKeys = (owner: PublicKey, host: string): AccountMetaLike[] => [
  { pubkey: owner, isSigner: true },
  { pubkey: domainPda(host)[0], isWritable: true },
]

const updateWorkKeys = (owner: PublicKey, host: string, source: string): AccountMetaLike[] => [
  { pubkey: owner, isSigner: true },
  { pubkey: domainPda(host)[0] },
  { pubkey: workPda(source)[0], isWritable: true },
]

export function buildSetDomainRates(args: {
  owner: PublicKey
  host: string
  rateTrain: bigint
  rateInference: bigint
}): TransactionInstruction {
  return build(
    'set_domain_rates',
    { rate_train: u64(args.rateTrain), rate_inference: u64(args.rateInference) },
    updateDomainKeys(args.owner, args.host),
  )
}

export function buildSetDomainStatus(args: {
  owner: PublicKey
  host: string
  status: LicenceStatus
}): TransactionInstruction {
  return build(
    'set_domain_status',
    { status: status(args.status) },
    updateDomainKeys(args.owner, args.host),
  )
}

export function buildSetWorkRates(args: {
  owner: PublicKey
  host: string
  source: string
  rateTrain: bigint | null
  rateInference: bigint | null
}): TransactionInstruction {
  return build(
    'set_work_rates',
    { rate_train: optionalU64(args.rateTrain), rate_inference: optionalU64(args.rateInference) },
    updateWorkKeys(args.owner, args.host, args.source),
  )
}

export function buildSetWorkStatus(args: {
  owner: PublicKey
  host: string
  source: string
  status: LicenceStatus
}): TransactionInstruction {
  return build(
    'set_work_status',
    { status: status(args.status) },
    updateWorkKeys(args.owner, args.host, args.source),
  )
}

export function buildOpenEscrow(args: {
  consumer: PublicKey
  mint: PublicKey
}): TransactionInstruction {
  const [escrow] = escrowPda(args.consumer)
  return build('open_escrow', {}, [
    { pubkey: args.consumer, isSigner: true, isWritable: true },
    { pubkey: configPda()[0] },
    { pubkey: escrow, isWritable: true },
    { pubkey: args.mint },
    { pubkey: vaultPda(escrow)[0], isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID },
    { pubkey: SystemProgram.programId },
  ])
}

export function buildDeposit(args: {
  consumer: PublicKey
  source: PublicKey
  amount: bigint
}): TransactionInstruction {
  const [escrow] = escrowPda(args.consumer)
  return build('deposit', { amount: u64(args.amount) }, [
    { pubkey: args.consumer, isSigner: true },
    { pubkey: escrow, isWritable: true },
    { pubkey: vaultPda(escrow)[0], isWritable: true },
    { pubkey: args.source, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID },
  ])
}

export interface SettleBatchArgs {
  authority: PublicKey
  consumer: PublicKey
  mint: PublicKey
  treasuryAta: PublicKey
  /** The last voucher of the batch, as the agent signed it. */
  voucher: { seq: bigint; cumulative: bigint; chain: Uint8Array; signature: Uint8Array }
  root: Uint8Array
  legs: readonly { domain: PublicKey; payoutOwner: PublicKey; tariff: bigint }[]
}

/**
 * The verification and the settlement come as a pair because the program reads its
 * consent out of the first: both are built from the same voucher fields here, so the
 * 88 bytes the runtime verifies are the 88 bytes `settle.rs` rebuilds.
 */
export function buildSettleBatch(
  args: SettleBatchArgs,
): [verification: TransactionInstruction, settle: TransactionInstruction] {
  const [escrow] = escrowPda(args.consumer)
  const { seq, cumulative, chain, signature } = args.voucher
  const verification = Ed25519Program.createInstructionWithPublicKey({
    publicKey: args.consumer.toBytes(),
    message: voucherMessage({ escrow: escrow.toBytes(), seq, cumulative, chain }),
    signature,
  })
  const settle = build(
    'settle_batch',
    {
      seq: u64(seq),
      cumulative: u64(cumulative),
      chain: Array.from(chain),
      root: Array.from(args.root),
      tariffs: args.legs.map((leg) => u64(leg.tariff)),
    },
    [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: configPda()[0] },
      { pubkey: escrow, isWritable: true },
      { pubkey: vaultPda(escrow)[0], isWritable: true },
      { pubkey: args.treasuryAta, isWritable: true },
      { pubkey: args.mint },
      { pubkey: settlementLogPda(escrow)[0], isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
      { pubkey: TOKEN_PROGRAM_ID },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID },
      { pubkey: SystemProgram.programId },
      ...args.legs.flatMap((leg) => [
        { pubkey: leg.domain },
        { pubkey: leg.payoutOwner },
        { pubkey: associatedTokenAddress(leg.payoutOwner, args.mint), isWritable: true },
      ]),
    ],
  )
  return [verification, settle]
}

/**
 * Зворотне декодування для тестів білдерів і для розбору чужих транзакцій.
 *
 * Ключі полів лишаються такими, як в IDL (snake_case) — власного перейменування
 * тут немає навмисно: воно було б третім місцем, де імена можуть розʼїхатися.
 * Значення нормалізуються: `BN` стає `bigint`, `PublicKey` — base58-рядком.
 */
export function decodeInstruction(instruction: TransactionInstruction): {
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: форма даних різна для кожної інструкції
  data: Record<string, any>
} {
  const decoded = coder.instruction.decode(Buffer.from(instruction.data))
  if (decoded === null) {
    throw new TypeError('інструкція не належить цій програмі')
  }
  return { name: decoded.name, data: plain(decoded.data as Record<string, unknown>) }
}

// biome-ignore lint/suspicious/noExplicitAny: рекурсивна нормалізація довільної форми
function plain(value: any): any {
  if (value instanceof BN) {
    return BigInt(value.toString())
  }
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'object' && 'toBase58' in value && typeof value.toBase58 === 'function') {
    return value.toBase58()
  }
  if (Array.isArray(value)) {
    return value.map(plain)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  }
  return value
}
