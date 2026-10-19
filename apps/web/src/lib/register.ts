import {
  MAX_USDC_BASE_UNITS,
  type RegistrationRefusal,
  type RegistrationRequest,
  type RegistrationStatus,
  USDC_DECIMALS,
} from '@contentledger/shared'
import { ApiError, RegistrationRefused, type RegistrationSource } from './api'
import { retryDelayMs } from './follow'

const AMOUNT = new RegExp(`^(\\d+)(?:\\.(\\d{1,${USDC_DECIMALS}}))?$`)

/** "0.0015" -> 1500n. `null` for anything that is not an amount of USDC the program takes. */
export function parseUsdc(text: string): bigint | null {
  const match = AMOUNT.exec(text.trim())
  if (match === null) return null
  const [, whole = '', fraction = ''] = match
  const units =
    BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))
  return units <= MAX_USDC_BASE_UNITS ? units : null
}

/** Signs a prepared transaction in the wallet and sends it, answering with its signature. */
export type TransactionSender = (transaction: Uint8Array) => Promise<string>

export type SendFailure = 'cannot-send' | 'other-account' | 'other-chain'

export class SendError extends Error {
  readonly reason: SendFailure

  constructor(reason: SendFailure) {
    super(`the wallet cannot send: ${reason}`)
    this.name = 'SendError'
    this.reason = reason
  }
}

type FailedReason = Extract<RegistrationStatus, { state: 'failed' }>['reason']

/** Why a registration ended without one. Each says whether anything was paid. */
export type Stop =
  | { readonly kind: 'refused'; readonly reason: RegistrationRefusal }
  | { readonly kind: 'failed'; readonly reason: FailedReason }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cannot-send'; readonly reason: SendFailure; readonly chain: string }
  | { readonly kind: 'wallet'; readonly message: string }
  | { readonly kind: 'busy'; readonly retryAfter: number | null }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'gateway'; readonly status: number }
  /** An answer outside the shared contract. */
  | { readonly kind: 'unreadable' }

export type RegistrationStep =
  | { readonly phase: 'preparing' }
  | { readonly phase: 'signing' }
  /** `lost`: the gateway did not answer the last check; the transaction may still land. */
  | { readonly phase: 'confirming'; readonly signature: string; readonly lost: boolean }
  | { readonly phase: 'registered'; readonly address: string; readonly signature: string }
  | { readonly phase: 'stopped'; readonly stop: Stop; readonly signature: string | null }

export interface RegistrationSink {
  step(step: RegistrationStep): void
  /** The gateway refused the session. Whatever was sent may still land; nothing is retried. */
  unauthorized(): void
}

export type Pause = (ms: number, signal: AbortSignal) => Promise<void>

export const CHECK_INTERVAL_MS = 1500

/**
 * Prepare → sign and send → ask until the network has decided. The gateway answers
 * `expired` once the blockhash can no longer land, so asking always ends while it answers.
 */
export async function register(
  request: RegistrationRequest,
  {
    source,
    send,
    chain,
    pause = sleep,
  }: { source: RegistrationSource; send: TransactionSender; chain: string; pause?: Pause },
  sink: RegistrationSink,
  signal: AbortSignal,
): Promise<void> {
  const stop = (stop: Stop, signature: string | null = null) =>
    sink.step({ phase: 'stopped', stop, signature })

  sink.step({ phase: 'preparing' })
  let prepared: Awaited<ReturnType<RegistrationSource['prepare']>>
  try {
    prepared = await source.prepare(request, signal)
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof RegistrationRefused) return stop({ kind: 'refused', reason: error.reason })
    if (isUnauthorized(error)) return sink.unauthorized()
    return stop(gatewayStop(error))
  }

  sink.step({ phase: 'signing' })
  let signature: string
  try {
    signature = await send(bytesOfBase64(prepared.transaction))
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof SendError)
      return stop({ kind: 'cannot-send', reason: error.reason, chain })
    return stop({ kind: 'wallet', message: walletMessage(error) })
  }

  let failures = 0
  sink.step({ phase: 'confirming', signature, lost: false })
  while (!signal.aborted) {
    let status: RegistrationStatus
    try {
      status = await source.status(signature, prepared.lastValidBlockHeight, signal)
    } catch (error) {
      if (signal.aborted) return
      if (isUnauthorized(error)) return sink.unauthorized()
      failures += 1
      sink.step({ phase: 'confirming', signature, lost: true })
      const retryAfter = error instanceof ApiError ? error.retryAfter : null
      await pause(retryDelayMs(failures - 1, retryAfter), signal)
      continue
    }
    switch (status.state) {
      case 'confirmed':
        return sink.step({ phase: 'registered', address: prepared.address, signature })
      case 'failed':
        return stop({ kind: 'failed', reason: status.reason }, signature)
      case 'expired':
        return stop({ kind: 'expired' }, signature)
      case 'pending':
        if (failures > 0) sink.step({ phase: 'confirming', signature, lost: false })
        failures = 0
        await pause(CHECK_INTERVAL_MS, signal)
    }
  }
}

const REFUSED: Readonly<Record<RegistrationRefusal, string>> = {
  'host-not-canonical':
    'Enter the host alone, in lowercase, as example.org: no https://, port, path or trailing dot.',
  'source-not-canonical':
    'Enter the full https:// address of the work exactly as it is served: a lowercase host, a path, no port and no #fragment.',
  'domain-taken': 'This domain is already registered. If it is yours, it is listed above.',
  'domain-missing':
    'The domain of this address is not registered yet. Register the domain first, then its works.',
  'domain-not-yours': 'The domain of this address is registered to another wallet.',
  'source-taken': 'This address is already registered as a work, so it cannot be registered again.',
  'source-unreachable':
    'The gateway could not read this address, so it cannot record what the work contains. Check that the page is published and try again.',
}

