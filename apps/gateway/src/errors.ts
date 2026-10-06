export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'NOT_LICENSED'
  | 'PAYMENT_REQUIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL'

/** `TypeError: fetch failed ← Error: connect ECONNREFUSED 127.0.0.1:8880 (ECONNREFUSED)` */
export function errorChain(error: unknown): string {
  const links: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (!(current instanceof Error)) {
      links.push(String(current))
      break
    }
    const code = 'code' in current && typeof current.code === 'string' ? ` (${current.code})` : ''
    const message =
      current instanceof AggregateError && current.message === ''
        ? `[${current.errors.map((attempt) => errorChain(attempt).replace(/^\w+: /, '')).join('; ')}]`
        : current.message
    links.push(`${current.name}: ${message}${code}`)
    current = current.cause
  }
  return links.join(' ← ')
}

export const apiError = <D extends Record<string, unknown>>(
  code: ApiErrorCode,
  message: string,
  details: D,
) => ({ error: { code, message, details } })
