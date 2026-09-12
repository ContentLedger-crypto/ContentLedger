import { sha256 } from '@noble/hashes/sha2'
import { concatBytes } from '@noble/hashes/utils'

export type MerkleSide = 'left' | 'right'

/** `side` — з якого боку стоїть сусід, а не куди йде наш хеш. */
export interface MerkleStep {
  readonly hash: Uint8Array
  readonly side: MerkleSide
}

export type MerklePath = readonly MerkleStep[]

const LEAF_PREFIX = Uint8Array.of(0x00)
const NODE_PREFIX = Uint8Array.of(0x01)

/** Листок дерева і водночас ланка ланцюга ваучера — це має бути один хеш. */
export const leafHash = (data: Uint8Array): Uint8Array => sha256(concatBytes(LEAF_PREFIX, data))

const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  sha256(concatBytes(NODE_PREFIX, left, right))

/** RFC 6962: найбільший степінь двійки, строго менший за `n`. */
const splitPoint = (n: number): number => {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  const [first] = leaves
  if (first === undefined) {
    throw new RangeError('merkle tree needs at least one leaf')
  }
  if (leaves.length === 1) {
    return leafHash(first)
  }
  const k = splitPoint(leaves.length)
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)))
}

export function merkleProof(leaves: readonly Uint8Array[], index: number): MerklePath {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`no leaf at index ${index} in a batch of ${leaves.length}`)
  }
  return pathTo(leaves, index)
}

function pathTo(leaves: readonly Uint8Array[], index: number): MerkleStep[] {
  if (leaves.length === 1) {
    return []
  }
  const k = splitPoint(leaves.length)
  return index < k
    ? [...pathTo(leaves.slice(0, k), index), { hash: merkleRoot(leaves.slice(k)), side: 'right' }]
    : [
        ...pathTo(leaves.slice(k), index - k),
        { hash: merkleRoot(leaves.slice(0, k)), side: 'left' },
      ]
}

export function verifyInclusion(leaf: Uint8Array, path: MerklePath, root: Uint8Array): boolean {
  let acc = leafHash(leaf)
  for (const step of path) {
    acc = step.side === 'left' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash)
  }
  return equalBytes(acc, root)
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((byte, i) => byte === b[i])
}
