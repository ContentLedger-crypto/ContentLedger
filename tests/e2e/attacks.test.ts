import { utils } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import { attempt, tamperVoucher, unknownSignature } from './attacks.js'

const decode = (header: string) =>
  JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>

const SIG = utils.bytes.bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1))
const VOUCHER = Buffer.from(
  JSON.stringify({
    escrow: 'BokvGA1FZ7yVJhhHRgkhEMaGUvfaE1PjpdrwQdxSverd',
    seq: 7,
    cumulative: '15400',
    chain: 'c97b79363e1bf4246777a316507d1eab6eb7c54d4411cbec360226d69b671fdd',
    sig: SIG,
  }),
).toString('base64url')

describe('tamperVoucher', () => {
  it('forges the signature and nothing else, still a well-formed 64-byte signature', () => {
    const forged = decode(tamperVoucher(VOUCHER, 'forged-signature'))
    const original = decode(VOUCHER)
    expect(forged.sig).not.toBe(original.sig)
    expect(utils.bytes.bs58.decode(forged.sig as string)).toHaveLength(64)
    expect({ ...forged, sig: original.sig }).toEqual(original)
  })

  it('claims one more base unit than was signed for', () => {
    expect(decode(tamperVoucher(VOUCHER, 'inflated-cumulative'))).toEqual({
      ...decode(VOUCHER),
      cumulative: '15401',
    })
  })

  it('swaps one byte of the chain, keeping it 32 bytes of hex', () => {
    const chain = decode(tamperVoucher(VOUCHER, 'wrong-chain')).chain as string
    expect(chain).toMatch(/^[0-9a-f]{64}$/)
    expect(chain).not.toBe(decode(VOUCHER).chain)
    expect(chain.slice(2)).toBe((decode(VOUCHER).chain as string).slice(2))
  })
})

describe('unknownSignature', () => {
  it('is a well-formed transaction signature that no transaction has', () => {
    const signature = unknownSignature(() => new Uint8Array(64).fill(9))
    expect(Uint8Array.from(utils.bytes.bs58.decode(signature))).toEqual(new Uint8Array(64).fill(9))
  })
})

describe('attempt', () => {
  const stub = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response('body', { status, headers })) as typeof fetch

  it('records a refusal with its status and reason', async () => {
    const refusal = new Response(
      JSON.stringify({ error: { code: 'INVALID_INPUT', details: { reason: 'replayed' } } }),
      { status: 400 },
    )
    const fetchStub = (async () => refusal) as typeof fetch
    expect(await attempt(fetchStub, 'http://gw.test/v1/content', 'replayed-voucher', {})).toEqual({
      kind: 'replayed-voucher',
      status: 400,
      reason: 'replayed',
      delivered: false,
    })
  })

  it('counts a 200 as delivered', async () => {
    expect(
      await attempt(stub(200), 'http://gw.test/v1/content', 'forged-signature', {}),
    ).toMatchObject({
      delivered: true,
    })
  })

  it('counts a receipt header as delivered whatever the status says', async () => {
    const leaked = stub(400, { 'X-ContentLedger-Receipt': 'e30' })
    expect(await attempt(leaked, 'http://gw.test/v1/content', 'no-proof', {})).toMatchObject({
      status: 400,
      delivered: true,
    })
  })
})
