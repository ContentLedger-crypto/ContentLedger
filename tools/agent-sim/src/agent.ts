import type { UseType } from '@contentledger/shared'
import type { Keypair } from '@solana/web3.js'
import type { Journal, JournalState } from './journal.js'
import {
  checkDelivery,
  checkOffer,
  type Position,
  parsePaymentRequired,
  type Receipt,
  signVoucher,
} from './protocol.js'

export type Log = (event: string, fields: Record<string, unknown>) => void

export interface AgentDeps {
  keypair: Keypair
  gatewayUrl: string
  fetch: typeof fetch
  journal: Journal
  /** The escrow's settled position on chain: the start of an empty journal, and its floor. */
  settledPosition: () => Promise<Position>
  log: Log
  maxAttempts?: number
}

export type Outcome =
  | { kind: 'delivered'; bytes: Uint8Array; mediaType: string; receipt: Receipt }
  /** Paid for, but what came back is not what the receipt names (FR-011a). */
  | { kind: 'disputed'; reason: string; receiptId: string }
  | { kind: 'refused'; status: number; code: string; reason?: string }

const CONSUMER = 'X-ContentLedger-Consumer'
const VOUCHER = 'X-ContentLedger-Voucher'
const OFFER = 'X-ContentLedger-Offer'
const RECEIPT = 'X-ContentLedger-Receipt'

export interface Agent {
  request(source: string, use: UseType): Promise<Outcome>
}

export function createAgent(deps: AgentDeps): Agent {
  const consumer = deps.keypair.publicKey.toBase58()
  const attempts = deps.maxAttempts ?? 3
  const url = (path: string) => new URL(path, deps.gatewayUrl)
  let loaded: JournalState | null = null

  async function state(): Promise<JournalState> {
    if (loaded) return loaded
    const settled = await deps.settledPosition()
    const stored = await deps.journal.read()
    if (stored === null) {
      loaded = { consumer, position: settled, doubtful: [] }
      await deps.journal.write(loaded)
      return loaded
    }
    if (stored.consumer !== consumer) throw new Error(`journal belongs to ${stored.consumer}`)
    if (stored.position.seq < settled.seq) {
      throw new Error(
        `journal ends at seq ${stored.position.seq}, escrow is settled to ${settled.seq}`,
      )
    }
    loaded = stored
    return loaded
  }

  async function save(next: JournalState) {
    await deps.journal.write(next)
    loaded = next
  }

  /**
   * A receipt's id is the hash of the body the agent signed over, so the public receipt
   * endpoint answers "did the gateway keep my voucher" without trusting anything else.
   */
  async function resolveDoubt(current: JournalState): Promise<JournalState> {
    for (const doubtful of current.doubtful) {
      const res = await deps.fetch(url(`/v1/receipts/${doubtful.receiptId}`))
      if (res.status === 404) continue
      if (res.status !== 200) throw new Error(`receipt lookup answered HTTP ${res.status}`)
      deps.log('paid-undelivered', {
        receiptId: doubtful.receiptId,
        seq: Number(doubtful.next.seq),
      })
      const next = { ...current, position: doubtful.next, doubtful: [] }
      await save(next)
      return next
    }
    return current
  }

  async function request(source: string, use: UseType): Promise<Outcome> {
    const path = `/v1/content?source=${encodeURIComponent(source)}&use=${use}`
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = await resolveDoubt(await state())

      const quoted = await deps.fetch(url(path), { headers: { [CONSUMER]: consumer } })
      if (quoted.status !== 402) return refusal(quoted)
      const required = parsePaymentRequired(await quoted.json())
      if (required === null) throw new Error('402 without a payment offer this agent can read')
      if ('unavailable' in required.escrow) {
        return {
          kind: 'refused',
          status: 402,
          code: 'PAYMENT_REQUIRED',
          reason: required.escrow.unavailable,
        }
      }
      const { offer } = required.escrow

      const problem = checkOffer(offer, required.quote, current.position, consumer, use)
      // A doubtful voucher may have been kept after the receipt lookup said no.
      if (problem === 'seq-mismatch' && current.doubtful.length > 0) continue
      if (problem !== null)
        throw new Error(`gateway offered a draft this agent will not sign: ${problem}`)

      const signed = signVoucher(deps.keypair, current.position, offer)
      const doubtful = { receiptId: signed.receiptId, next: signed.next }
      // Recorded before it is sent: once the voucher leaves, only the gateway knows its fate.
      await save({ ...current, doubtful: [...current.doubtful, doubtful] })
      const forget = () =>
        save({ ...current, doubtful: current.doubtful.filter((d) => d !== doubtful) })

      let paid: Response
      try {
        paid = await deps.fetch(url(path), {
          headers: { [CONSUMER]: consumer, [VOUCHER]: signed.header, [OFFER]: offer.id },
        })
      } catch (error) {
        deps.log('voucher-unanswered', { receiptId: signed.receiptId, error: String(error) })
        continue
      }

      if (paid.status === 200) {
        await save({ ...current, position: signed.next, doubtful: [] })
        const bytes = new Uint8Array(await paid.arrayBuffer())
        const delivery = checkDelivery(
          bytes,
          paid.headers.get(RECEIPT) ?? undefined,
          offer.body,
          signed.receiptId,
        )
        if (!delivery.ok)
          return { kind: 'disputed', reason: delivery.reason, receiptId: signed.receiptId }
        return {
          kind: 'delivered',
          bytes,
          mediaType: paid.headers.get('Content-Type') ?? '',
          receipt: delivery.receipt,
        }
      }
      if (paid.status >= 500) continue

      const json: unknown = await paid.json()
      const reason = reasonOf(json)
      // A replay means something already holds this seq — perhaps a doubtful voucher of ours.
      if (paid.status === 400 && reason === 'replayed') continue
      // Every other answer says the voucher was dropped unrecorded.
      await forget()
      if (paid.status === 402 && parsePaymentRequired(json)?.reason === 'offer-expired') continue
      return { kind: 'refused', status: paid.status, code: codeOf(json), ...(reason && { reason }) }
    }
    throw new Error(`no delivery after ${attempts} attempts`)
  }

  return { request }
}

async function refusal(res: Response): Promise<Outcome> {
  const json: unknown = await res.json().catch(() => null)
  const reason = reasonOf(json)
  return { kind: 'refused', status: res.status, code: codeOf(json), ...(reason && { reason }) }
}

const errorOf = (json: unknown): Record<string, unknown> =>
  typeof json === 'object' && json !== null && 'error' in json && typeof json.error === 'object'
    ? (json.error as Record<string, unknown>)
    : {}

const codeOf = (json: unknown): string => {
  const { code } = errorOf(json)
  return typeof code === 'string' ? code : 'UNKNOWN'
}

const reasonOf = (json: unknown): string | undefined => {
  const { details } = errorOf(json)
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined
  return typeof details.reason === 'string' ? details.reason : undefined
}
