import type { UseType } from '@contentledger/shared'
import type { Keypair } from '@solana/web3.js'
import type { Journal, JournalState } from './journal.js'
import {
  checkDelivery,
  checkOffer,
  type PaymentRequired,
  type Position,
  parsePaymentRequired,
  parseReceipt,
  type Receipt,
  signVoucher,
} from './protocol.js'
import {
  checkX402Delivery,
  type PaymentRail,
  type PendingPayment,
  paymentInstructions,
  paymentProof,
} from './x402.js'

export type Log = (event: string, fields: Record<string, unknown>) => void

export interface AgentDeps {
  keypair: Keypair
  gatewayUrl: string
  fetch: typeof fetch
  journal: Journal
  /** The escrow's settled position on chain: the start of an empty journal, and its floor. */
  settledPosition: () => Promise<Position>
  log: Log
  /** Without one the agent pays by voucher only, and has no x402 fallback. */
  rail?: PaymentRail
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  /** How many times a landed x402 payment is presented before it is left for later. */
  maxPresentations?: number
}

export type Outcome =
  | { kind: 'delivered'; bytes: Uint8Array; mediaType: string; receipt: Receipt }
  /** Paid for, but what came back is not what the receipt names (FR-011a). */
  | { kind: 'disputed'; reason: string; receiptId: string | null }
  | { kind: 'refused'; status: number; code: string; reason?: string }

export interface RequestOptions {
  /** Escrow unless told otherwise; x402 is the fallback when escrow cannot take it. */
  pay?: 'escrow' | 'x402'
}

const CONSUMER = 'X-ContentLedger-Consumer'
const VOUCHER = 'X-ContentLedger-Voucher'
const OFFER = 'X-ContentLedger-Offer'
const RECEIPT = 'X-ContentLedger-Receipt'
const PAYMENT = 'X-ContentLedger-Payment'
const PAYMENT_PROOF = 'X-ContentLedger-Payment-Proof'

// The escrow cannot take this request, but the payer can still pay for it outright.
const FALLBACK_REASONS = new Set(['escrow-missing', 'insufficient-funds', 'withdrawal-requested'])

// The gateway reads payments at `confirmed` from its own node, which may trail ours.
const PRESENT_DELAY_MS = 500

export interface Agent {
  request(source: string, use: UseType, options?: RequestOptions): Promise<Outcome>
}

