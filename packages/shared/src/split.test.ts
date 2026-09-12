import { describe, expect, it } from 'vitest'
import { MAX_USDC_BASE_UNITS } from './money.js'
import { splitPayment, sumSplits } from './split.js'

const terms = (tariff: bigint, feeBps = 1000, nodeShareBps = 0) => ({
  tariff,
  feeBps,
  nodeShareBps,
})

describe('splitPayment', () => {
  it('adds the fee on top of the tariff and leaves the publisher the whole rate', () => {
    const split = splitPayment(terms(2000n, 1000))
    expect(split).toEqual({
      tariff: 2000n,
      fee: 200n,
      nodeCut: 0n,
      publisher: 2000n,
      total: 2200n,
    })
  })

  it('takes the node share from inside the tariff, never on top of it', () => {
    const split = splitPayment(terms(2000n, 1000, 500))
    expect(split.nodeCut).toBe(100n)
    expect(split.publisher).toBe(1900n)
    expect(split.publisher + split.nodeCut).toBe(split.tariff)
    expect(split.total).toBe(2200n)
  })

  it('rounds the fee up and the node share down on a tariff that does not divide', () => {
    const split = splitPayment(terms(333n, 1000, 1000))
    expect(split.fee).toBe(34n)
    expect(split.nodeCut).toBe(33n)
    expect(split.publisher).toBe(300n)
    expect(split.total).toBe(367n)
  })

  it('gives the whole rounding remainder to the publisher', () => {
    for (let tariff = 1n; tariff <= 200n; tariff++) {
      const split = splitPayment(terms(tariff, 733, 733))
      expect(split.publisher + split.nodeCut, `tariff=${tariff}`).toBe(tariff)
      expect(split.publisher + split.nodeCut + split.fee, `tariff=${tariff}`).toBe(split.total)
      expect(split.fee * 10_000n >= tariff * 733n, `fee up at ${tariff}`).toBe(true)
      expect(split.nodeCut * 10_000n <= tariff * 733n, `cut down at ${tariff}`).toBe(true)
    }
  })

  it('charges at least one base unit of fee whenever the fee is not free', () => {
    expect(splitPayment(terms(1n, 1)).fee).toBe(1n)
    expect(splitPayment(terms(1n, 10_000)).fee).toBe(1n)
    expect(splitPayment(terms(1n, 0)).fee).toBe(0n)
  })

  it('handles the ends of the range: free tariff, free fee, whole tariff to the node', () => {
    expect(splitPayment(terms(0n, 1000, 1000))).toEqual({
      tariff: 0n,
      fee: 0n,
      nodeCut: 0n,
      publisher: 0n,
      total: 0n,
    })
    expect(splitPayment(terms(2000n, 0, 0)).total).toBe(2000n)
    const allToNode = splitPayment(terms(2000n, 0, 10_000))
    expect(allToNode.nodeCut).toBe(2000n)
    expect(allToNode.publisher).toBe(0n)
  })

  it('refuses terms that cannot hold or cannot be meant', () => {
    expect(() => splitPayment(terms(-1n))).toThrow(RangeError)
    expect(() => splitPayment(terms(MAX_USDC_BASE_UNITS + 1n, 0))).toThrow(RangeError)
    expect(() => splitPayment(terms(2000n, -1))).toThrow(RangeError)
    expect(() => splitPayment(terms(2000n, 10_001))).toThrow(RangeError)
    expect(() => splitPayment(terms(2000n, 1000, 10_001))).toThrow(RangeError)
    expect(() => splitPayment(terms(2000n, 1.5))).toThrow(RangeError)
  })

  it('refuses a payment whose total would not fit in u64', () => {
    expect(() => splitPayment(terms(MAX_USDC_BASE_UNITS, 1))).toThrow(RangeError)
    expect(splitPayment(terms(MAX_USDC_BASE_UNITS, 0, 10_000)).publisher).toBe(0n)
  })
})

describe('sumSplits', () => {
  const batch = Array.from({ length: 50 }, (_, i) =>
    splitPayment(terms(BigInt(i) + 101n, 733, 733)),
  )

  it('keeps every base unit accounted for across a whole batch', () => {
    const totals = sumSplits(batch)
    expect(totals.publisher + totals.nodeCut + totals.fee).toBe(totals.total)
  })

  it('sums each side to what the batch actually charged', () => {
    const totals = sumSplits(batch)
    expect(totals.total).toBe(batch.reduce((acc, split) => acc + split.total, 0n))
    expect(totals.fee).toBe(batch.reduce((acc, split) => acc + split.fee, 0n))
  })

  it('is not the same as rounding once over the batch total, which is why it is per receipt', () => {
    const tariffTotal = batch.reduce((acc, split) => acc + split.tariff, 0n)
    const roundedOnce = splitPayment(terms(tariffTotal, 733, 733))
    expect(sumSplits(batch).fee).not.toBe(roundedOnce.fee)
  })

  it('returns zeros for an empty batch', () => {
    expect(sumSplits([])).toEqual({ publisher: 0n, nodeCut: 0n, fee: 0n, total: 0n })
  })
})
