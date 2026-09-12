import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { z } from 'zod'
import { leafHash } from './merkle.js'
import { usdcBaseUnitsSchema, useTypeSchema } from './money.js'

const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'expected a base58 pubkey')
const hex256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest')
const base58Signature = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/, 'expected a base58 transaction signature')

/** Один формат часу, бо два формати одного моменту дали б два різні хеші. */
const acceptedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'expected ISO-8601 UTC with milliseconds')

/** `seq` лишається числом тільки тому, що обмежений; гроші не обмежені ніколи. */
const seqSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

const issuedFields = {
  consumer: base58Key,
  work: base58Key,
  useType: useTypeSchema,
  tariff: usdcBaseUnitsSchema,
  fee: usdcBaseUnitsSchema,
  rateLevel: z.enum(['domain', 'work']),
  servedHash: hex256,
  registryHash: hex256,
  acceptedAt: acceptedAtSchema,
}

export const receiptBodySchema = z.discriminatedUnion('paymentMethod', [
  z.strictObject({ ...issuedFields, paymentMethod: z.literal('escrow'), seq: seqSchema }),
  z.strictObject({
    ...issuedFields,
    paymentMethod: z.literal('x402'),
    paymentRef: base58Signature,
  }),
])

export type ReceiptBody = z.infer<typeof receiptBodySchema>

/**
 * RFC 8785 для пласкої підмножини, якою є тіло квитанції: рядки й одне ціле.
 * Ключі сортує `Array.sort` за UTF-16 code units — рівно те, чого вимагає
 * специфікація; екранування рядків JCS означене через `JSON.stringify`.
 */
export function canonicalBody(body: ReceiptBody): Uint8Array {
  const parsed: Record<string, string | number> = receiptBodySchema.parse(body)
  const fields = Object.keys(parsed)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(parsed[key])}`)
  return utf8ToBytes(`{${fields.join(',')}}`)
}

function canonicalValue(value: string | number | undefined): string {
  if (typeof value === 'number') {
    return String(value)
  }
  return JSON.stringify(value)
}

export const receiptLeaf = (body: ReceiptBody): Uint8Array => leafHash(canonicalBody(body))

export const receiptId = (body: ReceiptBody): string => bytesToHex(receiptLeaf(body))

const CHAIN_STEP_PREFIX = Uint8Array.of(0x02)
const CHAIN_GENESIS_PREFIX = Uint8Array.of(0x03)

export function chainGenesis(escrow: Uint8Array): Uint8Array {
  requireLength(escrow, 32, 'escrow')
  return sha256(concatBytes(CHAIN_GENESIS_PREFIX, escrow))
}

export function chainStep(previous: Uint8Array, leaf: Uint8Array): Uint8Array {
  requireLength(previous, 32, 'previous chain value')
  requireLength(leaf, 32, 'leaf')
  return sha256(concatBytes(CHAIN_STEP_PREFIX, previous, leaf))
}

export interface Voucher {
  readonly escrow: Uint8Array
  readonly seq: bigint
  readonly cumulative: bigint
  readonly chain: Uint8Array
}

const VOUCHER_DOMAIN = utf8ToBytes('CLDGR:v1')
const VOUCHER_MESSAGE_LENGTH = 88

/** Межа кодування у `u64`, а не грошова: `seq` теж через неї проходить. */
const MAX_U64 = 2n ** 64n - 1n

/**
 * Фіксований layout, бо це повідомлення збирає ще й програма в BPF при
 * перевірці Ed25519-precompile — JSON там не парситься.
 */
export function voucherMessage({ escrow, seq, cumulative, chain }: Voucher): Uint8Array {
  requireLength(escrow, 32, 'escrow')
  requireLength(chain, 32, 'chain')
  const message = new Uint8Array(VOUCHER_MESSAGE_LENGTH)
  message.set(VOUCHER_DOMAIN, 0)
  message.set(escrow, 8)
  const view = new DataView(message.buffer)
  view.setBigUint64(40, requireU64(seq, 'seq'), true)
  view.setBigUint64(48, requireU64(cumulative, 'cumulative'), true)
  message.set(chain, 56)
  return message
}

function requireLength(value: Uint8Array, length: number, name: string): void {
  if (value.length !== length) {
    throw new RangeError(`${name} must be ${length} bytes, got ${value.length}`)
  }
}

function requireU64(value: bigint, name: string): bigint {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`${name} does not fit in u64: ${value}`)
  }
  return value
}
