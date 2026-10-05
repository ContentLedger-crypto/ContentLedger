import { randomBytes } from 'node:crypto'
import { utils } from '@coral-xyz/anchor'
import type { Attempt } from './measure.js'

export type VoucherTamper = 'forged-signature' | 'inflated-cumulative' | 'wrong-chain'

/**
 * Each tamper leaves the header well-formed, so the gateway has to refuse it on what the
 * voucher says rather than on how it is spelled.
 */
export function tamperVoucher(header: string, how: VoucherTamper): string {
  const voucher = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
    sig: string
    cumulative: string
    chain: string
  }
  if (how === 'forged-signature') {
    const sig = Uint8Array.from(utils.bytes.bs58.decode(voucher.sig))
    sig[0] = (sig[0] ?? 0) ^ 0xff
    voucher.sig = utils.bytes.bs58.encode(sig)
  } else if (how === 'inflated-cumulative') {
    voucher.cumulative = (BigInt(voucher.cumulative) + 1n).toString()
  } else {
    const first = Number.parseInt(voucher.chain.slice(0, 2), 16) ^ 0xff
    voucher.chain = first.toString(16).padStart(2, '0') + voucher.chain.slice(2)
  }
  return Buffer.from(JSON.stringify(voucher)).toString('base64url')
}

export function unknownSignature(random: (bytes: number) => Uint8Array = randomBytes): string {
  return utils.bytes.bs58.encode(random(64))
}

export async function attempt(
  fetchFn: typeof fetch,
  url: string,
  kind: string,
  headers: Record<string, string>,
): Promise<Attempt & { reason?: string }> {
  const res = await fetchFn(url, { headers })
  const text = await res.text()
  // A receipt is the gateway saying it served the work, whatever the status line claims.
  const delivered = res.status === 200 || res.headers.has('X-ContentLedger-Receipt')
  const reason = reasonOf(text)
  return { kind, status: res.status, ...(reason && { reason }), delivered }
}

function reasonOf(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text)
    const reason = (json as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
    return typeof reason === 'string' ? reason : undefined
  } catch {
    return undefined
  }
}
