import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, concatBytes } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { merkleRoot } from './merkle.js'
import {
  canonicalBody,
  chainGenesis,
  chainStep,
  receiptBodySchema,
  receiptId,
  receiptLeaf,
  voucherMessage,
} from './voucher.js'

// Очікувані значення пораховані незалежним оракулом на Python (`json.dumps` із
// sort_keys + hashlib) за текстом RFC 8785 — не цим кодом і не @noble/hashes.
const JCS_ESCROW =
  '{"acceptedAt":"2026-09-03T17:04:11.412Z","consumer":"7Xw3kQhVvVfN4dLpAqTzR9mBcJyU2sHnEgWxPd6ZaKtF","fee":"200","paymentMethod":"escrow","rateLevel":"domain","registryHash":"4f1a000000000000000000000000000000000000000000000000000000000000","seq":41,"servedHash":"9ab2000000000000000000000000000000000000000000000000000000000000","tariff":"2000","useType":"train","work":"3nQvLxRpTyBs8dKmWfHjZaCe5UgNi2XoPr7VtDbYuMcA"}'
const LEAF_ESCROW = '4be487e42643dbfbec30ab98e5f472362ea3aad599954e8de61f543fe75da83e'
const LEAF_X402 = '60d6a8038bd2b377e2fa16e43aa269df7b31a46612042c03ffd52f60e5bb966c'
const GENESIS = '3cea1c8fb8815b13cc24bb320c9b7887ad2a0c76c96bb249720f7c550924d4e6'
const CHAIN_41 = '03eacbc9e8108fd4ce05bcaef6cd3575985dbd91481528d49c8306c57489bb43'
const CHAIN_43 = '76d68caf04cd10ad18a552310448d2891755f03d03194d2124e26502a0b0b4da'
const CHAIN_SWAPPED = '91a49651c78568cdd13d942ed9a3cdd4cbf547fd93da982a41d4064ceb7491b3'
// Pinned byte for byte in `programs/contentledger/tests/golden.rs`: the program
// rebuilds these 88 bytes in BPF, and a drift would surface on devnet as a
// signature that simply does not match, with nothing pointing at the field.
const VOUCHER_MESSAGE =
  '434c4447523a7631000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f290000000000000088580100000000004be487e42643dbfbec30ab98e5f472362ea3aad599954e8de61f543fe75da83e'

const ESCROW_KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const CONSUMER = '7Xw3kQhVvVfN4dLpAqTzR9mBcJyU2sHnEgWxPd6ZaKtF'
const WORK = '3nQvLxRpTyBs8dKmWfHjZaCe5UgNi2XoPr7VtDbYuMcA'
const SERVED = `9ab2${'0'.repeat(60)}`
const REGISTRY = `4f1a${'0'.repeat(60)}`

const escrowBody = (seq = 41) => ({
  consumer: CONSUMER,
  work: WORK,
  useType: 'train' as const,
  tariff: '2000',
  fee: '200',
  rateLevel: 'domain' as const,
  servedHash: SERVED,
  registryHash: REGISTRY,
  acceptedAt: '2026-09-03T17:04:11.412Z',
  paymentMethod: 'escrow' as const,
  seq,
})

const x402Body = () => ({
  consumer: CONSUMER,
  work: WORK,
  useType: 'train' as const,
  tariff: '2000',
  fee: '200',
  rateLevel: 'domain' as const,
  servedHash: SERVED,
  registryHash: REGISTRY,
  acceptedAt: '2026-09-03T17:04:11.412Z',
  paymentMethod: 'x402' as const,
  paymentRef: '5'.repeat(87),
})

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('canonicalBody', () => {
  it('matches the independent RFC 8785 oracle byte for byte', () => {
    expect(decode(canonicalBody(escrowBody()))).toBe(JCS_ESCROW)
  })

  it('sorts keys, so the order they were written in does not change the bytes', () => {
    const reordered = {
      seq: 41,
      paymentMethod: 'escrow' as const,
      work: WORK,
      registryHash: REGISTRY,
      servedHash: SERVED,
      rateLevel: 'domain' as const,
      fee: '200',
      tariff: '2000',
      useType: 'train' as const,
      acceptedAt: '2026-09-03T17:04:11.412Z',
      consumer: CONSUMER,
    }
    expect(decode(canonicalBody(reordered))).toBe(JCS_ESCROW)
  })

  it('serialises money as strings and seq as the one bare number', () => {
    expect(JCS_ESCROW).toContain('"tariff":"2000"')
    expect(JCS_ESCROW).toContain('"seq":41')
  })

  it('refuses a body carrying anything the schema does not name', () => {
    expect(() => canonicalBody({ ...escrowBody(), nodeCut: '0' } as never)).toThrow()
  })
})

