import type { PublisherReceipt, ReceiptsPage } from '@contentledger/shared'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_FEED,
  type FeedState,
  standingOf,
  withOlder,
  withReceipt,
  withSettlement,
  withSnapshot,
} from './feed'

const id = (n: number) => n.toString(16).padStart(64, '0')

function receipt(n: number, settledAt: string | null = null): PublisherReceipt {
  return {
    id: id(n),
    workId: 'BUHqsiLM6HyUEKrdVAtWQ1KG9K9oKJJAJXjUv3fFmHLp',
    sourceId: 'https://atlasquarterly.org/2026/03/tide-gauges',
    consumer: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
    useType: 'inference',
    tariff: 500n,
    paymentMethod: 'escrow',
    acceptedAt: `2026-10-07T10:00:${n.toString().padStart(2, '0')}.000Z`,
    settledAt,
  }
}

const page = (ns: number[], nextCursor: string | null = null): ReceiptsPage => ({
  items: ns.map((n) => receipt(n)),
  nextCursor,
})

const ids = (state: FeedState) => state.rows.map((row) => row.id)

describe('withSnapshot', () => {
  it('shows the first page newest first and remembers where older rows start', () => {
    const state = withSnapshot(EMPTY_FEED, page([9, 8, 7], 'c7'))
    expect(state.loaded).toBe(true)
    expect(ids(state)).toEqual([id(9), id(8), id(7)])
    expect(state.rows.every((row) => !row.arrived)).toBe(true)
    expect(state.nextCursor).toBe('c7')
  })

  it('keeps a receipt that streamed in while the snapshot was being read', () => {
    const live = withReceipt(EMPTY_FEED, receipt(10))
    const state = withSnapshot(live, page([9, 8], null))
    expect(ids(state)).toEqual([id(10), id(9), id(8)])
    expect(state.rows[0]?.arrived).toBe(true)
  })

  it('does not unsettle a receipt the snapshot read before its batch landed', () => {
    const settled = withSettlement(withReceipt(EMPTY_FEED, receipt(9)), {
      batchId: id(100),
      settledAt: '2026-10-07T10:01:00.000Z',
      receiptIds: [id(9)],
    })
    const state = withSnapshot(settled, page([9, 8]))
    expect(state.rows[0]?.settledAt).toBe('2026-10-07T10:01:00.000Z')
  })

  it('drops older pages on a resync, which may have missed rows in between', () => {
    const first = withSnapshot(EMPTY_FEED, page([9, 8], 'c8'))
    const deeper = withOlder(first, 'c8', page([7, 6], 'c6'))
    const state = withSnapshot(deeper, page([12, 11], 'c11'))
    expect(ids(state)).toEqual([id(12), id(11)])
    expect(state.nextCursor).toBe('c11')
  })

  it('keeps rows already shown when the snapshot holds the whole history', () => {
    const first = withSnapshot(EMPTY_FEED, page([9, 8]))
    expect(ids(withSnapshot(first, page([]))).length).toBe(2)
  })
})

describe('withOlder', () => {
  it('appends the older page and moves the cursor on', () => {
    const state = withOlder(withSnapshot(EMPTY_FEED, page([9, 8], 'c8')), 'c8', page([7], null))
    expect(ids(state)).toEqual([id(9), id(8), id(7)])
    expect(state.nextCursor).toBeNull()
  })

  it('ignores a page asked for before a resync moved the cursor', () => {
    const first = withSnapshot(EMPTY_FEED, page([9, 8], 'c8'))
    const resynced = withSnapshot(first, page([12, 11], 'c11'))
    expect(withOlder(resynced, 'c8', page([7, 6], 'c6'))).toBe(resynced)
  })
})

describe('withReceipt', () => {
  it('puts a new receipt on top, marked as arrived', () => {
    const state = withReceipt(withSnapshot(EMPTY_FEED, page([9, 8])), receipt(10))
    expect(ids(state)).toEqual([id(10), id(9), id(8)])
    expect(state.rows[0]?.arrived).toBe(true)
  })

  it('does not show a receipt twice', () => {
    const state = withReceipt(withSnapshot(EMPTY_FEED, page([9, 8])), receipt(9))
    expect(ids(state)).toEqual([id(9), id(8)])
    expect(state.rows[0]?.arrived).toBe(false)
  })

  it('orders by acceptance even when events arrive out of order', () => {
    const state = withReceipt(withReceipt(EMPTY_FEED, receipt(10)), receipt(9))
    expect(ids(state)).toEqual([id(10), id(9)])
  })
})

describe('withSettlement', () => {
  it('settles the named receipts and leaves the rest accrued', () => {
    const state = withSettlement(withSnapshot(EMPTY_FEED, page([9, 8])), {
      batchId: id(100),
      settledAt: '2026-10-07T10:01:00.000Z',
      receiptIds: [id(8), id(77)],
    })
    expect(state.rows.map((row) => row.settledAt)).toEqual([null, '2026-10-07T10:01:00.000Z'])
  })
})

describe('standingOf', () => {
  it('is accrued until the money moves', () => {
    expect(standingOf(receipt(1))).toEqual({ kind: 'accrued' })
  })

  it('names the batch for escrow and the payment itself for x402', () => {
    const at = '2026-10-07T10:01:00.000Z'
    expect(standingOf(receipt(1, at))).toEqual({ kind: 'settled', via: 'batch', at })
    expect(standingOf({ ...receipt(1, at), paymentMethod: 'x402' })).toEqual({
      kind: 'settled',
      via: 'payment',
      at,
    })
  })
})
