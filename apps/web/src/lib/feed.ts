import type { PublisherReceipt, ReceiptsPage, SettlementEvent } from '@contentledger/shared'

export interface FeedRow extends PublisherReceipt {
  /** Came in over the stream rather than with a page, so the row is drawn arriving. */
  readonly arrived: boolean
}

export interface FeedState {
  /** In the gateway's order: newest acceptance first, then id. */
  readonly rows: readonly FeedRow[]
  /** Where the next older page starts; `null` once the history is all shown. */
  readonly nextCursor: string | null
  readonly loaded: boolean
}

export const EMPTY_FEED: FeedState = { rows: [], nextCursor: null, loaded: false }

export type Standing =
  | { readonly kind: 'accrued' }
  | { readonly kind: 'settled'; readonly via: 'batch' | 'payment'; readonly at: string }

export function standingOf(receipt: PublisherReceipt): Standing {
  if (receipt.settledAt === null) return { kind: 'accrued' }
  return {
    kind: 'settled',
    via: receipt.paymentMethod === 'x402' ? 'payment' : 'batch',
    at: receipt.settledAt,
  }
}

/**
 * Rows below the page's last one are dropped: the snapshot follows a (re)subscription,
 * and receipts issued while the stream was down may sit between it and older pages.
 * The cursor starts over from the page, so they are read again in order.
 */
export function withSnapshot(state: FeedState, page: ReceiptsPage): FeedState {
  const floor = page.nextCursor === null ? undefined : page.items.at(-1)
  const kept = floor === undefined ? state.rows : state.rows.filter((row) => newer(row, floor))
  return {
    rows: merge(kept, page.items.map(asListed)),
    nextCursor: page.nextCursor,
    loaded: true,
  }
}

/** A page asked for before a resync moved the cursor would leave a gap above it. */
export function withOlder(state: FeedState, requested: string, page: ReceiptsPage): FeedState {
  if (!state.loaded || state.nextCursor !== requested) return state
  return {
    ...state,
    rows: merge(state.rows, page.items.map(asListed)),
    nextCursor: page.nextCursor,
  }
}

export function withReceipt(state: FeedState, receipt: PublisherReceipt): FeedState {
  return { ...state, rows: merge(state.rows, [{ ...receipt, arrived: true }]) }
}

export function withSettlement(state: FeedState, event: SettlementEvent): FeedState {
  const settled = new Set(event.receiptIds)
  return {
    ...state,
    rows: state.rows.map((row) =>
      settled.has(row.id) && row.settledAt === null ? { ...row, settledAt: event.settledAt } : row,
    ),
  }
}

const asListed = (receipt: PublisherReceipt): FeedRow => ({ ...receipt, arrived: false })

// Instants come in one fixed ISO form, so they order as strings.
const newer = (a: PublisherReceipt, b: PublisherReceipt) =>
  a.acceptedAt === b.acceptedAt ? a.id > b.id : a.acceptedAt > b.acceptedAt

/**
 * A row already shown keeps its `arrived` mark, and settlement only ever moves forward:
 * a page read just before a batch landed must not take the settlement back.
 */
function merge(shown: readonly FeedRow[], incoming: readonly FeedRow[]): FeedRow[] {
  const byId = new Map(shown.map((row) => [row.id, row]))
  for (const row of incoming) {
    const known = byId.get(row.id)
    byId.set(
      row.id,
      known === undefined
        ? row
        : { ...row, arrived: known.arrived, settledAt: known.settledAt ?? row.settledAt },
    )
  }
  return [...byId.values()].sort((a, b) => (newer(a, b) ? -1 : 1))
}
