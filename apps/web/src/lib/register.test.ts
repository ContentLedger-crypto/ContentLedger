import {
  type PreparedRegistration,
  type RegistrationRequest,
  type RegistrationStatus,
  registrationRefusalSchema,
  registrationStatusSchema,
} from '@contentledger/shared'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, RegistrationRefused, type RegistrationSource } from './api'
import {
  bytesOfBase64,
  CHECK_INTERVAL_MS,
  domainDraft,
  hostOfSource,
  type RegistrationStep,
  register,
  SendError,
  type Stop,
  stopText,
  type TransactionSender,
  workDraft,
} from './register'

const ADDRESS = 'FCACSUUdntxKB1sAqoyvZ6b7EQRGmcwdBY5dkWEdgxME'
const SIGNATURE =
  'U7kAUVNnP6cCjvyAV9P9i6PqJcmnrHZeP8hmrFhvnXS27F3awFVYB2Acx8FfKUTDAaK9JCEycor6BzmZmxEdrwL7'
const TRANSACTION = Uint8Array.from([1, 0, 255, 7, 64])
const PREPARED: PreparedRegistration = {
  transaction: btoa(String.fromCharCode(...TRANSACTION)),
  address: ADDRESS,
  lastValidBlockHeight: 4242,
}
const REQUEST: RegistrationRequest = {
  kind: 'domain',
  host: 'atlasquarterly.org',
  rateTrain: 1500n,
  rateInference: 500n,
}
const CHAIN = 'solana:devnet'

/** A gateway that answers each status check from the list, then keeps answering the last. */
function fakeSource(
  answers: ReadonlyArray<RegistrationStatus | Error>,
  prepare: RegistrationSource['prepare'] = async () => PREPARED,
) {
  let asked = 0
  const status = vi.fn<RegistrationSource['status']>(async () => {
    const answer = answers[Math.min(asked, answers.length - 1)]
    asked += 1
    if (answer === undefined) throw new Error('no answer scripted')
    if (answer instanceof Error) throw answer
    return answer
  })
  const source: RegistrationSource = {
    domains: async () => ({ domains: [] }),
    prepare: vi.fn(prepare),
    status,
  }
  return { source, status }
}

async function run(
  source: RegistrationSource,
  send: TransactionSender = async () => SIGNATURE,
  signal = new AbortController().signal,
) {
  const steps: RegistrationStep[] = []
  const unauthorized = vi.fn()
  const pauses: number[] = []
  await register(
    REQUEST,
    {
      source,
      send,
      chain: CHAIN,
      pause: async (ms) => {
        pauses.push(ms)
      },
    },
    { step: (step) => steps.push(step), unauthorized },
    signal,
  )
  return { steps, unauthorized, pauses, last: steps.at(-1) }
}

