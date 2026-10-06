import { describe, expect, it } from 'vitest'
import { errorChain } from './error-chain.js'

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code })

describe('errorChain', () => {
  it('follows a transport failure down to the address and the code', () => {
    const error = new TypeError('fetch failed', {
      cause: withCode('read ECONNRESET', 'ECONNRESET'),
    })
    expect(errorChain(error)).toBe('TypeError: fetch failed ← Error: read ECONNRESET (ECONNRESET)')
  })

  it('lists each attempt of an aggregate cause', () => {
    const attempts = new AggregateError(
      [withCode('connect ECONNREFUSED ::1:1', 'ECONNREFUSED')],
      '',
    )
    expect(errorChain(new TypeError('fetch failed', { cause: attempts }))).toBe(
      'TypeError: fetch failed ← AggregateError: [connect ECONNREFUSED ::1:1 (ECONNREFUSED)]',
    )
  })

  it('stops on a cause that loops back, and describes a thrown non-error', () => {
    const error = new Error('a')
    error.cause = error
    expect(errorChain(error)).toBe('Error: a')
    expect(errorChain('boom')).toBe('boom')
  })
})
