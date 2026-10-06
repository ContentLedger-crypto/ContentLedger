import {
  authChallengeSchema,
  type PublisherReceipt,
  publisherReceiptSchema,
  publisherSummarySchema,
  type ReceiptsPage,
  receiptsPageSchema,
  type SettlementEvent,
  sessionGrantSchema,
  settlementEventSchema,
} from '@contentledger/shared'
import { z } from 'zod'
import type { AuthApi } from '@/auth/session'
import { INCOMING, INCOMING_INTERVAL_MS, RECEIPTS, SESSION_WALLET, SUMMARY } from './mock'
import { sseMessages } from './sse'

/**
 * The one module the dashboard reads data from. What the gateway serves passes through
 * the shared contract here exactly as a live response will; what it does not serve yet
 * is re-exported below as it is, until the task that serves it.
 */

export type DataMode =
  | { readonly kind: 'gateway'; readonly apiUrl: string }
  | { readonly kind: 'preview' }

/**
 * Development always reads a gateway, through the dev server's `/v1` proxy unless one is
 * named. A production build that names none is the public preview on Pages, which has no
 * gateway to sign in to and says so on screen.
 */
export function dataModeOf(env: { DEV: boolean; VITE_API_URL?: string | undefined }): DataMode {
  const url = env.VITE_API_URL?.trim() ?? ''
  if (url === '') return env.DEV ? { kind: 'gateway', apiUrl: '' } : { kind: 'preview' }
  if (originOf(url) !== url) {
    throw new Error(`VITE_API_URL must be an origin (scheme, host, port; no path): ${url}`)
  }
  return { kind: 'gateway', apiUrl: url }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export const dataMode = dataModeOf(import.meta.env)

export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  /** Seconds, from a 429's `details.retryAfter`. */
  readonly retryAfter: number | null

  constructor(status: number, code: string | null, retryAfter: number | null) {
    super(`gateway answered ${status}${code === null ? '' : ` ${code}`}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ retryAfter: z.number().int().positive().optional() }).optional(),
  }),
})

async function refusalOf(response: Response): Promise<ApiError> {
  const refusal = refusalSchema.safeParse(await response.json().catch(() => null))
  return refusal.success
    ? new ApiError(
        response.status,
        refusal.data.error.code,
        refusal.data.error.details?.retryAfter ?? null,
      )
    : new ApiError(response.status, null, null)
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init)

export function authApiFor(apiUrl: string, fetcher: typeof fetch = defaultFetch): AuthApi {
  async function post<S extends z.ZodType>(schema: S, path: string, body: unknown) {
    const response = await fetcher(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await refusalOf(response)
    return schema.parse(await response.json()) as z.output<S>
  }

  return {
    challenge: (wallet) => post(authChallengeSchema, '/v1/auth/challenge', { wallet }),
    verify: (body) => post(sessionGrantSchema, '/v1/auth/verify', body),
  }
}

export const authApi = dataMode.kind === 'gateway' ? authApiFor(dataMode.apiUrl) : null

/** The sample publisher: the preview shows it, a signed-in dashboard shows its session. */
export const sampleWallet = SESSION_WALLET

export type FeedEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'receipt'; readonly receipt: PublisherReceipt }
  | { readonly type: 'settlement'; readonly settlement: SettlementEvent }
  | { readonly type: 'resync' }

/** What the takings feed reads: pages of receipts, and the stream of what changes them. */
export interface FeedSource {
  receipts(cursor: string | null, signal: AbortSignal): Promise<ReceiptsPage>
  /** Settles when the stream ends: resolves if the gateway closed it, rejects otherwise. */
  stream(onEvent: (event: FeedEvent) => void, signal: AbortSignal): Promise<void>
}

export function publisherApiFor(
  apiUrl: string,
  token: string,
  fetcher: typeof fetch = defaultFetch,
): FeedSource {
  const authorization = { Authorization: `Bearer ${token}` }

  return {
    async receipts(cursor, signal) {
      const query = cursor === null ? '' : `?${new URLSearchParams({ cursor })}`
      const response = await fetcher(`${apiUrl}/v1/publisher/receipts${query}`, {
        headers: authorization,
        signal,
      })
      if (!response.ok) throw await refusalOf(response)
      return receiptsPageSchema.parse(await response.json())
    },

    async stream(onEvent, signal) {
      const response = await fetcher(`${apiUrl}/v1/publisher/stream`, {
        headers: { ...authorization, Accept: 'text/event-stream' },
        signal,
      })
      if (!response.ok) throw await refusalOf(response)
      if (response.body === null) throw new Error('the stream answered without a body')
      for await (const message of sseMessages(response.body)) {
        const event = feedEventOf(message.event, message.data)
        if (event !== null) onEvent(event)
      }
    },
  }
}

// An event this dashboard does not know yet is skipped, so the gateway can add one first.
function feedEventOf(name: string, data: string): FeedEvent | null {
  switch (name) {
    case 'ready':
      return { type: 'ready' }
    case 'resync':
      return { type: 'resync' }
    case 'receipt':
      return { type: 'receipt', receipt: publisherReceiptSchema.parse(JSON.parse(data)) }
    case 'settlement':
      return { type: 'settlement', settlement: settlementEventSchema.parse(JSON.parse(data)) }
    default:
      return null
  }
}

/** The preview's feed: one page, then six arrivals four seconds apart, then silence. */
export const sampleFeed: FeedSource = {
  receipts: async () => receiptsPageSchema.parse(RECEIPTS),
  stream: (onEvent, signal) =>
    new Promise((_, reject) => {
      onEvent({ type: 'ready' })
      const timers = INCOMING.map((wire, index) =>
        setTimeout(
          () => onEvent({ type: 'receipt', receipt: publisherReceiptSchema.parse(wire) }),
          INCOMING_INTERVAL_MS * (index + 1),
        ),
      )
      const stop = () => {
        for (const timer of timers) clearTimeout(timer)
        reject(signal.reason)
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    }),
}

export const summary = publisherSummarySchema.parse(SUMMARY)

export {
  CONSUMER_TOTALS,
  type ConsumerTotal,
  EDGES,
  type Edge,
  INCLUSION_PATH,
  PERIOD_LABEL,
  PERIOD_PAID_BY_AGENTS,
  PERIOD_PROTOCOL_FEE,
  RECEIPT,
  SETTLEMENT,
  VERIFY_STEPS,
} from './mock'