describe('receiptBodySchema', () => {
  it('accepts both payment methods with the fields each one owns', () => {
    expect(receiptBodySchema.safeParse(escrowBody()).success).toBe(true)
    expect(receiptBodySchema.safeParse(x402Body()).success).toBe(true)
  })

  it('does not let the two payment methods borrow each other fields', () => {
    expect(
      receiptBodySchema.safeParse({ ...escrowBody(), paymentRef: '5'.repeat(87) }).success,
    ).toBe(false)
    expect(receiptBodySchema.safeParse({ ...x402Body(), seq: 41 }).success).toBe(false)
  })

  it('rejects a derived field that must never be signed', () => {
    expect(receiptBodySchema.safeParse({ ...escrowBody(), hashMatch: true }).success).toBe(false)
    expect(receiptBodySchema.safeParse({ ...escrowBody(), settledAt: null }).success).toBe(false)
  })

  it('rejects money that is not canonical base units', () => {
    expect(receiptBodySchema.safeParse({ ...escrowBody(), tariff: '0200' }).success).toBe(false)
    expect(receiptBodySchema.safeParse({ ...escrowBody(), tariff: '2.0' }).success).toBe(false)
    expect(receiptBodySchema.safeParse({ ...escrowBody(), fee: 200 }).success).toBe(false)
  })

  it('pins the timestamp to one shape, since two shapes would hash differently', () => {
    for (const acceptedAt of [
      '2026-09-03T17:04:11Z',
      '2026-09-03T17:04:11.412+00:00',
      '2026-09-03T17:04:11.412',
      '2026-09-03 17:04:11.412Z',
    ]) {
      expect(receiptBodySchema.safeParse({ ...escrowBody(), acceptedAt }).success, acceptedAt).toBe(
        false,
      )
    }
  })

  it('rejects malformed hashes, keys, use types and rate levels', () => {
    expect(receiptBodySchema.safeParse({ ...escrowBody(), servedHash: '9ab2' }).success).toBe(false)
    expect(
      receiptBodySchema.safeParse({ ...escrowBody(), servedHash: SERVED.toUpperCase() }).success,
    ).toBe(false)
    expect(receiptBodySchema.safeParse({ ...escrowBody(), consumer: '0OIl' }).success).toBe(false)
    expect(receiptBodySchema.safeParse({ ...escrowBody(), useType: 'training' }).success).toBe(
      false,
    )
    expect(receiptBodySchema.safeParse({ ...escrowBody(), rateLevel: 'global' }).success).toBe(
      false,
    )
  })

  it('rejects a seq that cannot survive JSON', () => {
    expect(receiptBodySchema.safeParse(escrowBody(0)).success).toBe(false)
    expect(receiptBodySchema.safeParse(escrowBody(1.5)).success).toBe(false)
    expect(receiptBodySchema.safeParse(escrowBody(Number.MAX_SAFE_INTEGER + 2)).success).toBe(false)
  })
})

describe('receiptLeaf and receiptId', () => {
  it('matches the oracle for both payment methods', () => {
    expect(bytesToHex(receiptLeaf(escrowBody()))).toBe(LEAF_ESCROW)
    expect(bytesToHex(receiptLeaf(x402Body()))).toBe(LEAF_X402)
  })

  it('is the very leaf the merkle tree hashes, not a second digest', () => {
    expect(bytesToHex(merkleRoot([canonicalBody(escrowBody())]))).toBe(LEAF_ESCROW)
  })

  it('gives the receipt a content-addressed id', () => {
    expect(receiptId(escrowBody())).toBe(LEAF_ESCROW)
    expect(receiptId(escrowBody(42))).not.toBe(LEAF_ESCROW)
  })
})

