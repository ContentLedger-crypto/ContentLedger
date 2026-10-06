import type { Context } from 'hono'

export type Taken = { ok: true } | { ok: false; retryAfter: number }

export interface RateLimiter {
  take(key: string): Taken
}

interface BucketOptions {
  capacity: number
  perSecond: number
  now: () => number
  maxKeys?: number
}

/**
 * Lives in process memory: the gateway is a single process, and a limiter shared
 * across instances would cost a round trip on every request to protect against a
 * deployment that does not exist.
 */
export function tokenBucket({
  capacity,
  perSecond,
  now,
  maxKeys = 50_000,
}: BucketOptions): RateLimiter {
  // Map order is insertion order; re-inserting on every touch makes the first key
  // the least recently seen.
  const buckets = new Map<string, { tokens: number; at: number }>()

  return {
    take(key) {
      const at = now()
      const held = buckets.get(key)
      const tokens = held
        ? Math.min(capacity, held.tokens + ((at - held.at) / 1000) * perSecond)
        : capacity
      buckets.delete(key)
      const ok = tokens >= 1
      buckets.set(key, { tokens: ok ? tokens - 1 : tokens, at })
      for (const oldest of buckets.keys()) {
        if (buckets.size <= maxKeys) break
        buckets.delete(oldest)
      }
      return ok ? { ok } : { ok, retryAfter: Math.ceil((1 - tokens) / perSecond) }
    },
  }
}

/**
 * Each trusted proxy appends the address it saw, so only the last `trustedHops`
 * entries of X-Forwarded-For are written by someone other than the client.
 */
export function clientAddress(
  trustedHops: number,
  socket: (c: Context) => string,
): (c: Context) => string {
  return (c) => {
    if (trustedHops === 0) return socket(c)
    const chain = (c.req.header('X-Forwarded-For') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    return chain[chain.length - trustedHops] ?? socket(c)
  }
}
