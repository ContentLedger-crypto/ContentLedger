import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { errorChain } from '../errors.js'
import type { Database } from '../store.js'

export interface ListenHandlers {
  message(payload: string): void
  /** Called on every subscription, including the driver's own after a dropped socket. */
  listening(): void
}

export interface ListenConnection {
  close(): Promise<void>
}

export interface SettlementListenerOptions {
  connect: (handlers: ListenHandlers) => Promise<ListenConnection>
  /** Sent through the ordinary pool, so an echo proves the listening socket still hears. */
  notify: (payload: string) => Promise<void>
  onSettled: (batchId: string) => void
  /** Notifications may have been lost: subscribers re-read instead of trusting the stream. */
  onResync: () => void
  probeMs: number
  echoTimeoutMs: number
  log?: (message: string) => void
}

const BATCH_ID = /^[0-9a-f]{64}$/
const PROBE = 'probe:'

/**
 * postgres.js re-subscribes by itself when a socket closes, but a half-open socket stays
 * silent with no error at all: only a probe that has to come back can tell.
 */
export function listenForSettlements(options: SettlementListenerOptions): {
  stop(): Promise<void>
} {
  const { connect, notify, onSettled, onResync, probeMs, echoTimeoutMs } = options
  const log = options.log ?? console.error
  let connection: ListenConnection | null = null
  let missed = false
  let stopped = false
  let probing = false
  let echo: { nonce: string; heard: () => void } | null = null

  const handlers = (): ListenHandlers => {
    let subscribed = false
    return {
      message(payload) {
        if (payload.startsWith(PROBE)) {
          if (echo !== null && payload === PROBE + echo.nonce) echo.heard()
        } else if (BATCH_ID.test(payload)) {
          onSettled(payload)
        }
      },
      listening() {
        if (subscribed || missed) {
          missed = false
          onResync()
        }
        subscribed = true
      },
    }
  }

  const ensureConnected = async () => {
    try {
      connection = await connect(handlers())
    } catch (error) {
      missed = true
      log(`settlement listener: cannot connect: ${errorChain(error)}`)
      return
    }
    if (stopped) await connection.close()
  }

  const probe = async () => {
    if (probing || stopped) return
    probing = true
    let timer: NodeJS.Timeout | undefined
    try {
      const live = connection
      if (live === null) return await ensureConnected()

      const nonce = randomBytes(8).toString('hex')
      const echoed = new Promise<boolean>((resolve) => {
        echo = { nonce, heard: () => resolve(true) }
        timer = setTimeout(() => resolve(false), echoTimeoutMs)
      })
      try {
        await notify(PROBE + nonce)
      } catch (error) {
        log(`settlement listener: probe not sent: ${errorChain(error)}`)
        return
      }
      if (await echoed) return

      log(`settlement listener: no echo in ${echoTimeoutMs} ms, reconnecting`)
      missed = true
      connection = null
      await live.close().catch(() => {})
      await ensureConnected()
    } finally {
      clearTimeout(timer)
      echo = null
      probing = false
    }
  }

  const interval = setInterval(() => void probe(), probeMs)
  void ensureConnected()

  return {
    async stop() {
      stopped = true
      clearInterval(interval)
      await connection?.close()
      connection = null
    },
  }
}

/** One dedicated session: LISTEN does not survive the transaction pooler. */
export function postgresListen(url: string, channel: string) {
  return async (handlers: ListenHandlers): Promise<ListenConnection> => {
    const session = postgres(url, { max: 1 })
    try {
      await session.listen(channel, handlers.message, handlers.listening)
    } catch (error) {
      await session.end({ timeout: 0 })
      throw error
    }
    return { close: () => session.end({ timeout: 1 }) }
  }
}

export const notifyThrough = (db: Database, channel: string) => async (payload: string) => {
  await db.execute(sql`select pg_notify(${channel}, ${payload})`)
}