export function createAgent(deps: AgentDeps): Agent {
  const consumer = deps.keypair.publicKey.toBase58()
  const attempts = deps.maxAttempts ?? 3
  const presentations = deps.maxPresentations ?? 5
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  const url = (path: string) => new URL(path, deps.gatewayUrl)
  const contentPath = (source: string, use: UseType) =>
    `/v1/content?source=${encodeURIComponent(source)}&use=${use}`
  let loaded: JournalState | null = null

  async function state(): Promise<JournalState> {
    if (loaded) return loaded
    const settled = await deps.settledPosition()
    const stored = await deps.journal.read()
    if (stored === null) {
      loaded = { consumer, position: settled, doubtful: [], payments: [] }
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

  async function request(
    source: string,
    use: UseType,
    options: RequestOptions = {},
  ): Promise<Outcome> {
    await redeemPending()
    const path = contentPath(source, use)
    if (options.pay === 'x402') {
      const quoted = await deps.fetch(url(path), { headers: { [CONSUMER]: consumer } })
      if (quoted.status !== 402) return refusal(quoted)
      const required = parsePaymentRequired(await quoted.json())
      if (required === null) throw new Error('402 without a payment offer this agent can read')
      return payX402(source, use, required)
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = await resolveDoubt(await state())

      const quoted = await deps.fetch(url(path), { headers: { [CONSUMER]: consumer } })
      if (quoted.status !== 402) return refusal(quoted)
      const required = parsePaymentRequired(await quoted.json())
      if (required === null) throw new Error('402 without a payment offer this agent can read')
      if ('unavailable' in required.escrow) {
        const reason = required.escrow.unavailable
        if (deps.rail && required.x402 !== null && FALLBACK_REASONS.has(reason)) {
          deps.log('fallback-x402', { source, reason })
          return payX402(source, use, required)
        }
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

  async function payX402(
    source: string,
    use: UseType,
    required: PaymentRequired,
  ): Promise<Outcome> {
    const rail = deps.rail
    if (!rail) throw new Error('this agent has no payment rail for x402')
    if (required.x402 === null) {
      return { kind: 'refused', status: 402, code: 'PAYMENT_REQUIRED', reason: 'x402-not-offered' }
    }
    const { quote } = required
    if (quote.useType !== use || quote.tariff + quote.fee !== quote.total) {
      throw new Error('gateway asked for a payment this agent will not make: terms-mismatch')
    }
    const built = paymentInstructions(deps.keypair.publicKey, required.x402, quote)
    if (!built.ok) {
      throw new Error(`gateway asked for a payment this agent will not make: ${built.problem}`)
    }

    const prepared = await rail.prepare(built.instructions)
    const payment: PendingPayment = {
      ...prepared,
      source,
      use,
      work: quote.work,
      tariff: quote.tariff.toString(),
      fee: quote.fee.toString(),
    }
    // Recorded before it is sent: once it lands the money has moved, whatever happens next.
    const current = await state()
    await save({ ...current, payments: [...current.payments, payment] })
    return settlePayment(rail, payment)
  }

  async function settlePayment(rail: PaymentRail, payment: PendingPayment): Promise<Outcome> {
    const landing = await rail.land(payment)
    if (landing !== 'landed') {
      await forgetPayment(payment)
      deps.log(`payment-${landing}`, { signature: payment.signature })
      return {
        kind: 'refused',
        status: 402,
        code: 'PAYMENT_REQUIRED',
        reason: `payment-${landing}`,
      }
    }
    return present(payment)
  }

  async function present(payment: PendingPayment): Promise<Outcome> {
    const { signature } = payment
    const headers = {
      [CONSUMER]: consumer,
      [PAYMENT]: signature,
      [PAYMENT_PROOF]: paymentProof(deps.keypair, signature),
    }
    for (let attempt = 1; attempt <= presentations; attempt += 1) {
      let res: Response
      try {
        res = await deps.fetch(url(contentPath(payment.source, payment.use)), { headers })
      } catch (error) {
        deps.log('payment-unanswered', { signature, error: String(error) })
        continue
      }

      if (res.status === 200) {
        await forgetPayment(payment)
        const bytes = new Uint8Array(await res.arrayBuffer())
        const header = res.headers.get(RECEIPT) ?? undefined
        const delivery = checkX402Delivery(bytes, header, payment, consumer)
        if (!delivery.ok) {
          const receiptId = parseReceipt(header)?.id ?? null
          return { kind: 'disputed', reason: delivery.reason, receiptId }
        }
        return {
          kind: 'delivered',
          bytes,
          mediaType: res.headers.get('Content-Type') ?? '',
          receipt: delivery.receipt,
        }
      }
      if (res.status >= 500) {
        await sleep(PRESENT_DELAY_MS)
        continue
      }

      const json: unknown = await res.json()
      const reason = reasonOf(json)
      if (res.status === 400 && reason === 'payment-not-found') {
        await sleep(PRESENT_DELAY_MS)
        continue
      }
      // Any other answer is final for this payment: redeemed already, or refused for good.
      await forgetPayment(payment)
      if (res.status === 400 && reason === 'replayed') {
        deps.log('paid-undelivered', { signature })
      } else {
        deps.log('payment-rejected', { signature, status: res.status, reason })
      }
      return { kind: 'refused', status: res.status, code: codeOf(json), ...(reason && { reason }) }
    }
    // Landed, yet not redeemed: it stays in the journal, presented first on the next request.
    deps.log('payment-unredeemed', { signature })
    return { kind: 'refused', status: 400, code: 'INVALID_INPUT', reason: 'payment-not-found' }
  }

  async function redeemPending(): Promise<void> {
    for (const payment of (await state()).payments) {
      if (!deps.rail) throw new Error('the journal holds x402 payments and this agent has no rail')
      const outcome = await settlePayment(deps.rail, payment)
      deps.log('payment-recovered', {
        signature: payment.signature,
        outcome: outcome.kind,
        ...(outcome.kind === 'refused' && { reason: outcome.reason }),
      })
    }
  }

  async function forgetPayment(payment: PendingPayment): Promise<void> {
    const current = await state()
    await save({
      ...current,
      payments: current.payments.filter((kept) => kept.signature !== payment.signature),
    })
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
