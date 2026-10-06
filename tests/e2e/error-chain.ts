/**
 * The same walk as the gateway's `errorChain`, kept here rather than imported: this
 * package does not depend on the gateway, and a run that broke on "fetch failed" with
 * no cause cannot tell which of its local services dropped the connection.
 */
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
