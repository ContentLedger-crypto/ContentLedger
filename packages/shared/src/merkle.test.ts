import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { merkleProof, merkleRoot, verifyInclusion } from './merkle.js'

// Очікувані значення пораховані незалежним оракулом на `node:crypto` за текстом
// RFC 6962 §2.1 — не цією реалізацією і не цією бібліотекою хешів.
const ROOTS = [
  '65cd092dc4435b17fd24b8916798ed86c8be50b8600d09e7eddb3f277cbe3f82',
  '28771ff890dd009c927aa49eb95ac1b20950f5b158ad1d839b9b9302ec21d5d3',
  '6afb54d82cc354d4ebfe3266a135ec897d675dba4dc67c92472d9105670ee0f5',
  'ef927b085406cb54f871d35f0f256f23248a7ef99bfecf0bc0cb2b75859b0a42',
  '0b87751e28511daf708603fba3de7227c185f864864e2e5c97b691513e657a23',
  'b9f060950240155bbcfe1a3e293e455ec6e5d9dbc021ed13d3b607348ca99e17',
]
const LEAF_HASH_R0 = '65cd092dc4435b17fd24b8916798ed86c8be50b8600d09e7eddb3f277cbe3f82'
const LEAF_HASH_R1 = '7060ccbc0d4653cb6e331249868c135f1f482328a090814c821d72983f8eca53'

const leaves = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => utf8ToBytes(`r${i}`))

const rootHex = (input: readonly Uint8Array[]): string => bytesToHex(merkleRoot(input))

describe('merkleRoot', () => {
  it('matches the independent RFC 6962 oracle for one through six leaves', () => {
    for (const [i, expected] of ROOTS.entries()) {
      expect(rootHex(leaves(i + 1)), `n=${i + 1}`).toBe(expected)
    }
  })

  it('hashes a lone leaf with the leaf prefix rather than passing it through', () => {
    expect(rootHex(leaves(1))).toBe(LEAF_HASH_R0)
    expect(rootHex(leaves(1))).not.toBe(bytesToHex(utf8ToBytes('r0')))
  })

  it('does not duplicate the odd leaf: five leaves differ from five plus a repeat', () => {
    const five = leaves(5)
    const withRepeat = [...five, five[4] as Uint8Array]
    expect(rootHex(five)).not.toBe(rootHex(withRepeat))
    expect(rootHex(withRepeat)).toBe(
      'd7b0263f287a6eff72a54932a185fa23b9d7d9dcba3728ce61dbe76f41ea5090',
    )
  })

  it('binds the order of receipts in the batch', () => {
    expect(rootHex(leaves(5).reverse())).toBe(
      'a6caad92d2e7c6dff825020a282485b6a76c20a5778d8a793bce4c4f2ad805d4',
    )
    expect(rootHex(leaves(5).reverse())).not.toBe(ROOTS[4])
  })

  it('refuses an empty batch instead of anchoring the hash of nothing', () => {
    expect(() => merkleRoot([])).toThrow(RangeError)
  })
})

describe('merkleProof + verifyInclusion', () => {
  it('proves every leaf of every batch size we build', () => {
    for (let n = 1; n <= 9; n++) {
      const batch = leaves(n)
      const root = merkleRoot(batch)
      for (let i = 0; i < n; i++) {
        const leaf = batch[i] as Uint8Array
        expect(verifyInclusion(leaf, merkleProof(batch, i), root), `n=${n} i=${i}`).toBe(true)
      }
    }
  })

  it('gives a lone leaf an empty path', () => {
    const batch = leaves(1)
    expect(merkleProof(batch, 0)).toEqual([])
    expect(verifyInclusion(batch[0] as Uint8Array, [], merkleRoot(batch))).toBe(true)
  })

  it('walks the path bottom-up with the sibling side named', () => {
    const batch = leaves(2)
    expect(merkleProof(batch, 0)).toEqual([{ hash: hexToBytes(LEAF_HASH_R1), side: 'right' }])
    expect(merkleProof(batch, 1)).toEqual([{ hash: hexToBytes(LEAF_HASH_R0), side: 'left' }])
  })

  it('rejects a different leaf under a valid path', () => {
    const batch = leaves(5)
    const proof = merkleProof(batch, 2)
    expect(verifyInclusion(utf8ToBytes('r9'), proof, merkleRoot(batch))).toBe(false)
  })

  it('rejects a tampered sibling and a flipped side', () => {
    const batch = leaves(5)
    const root = merkleRoot(batch)
    const proof = merkleProof(batch, 3)
    const first = proof[0] as { hash: Uint8Array; side: 'left' | 'right' }

    const tampered = [{ ...first, hash: hexToBytes(LEAF_HASH_R0) }, ...proof.slice(1)]
    expect(verifyInclusion(batch[3] as Uint8Array, tampered, root)).toBe(false)

    const flipped = [
      { ...first, side: first.side === 'left' ? ('right' as const) : ('left' as const) },
      ...proof.slice(1),
    ]
    expect(verifyInclusion(batch[3] as Uint8Array, flipped, root)).toBe(false)
  })

  it('rejects a path taken from another batch', () => {
    const mine = leaves(5)
    const other = leaves(6)
    expect(verifyInclusion(mine[1] as Uint8Array, merkleProof(other, 1), merkleRoot(mine))).toBe(
      false,
    )
  })

  it('does not accept an internal node passed off as a leaf', () => {
    const batch = leaves(2)
    const bothLeafHashes = new Uint8Array(64)
    bothLeafHashes.set(hexToBytes(LEAF_HASH_R0), 0)
    bothLeafHashes.set(hexToBytes(LEAF_HASH_R1), 32)
    expect(verifyInclusion(bothLeafHashes, [], merkleRoot(batch))).toBe(false)
  })

  it('refuses an index that names no leaf', () => {
    const batch = leaves(5)
    expect(() => merkleProof(batch, -1)).toThrow(RangeError)
    expect(() => merkleProof(batch, 5)).toThrow(RangeError)
    expect(() => merkleProof(batch, 1.5)).toThrow(RangeError)
    expect(() => merkleProof([], 0)).toThrow(RangeError)
  })
})