describe('chainGenesis and chainStep', () => {
  it('matches the oracle and binds the chain to one escrow', () => {
    expect(bytesToHex(chainGenesis(ESCROW_KEY))).toBe(GENESIS)
    const other = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    expect(bytesToHex(chainGenesis(other))).not.toBe(GENESIS)
  })

  it('walks the oracle chain over three issuances', () => {
    let chain = chainGenesis(ESCROW_KEY)
    chain = chainStep(chain, receiptLeaf(escrowBody(41)))
    expect(bytesToHex(chain)).toBe(CHAIN_41)
    chain = chainStep(chain, receiptLeaf(escrowBody(42)))
    chain = chainStep(chain, receiptLeaf(escrowBody(43)))
    expect(bytesToHex(chain)).toBe(CHAIN_43)
  })

  it('breaks when two issuances swap places', () => {
    let chain = chainGenesis(ESCROW_KEY)
    for (const seq of [42, 41, 43]) {
      chain = chainStep(chain, receiptLeaf(escrowBody(seq)))
    }
    expect(bytesToHex(chain)).toBe(CHAIN_SWAPPED)
    expect(bytesToHex(chain)).not.toBe(CHAIN_43)
  })

  it('is not the same hash a merkle node would give for the same pair', () => {
    const previous = chainGenesis(ESCROW_KEY)
    const leaf = receiptLeaf(escrowBody())
    const asNode = sha256(concatBytes(Uint8Array.of(0x01), previous, leaf))
    expect(bytesToHex(chainStep(previous, leaf))).not.toBe(bytesToHex(asNode))
  })

  it('refuses inputs that are not 32 bytes', () => {
    expect(() => chainGenesis(new Uint8Array(31))).toThrow(RangeError)
    expect(() => chainStep(new Uint8Array(31), new Uint8Array(32))).toThrow(RangeError)
    expect(() => chainStep(new Uint8Array(32), new Uint8Array(33))).toThrow(RangeError)
  })
})

describe('voucherMessage', () => {
  const message = () =>
    voucherMessage({
      escrow: ESCROW_KEY,
      seq: 41n,
      cumulative: 88_200n,
      chain: receiptLeaf(escrowBody()),
    })

  it('lays out exactly 88 bytes the program can rebuild in BPF', () => {
    const bytes = message()
    expect(bytes.length).toBe(88)
    expect(decode(bytes.subarray(0, 8))).toBe('CLDGR:v1')
    expect(bytesToHex(bytes.subarray(8, 40))).toBe(bytesToHex(ESCROW_KEY))
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect(view.getBigUint64(40, true)).toBe(41n)
    expect(view.getBigUint64(48, true)).toBe(88_200n)
    expect(bytesToHex(bytes.subarray(56, 88))).toBe(LEAF_ESCROW)
    expect(bytesToHex(bytes)).toBe(VOUCHER_MESSAGE)
  })

  it('changes when any field changes', () => {
    const base = bytesToHex(message())
    const moved = voucherMessage({
      escrow: ESCROW_KEY,
      seq: 41n,
      cumulative: 88_201n,
      chain: receiptLeaf(escrowBody()),
    })
    expect(bytesToHex(moved)).not.toBe(base)
  })

  it('refuses values u64 cannot hold and keys that are not 32 bytes', () => {
    const chain = receiptLeaf(escrowBody())
    const max = 2n ** 64n - 1n
    expect(() => voucherMessage({ escrow: ESCROW_KEY, seq: -1n, cumulative: 1n, chain })).toThrow(
      RangeError,
    )
    expect(() =>
      voucherMessage({ escrow: ESCROW_KEY, seq: 1n, cumulative: max + 1n, chain }),
    ).toThrow(RangeError)
    expect(() =>
      voucherMessage({ escrow: new Uint8Array(31), seq: 1n, cumulative: 1n, chain }),
    ).toThrow(RangeError)
    expect(() =>
      voucherMessage({ escrow: ESCROW_KEY, seq: 1n, cumulative: 1n, chain: new Uint8Array(31) }),
    ).toThrow(RangeError)
  })

  it('accepts the u64 ceiling itself', () => {
    const max = 2n ** 64n - 1n
    const bytes = voucherMessage({
      escrow: ESCROW_KEY,
      seq: max,
      cumulative: max,
      chain: receiptLeaf(escrowBody()),
    })
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect(view.getBigUint64(40, true)).toBe(max)
  })
})
