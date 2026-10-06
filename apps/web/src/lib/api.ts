import {
  authChallengeSchema,
  type PublisherReceipt,
  publisherReceiptSchema,
  publisherSummarySchema,
  receiptsPageSchema,
  sessionGrantSchema,
} from '@contentledger/shared'
import { z } from 'zod'
import type { AuthApi } from '@/auth/session'
import { INCOMING, INCOMING_INTERVAL_MS, RECEIPTS, SESSION_WALLET, SUMMARY } from './mock'

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

export function authApiFor(
  apiUrl: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): AuthApi {
  async function post<S extends z.ZodType>(schema: S, path: string, body: unknown) {
    const response = await fetcher(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const refusal = refusalSchema.safeParse(json)
      throw refusal.success
        ? new ApiError(
            response.status,
            refusal.data.error.code,
            refusal.data.error.details?.retryAfter ?? null,
          )
        : new ApiError(response.status, null, null)
    }
    return schema.parse(json) as z.output<S>
  }

  return {
    challenge: (wallet) => post(authChallengeSchema, '/v1/auth/challenge', { wallet }),
    verify: (body) => post(sessionGrantSchema, '/v1/auth/verify', body),
  }
}

export const authApi = dataMode.kind === 'gateway' ? authApiFor(dataMode.apiUrl) : null

/** The sample publisher: the preview shows it, a signed-in dashboard shows its session. */
export const sampleWallet = SESSION_WALLET

export const receipts = receiptsPageSchema.parse(RECEIPTS)

export const summary = publisherSummarySchema.parse(SUMMARY)

export function subscribeReceipts(onReceipt: (receipt: PublisherReceipt) => void): () => void {
  const timers = INCOMING.map((wire, index) =>
    setTimeout(
      () => onReceipt(publisherReceiptSchema.parse(wire)),
      INCOMING_INTERVAL_MS * (index + 1),
    ),
  )
  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}

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
