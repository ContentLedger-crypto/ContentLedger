import { settlerHeartbeat } from '@contentledger/db'
import { Hono } from 'hono'
import { redactKeys } from '../app.js'
import { errorChain } from '../errors.js'
import type { Database } from '../store.js'

type Pass = Pick<
  typeof settlerHeartbeat.$inferSelect,
  'passedAt' | 'intervalSeconds' | 'failedAgents'
>

export type SettlerVerdict = { healthy: true } | { healthy: false; reason: string }

// A pass that waits for `finalized` can outlast one interval; three missed in a row is a
// settler that has stopped, and an agent's withdrawal grace is only fifteen intervals long.
const STALE_AFTER_INTERVALS = 3

const ageSecondsOf = (pass: Pass, now: Date) =>
  Math.round((now.getTime() - pass.passedAt.getTime()) / 1000)

export function settlerVerdict(pass: Pass | null, now: Date): SettlerVerdict {
  if (pass === null) return { healthy: false, reason: 'settler has not reported a pass' }
  const ageSeconds = ageSecondsOf(pass, now)
  if (ageSeconds > STALE_AFTER_INTERVALS * pass.intervalSeconds) {
    return { healthy: false, reason: `settler last passed ${ageSeconds} s ago` }
  }
  if (pass.failedAgents > 0) {
    return {
      healthy: false,
      reason: `settler gave up on ${pass.failedAgents} agents in its last pass`,
    }
  }
  return { healthy: true }
}

/**
 * What an uptime monitor polls. The gateway answering is not enough: publishers are paid
 * only by the settler, so its last pass, read from the database it writes, decides.
 */
export function healthRoutes(deps: { db: Database; now: () => Date }): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    c.header('Cache-Control', 'no-store')
    let pass: Pass | null
    try {
      const [row] = await deps.db.select().from(settlerHeartbeat).limit(1)
      pass = row ?? null
    } catch (error) {
      console.error(`health: database read failed: ${redactKeys(errorChain(error))}`)
      return c.json({ status: 'down', reason: 'database unreachable' }, 503)
    }

    const now = deps.now()
    const verdict = settlerVerdict(pass, now)
    const settler = pass && {
      passedAt: pass.passedAt.toISOString(),
      ageSeconds: ageSecondsOf(pass, now),
      failedAgents: pass.failedAgents,
    }
    return verdict.healthy
      ? c.json({ status: 'ok', settler }, 200)
      : c.json({ status: 'degraded', reason: verdict.reason, settler }, 503)
  })

  return app
}