describe('register', () => {
  it('prepares, has the wallet send the bytes it was handed, and asks until confirmed', async () => {
    const { source, status } = fakeSource([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'confirmed' },
    ])
    const send = vi.fn<TransactionSender>(async () => SIGNATURE)

    const { steps, pauses } = await run(source, send)

    expect(source.prepare).toHaveBeenCalledWith(REQUEST, expect.any(AbortSignal))
    expect(send).toHaveBeenCalledWith(TRANSACTION)
    expect(status).toHaveBeenCalledTimes(3)
    expect(status).toHaveBeenCalledWith(SIGNATURE, 4242, expect.any(AbortSignal))
    expect(pauses).toEqual([CHECK_INTERVAL_MS, CHECK_INTERVAL_MS])
    expect(steps.map((step) => step.phase)).toEqual([
      'preparing',
      'signing',
      'confirming',
      'registered',
    ])
    expect(steps.at(-1)).toEqual({ phase: 'registered', address: ADDRESS, signature: SIGNATURE })
  })

  it('stops on a named refusal without asking the wallet for anything', async () => {
    const { source } = fakeSource([], async () => {
      throw new RegistrationRefused('source-taken')
    })
    const send = vi.fn<TransactionSender>()

    const { last } = await run(source, send)

    expect(send).not.toHaveBeenCalled()
    expect(last).toEqual({
      phase: 'stopped',
      stop: { kind: 'refused', reason: 'source-taken' },
      signature: null,
    })
  })

  it.each<[string, Error, Stop]>([
    ['a busy gateway', new ApiError(429, 'RATE_LIMITED', 3), { kind: 'busy', retryAfter: 3 }],
    ['a gateway fault', new ApiError(500, 'INTERNAL', null), { kind: 'gateway', status: 500 }],
    ['no gateway at all', new TypeError('Failed to fetch'), { kind: 'unreachable' }],
    ['an answer outside the contract', new Error('zod: invalid'), { kind: 'unreadable' }],
  ])('names %s while preparing', async (_, error, stop) => {
    const { source } = fakeSource([], async () => {
      throw error
    })
    expect((await run(source)).last).toEqual({ phase: 'stopped', stop, signature: null })
  })

  it('hands a refused session back instead of naming it, before and after sending', async () => {
    const before = fakeSource([], async () => {
      throw new ApiError(401, 'UNAUTHORIZED', null)
    })
    const early = await run(before.source)
    expect(early.unauthorized).toHaveBeenCalledOnce()
    expect(early.last?.phase).toBe('preparing')

    const after = fakeSource([new ApiError(401, 'UNAUTHORIZED', null)])
    const late = await run(after.source)
    expect(late.unauthorized).toHaveBeenCalledOnce()
    expect(late.last?.phase).toBe('confirming')
  })

  it('names what the wallet could not do, and what the wallet itself said', async () => {
    const { source } = fakeSource([{ state: 'confirmed' }])

    const cannot = await run(source, async () => {
      throw new SendError('other-chain')
    })
    expect(cannot.last).toEqual({
      phase: 'stopped',
      stop: { kind: 'cannot-send', reason: 'other-chain', chain: CHAIN },
      signature: null,
    })

    // Phantom rejects with a plain object, not an Error.
    const declined = await run(source, () =>
      Promise.reject({ code: 4001, message: 'User rejected the request.' }),
    )
    expect(declined.last).toEqual({
      phase: 'stopped',
      stop: { kind: 'wallet', message: 'User rejected the request.' },
      signature: null,
    })

    const silent = await run(source, () => Promise.reject(undefined))
    expect(silent.last).toMatchObject({
      stop: { kind: 'wallet', message: 'it stopped without saying why.' },
    })
  })

  it('ends on what the network decided, keeping the signature', async () => {
    for (const [status, stop] of [
      [{ state: 'expired' }, { kind: 'expired' }],
      [
        { state: 'failed', reason: 'already-registered' },
        { kind: 'failed', reason: 'already-registered' },
      ],
    ] as const) {
      const { source } = fakeSource([{ state: 'pending' }, status])
      expect((await run(source)).last).toEqual({ phase: 'stopped', stop, signature: SIGNATURE })
    }
  })

  it('keeps asking through a lost gateway, says so, and says when it is back', async () => {
    const { source, status } = fakeSource([
      new TypeError('Failed to fetch'),
      new ApiError(429, 'RATE_LIMITED', 5),
      { state: 'pending' },
      { state: 'confirmed' },
    ])

    const { steps, pauses } = await run(source)

    expect(status).toHaveBeenCalledTimes(4)
    expect(pauses).toEqual([1000, 5000, CHECK_INTERVAL_MS])
    expect(steps.filter((step) => step.phase === 'confirming').map((step) => step.lost)).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(steps.at(-1)?.phase).toBe('registered')
  })

  it('stops quietly once aborted, whatever is in flight', async () => {
    const controller = new AbortController()
    const { source } = fakeSource([{ state: 'pending' }])
    const steps: RegistrationStep[] = []

    await register(
      REQUEST,
      {
        source,
        send: async () => SIGNATURE,
        chain: CHAIN,
        pause: async () => controller.abort(),
      },
      { step: (step) => steps.push(step), unauthorized: vi.fn() },
      controller.signal,
    )

    expect(steps.at(-1)?.phase).toBe('confirming')
  })
})