const FAILED: Readonly<Record<FailedReason, string>> = {
  'already-registered':
    'The network refused the transaction: this was registered by another transaction first.',
  unauthorized: 'The network refused the transaction: this wallet does not own the domain.',
  'host-not-canonical': 'The network refused the host: it is not in canonical form.',
  rejected: 'The network refused the transaction.',
}

const NOTHING_SENT = 'Nothing was sent and nothing was paid.'

/** What the publisher reads when a registration ends without one, in the dashboard's English. */
export function stopText(stop: Stop): string {
  switch (stop.kind) {
    case 'refused':
      return `${REFUSED[stop.reason]} ${NOTHING_SENT}`
    case 'failed':
      return `${FAILED[stop.reason]} The network fee for the attempt was spent; nothing was registered.`
    case 'expired':
      return 'The transaction was not confirmed in time and can no longer land, so nothing was paid. Prepare it again.'
    case 'cannot-send':
      return `${cannotSendText(stop.reason, stop.chain)} ${NOTHING_SENT}`
    case 'wallet':
      return `The wallet did not send the transaction: ${stop.message}`
    case 'busy': {
      const wait = stop.retryAfter === null ? 'a moment' : `${stop.retryAfter} seconds`
      return `Too many requests from this address. Try again in ${wait}. ${NOTHING_SENT}`
    }
    case 'unreachable':
      return `The gateway could not be reached. Check the connection and try again. ${NOTHING_SENT}`
    case 'gateway':
      return `The gateway answered HTTP ${stop.status}. Try again later. ${NOTHING_SENT}`
    case 'unreadable':
      return `The gateway answered with something this dashboard cannot read. ${NOTHING_SENT}`
  }
}

function cannotSendText(reason: SendFailure, chain: string): string {
  switch (reason) {
    case 'cannot-send':
      return 'This wallet cannot send transactions itself. Sign in with one that can, such as Phantom, Solflare or Backpack.'
    case 'other-account':
      return 'The wallet is no longer connected with the account this session signed in with. Switch back to it and try again.'
    case 'other-chain':
      return `The wallet does not offer ${chain}, the network this gateway registers on.`
  }
}

function gatewayStop(error: unknown): Stop {
  if (error instanceof ApiError) {
    return error.status === 429
      ? { kind: 'busy', retryAfter: error.retryAfter }
      : { kind: 'gateway', status: error.status }
  }
  return error instanceof TypeError ? { kind: 'unreachable' } : { kind: 'unreadable' }
}

const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401

function walletMessage(error: unknown): string {
  const message = error instanceof Error || isMessage(error) ? error.message : ''
  return message === '' ? 'it stopped without saying why.' : message
}

// Wallets reject with plain objects as often as with errors: `{ code: 4001, message }`.
const isMessage = (value: unknown): value is { message: string } =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  typeof value.message === 'string'

export function bytesOfBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export interface RateFields {
  readonly rateTrain: string
  readonly rateInference: string
}

export type Draft =
  | { readonly ok: true; readonly request: RegistrationRequest }
  | {
      readonly ok: false
      readonly field: 'host' | 'source' | keyof RateFields
      readonly problem: string
    }

const NOT_AN_AMOUNT = 'Enter an amount in USDC with at most six decimals, such as 0.0015.'

/**
 * Only what the gateway cannot be asked about is checked here: an amount is read into
 * base units before it is sent. Host and address go as typed; the gateway names what
 * is wrong with them, so the rule lives in one place.
 */
export function domainDraft(form: { readonly host: string } & RateFields): Draft {
  const host = form.host.trim()
  if (host === '')
    return { ok: false, field: 'host', problem: 'Enter the domain, such as example.org.' }
  const rateTrain = parseUsdc(form.rateTrain)
  if (rateTrain === null) return rateMissing(form, 'rateTrain')
  const rateInference = parseUsdc(form.rateInference)
  if (rateInference === null) return rateMissing(form, 'rateInference')
  return { ok: true, request: { kind: 'domain', host, rateTrain, rateInference } }
}

function rateMissing(form: RateFields, field: keyof RateFields): Draft {
  const problem =
    form[field].trim() === '' ? 'Enter a rate. 0 lets this use be taken for free.' : NOT_AN_AMOUNT
  return { ok: false, field, problem }
}

/** An empty rate is the domain's: the work takes it, and follows it when it changes. */
export function workDraft(form: { readonly source: string } & RateFields): Draft {
  const source = form.source.trim()
  if (source === '') {
    return {
      ok: false,
      field: 'source',
      problem: 'Enter the address of the work, starting with https://.',
    }
  }
  const rates: Record<keyof RateFields, bigint | null> = { rateTrain: null, rateInference: null }
  for (const field of ['rateTrain', 'rateInference'] as const) {
    if (form[field].trim() === '') continue
    rates[field] = parseUsdc(form[field])
    if (rates[field] === null) return { ok: false, field, problem: NOT_AN_AMOUNT }
  }
  return { ok: true, request: { kind: 'work', source, ...rates } }
}

/** The registered domain an address would sit under, if the address can be read at all. */
export function hostOfSource(source: string): string | null {
  try {
    return new URL(source.trim()).hostname
  } catch {
    return null
  }
}
