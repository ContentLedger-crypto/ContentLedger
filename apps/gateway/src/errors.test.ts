import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { errorChain } from './errors.js'

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code })

describe('errorChain', () => {
  it('names a plain error', () => {
    expect(errorChain(new RangeError('out of range'))).toBe('RangeError: out of range')
  })

  // undici reports every transport failure as "fetch failed"; what failed, and where,
  // is only in the cause.
  it('follows the cause down to the address and the code', () => {
    const error = new TypeError('fetch failed', {
      cause: withCode('connect ECONNREFUSED 127.0.0.1:56310', 'ECONNREFUSED'),
    })
    expect(errorChain(error)).toBe(
      'TypeError: fetch failed ← Error: connect ECONNREFUSED 127.0.0.1:56310 (ECONNREFUSED)',
    )
  })

  it('lists each attempt of an aggregate cause, whose own message is empty', () => {
    const attempts = new AggregateError(
      [
        withCode('connect ECONNREFUSED ::1:8879', 'ECONNREFUSED'),
        withCode('connect ECONNREFUSED 127.0.0.1:8879', 'ECONNREFUSED'),
      ],
      '',
    )
    expect(errorChain(new TypeError('fetch failed', { cause: attempts }))).toBe(
      'TypeError: fetch failed ← AggregateError: [connect ECONNREFUSED ::1:8879 (ECONNREFUSED); connect ECONNREFUSED 127.0.0.1:8879 (ECONNREFUSED)]',
    )
  })

  it('describes something thrown that is not an error', () => {
    expect(errorChain('boom')).toBe('boom')
    expect(errorChain(new Error('outer', { cause: 42 }))).toBe('Error: outer ← 42')
  })

  it('stops on a cause that loops back', () => {
    const error = new Error('a')
    error.cause = error
    expect(errorChain(error)).toBe('Error: a')
  })
})

describe('createApp error handler', () => {
  afterEach(() => vi.restoreAllMocks())

  it('logs the whole cause chain with the provider key masked, and tells the client nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new Hono().get('/x', () => {
      throw new TypeError('fetch failed', {
        cause: withCode('getaddrinfo ENOTFOUND rpc.test/?api-key=secret123', 'ENOTFOUND'),
      })
    })
    const res = await createApp(failing).request('/x')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('ENOTFOUND')
    expect(log).toHaveBeenCalledWith(
      'GET /x failed: TypeError: fetch failed ← Error: getaddrinfo ENOTFOUND rpc.test/?api-key=*** (ENOTFOUND)',
    )
  })
})