describe('stopText', () => {
  it('names every reason the gateway or the network can give, in the dashboard’s English', () => {
    const texts = [
      ...registrationRefusalSchema.options.map((reason) => stopText({ kind: 'refused', reason })),
      ...registrationStatusSchema.options[3].shape.reason.options.map((reason) =>
        stopText({ kind: 'failed', reason }),
      ),
    ]
    expect(new Set(texts).size).toBe(texts.length)
    for (const text of texts) expect(text).toMatch(/^[\x20-\x7E’]+$/)
  })

  it('says nothing was paid only when nothing was sent', () => {
    expect(stopText({ kind: 'refused', reason: 'domain-missing' })).toContain('nothing was paid')
    expect(stopText({ kind: 'failed', reason: 'unauthorized' })).toContain(
      'fee for the attempt was spent',
    )
    expect(stopText({ kind: 'cannot-send', reason: 'other-chain', chain: CHAIN })).toContain(CHAIN)
  })
})

describe('domainDraft', () => {
  it('reads the rates into base units and sends the host as typed', () => {
    expect(
      domainDraft({ host: ' atlasquarterly.org ', rateTrain: '0.0015', rateInference: '0' }),
    ).toEqual({
      ok: true,
      request: { kind: 'domain', host: 'atlasquarterly.org', rateTrain: 1500n, rateInference: 0n },
    })
    // The gateway names a host out of canonical form: one rule, in one place.
    expect(domainDraft({ host: 'Atlas.org', rateTrain: '1', rateInference: '1' })).toMatchObject({
      ok: true,
      request: { host: 'Atlas.org' },
    })
  })

  it.each([
    [{ host: '', rateTrain: '1', rateInference: '1' }, 'host'],
    [{ host: 'a.org', rateTrain: '', rateInference: '1' }, 'rateTrain'],
    [{ host: 'a.org', rateTrain: '1', rateInference: '0.0000001' }, 'rateInference'],
    [{ host: 'a.org', rateTrain: '-1', rateInference: '1' }, 'rateTrain'],
    [{ host: 'a.org', rateTrain: '1e3', rateInference: '1' }, 'rateTrain'],
    [{ host: 'a.org', rateTrain: '18446744073709.551616', rateInference: '1' }, 'rateTrain'],
  ])('names the field that is wrong: %o', (form, field) => {
    expect(domainDraft(form)).toMatchObject({ ok: false, field })
  })

  it('takes the largest amount the program does', () => {
    expect(
      domainDraft({ host: 'a.org', rateTrain: '18446744073709.551615', rateInference: '.5' }),
    ).toMatchObject({ ok: false, field: 'rateInference' })
    expect(
      domainDraft({ host: 'a.org', rateTrain: '18446744073709.551615', rateInference: '0.5' }),
    ).toMatchObject({ ok: true, request: { rateTrain: 2n ** 64n - 1n, rateInference: 500_000n } })
  })
})

describe('workDraft', () => {
  const source = 'https://atlasquarterly.org/2026/04/salt-line'

  it('leaves an empty rate to the domain and keeps a set one, even zero', () => {
    expect(workDraft({ source, rateTrain: '', rateInference: '0' })).toEqual({
      ok: true,
      request: { kind: 'work', source, rateTrain: null, rateInference: 0n },
    })
  })

  it('names a missing address and an unreadable rate', () => {
    expect(workDraft({ source: ' ', rateTrain: '', rateInference: '' })).toMatchObject({
      ok: false,
      field: 'source',
    })
    expect(workDraft({ source, rateTrain: '', rateInference: '0,5' })).toMatchObject({
      ok: false,
      field: 'rateInference',
    })
  })
})

describe('helpers', () => {
  it('finds the host an address would sit under, if it reads as one', () => {
    expect(hostOfSource('https://atlasquarterly.org/a')).toBe('atlasquarterly.org')
    expect(hostOfSource('atlasquarterly.org/a')).toBeNull()
  })

  it('decodes the gateway’s base64 byte for byte', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(bytesOfBase64(btoa(String.fromCharCode(...all)))).toEqual(all)
  })
})
