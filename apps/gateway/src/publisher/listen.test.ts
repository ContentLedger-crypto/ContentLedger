import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ListenHandlers, listenForSettlements } from './listen.js'

const PROBE_MS = 30_000
const ECHO_MS = 5_000
const BATCH = 'bb'.repeat(32)

/** A server that echoes notifications to whichever connection is live, unless muted. */
function server() {
  const connections: Array<{ handlers: ListenHandlers; closed: boolean; deaf: boolean }> = []
  let refuse = false
  return {
    connections,
    set refuse(value: boolean) {
      refuse = value
    },
    live: () => connections.filter((c) => !c.closed),
    connect: async (handlers: ListenHandlers) => {
      if (refuse) throw new Error('ECONNREFUSED')
      const connection = { handlers, closed: false, deaf: false }
      connections.push(connection)
      handlers.listening()
      return {
        close: async () => {
          connection.closed = true
        },
      }
    },
    notify: async (payload: string) => {
      for (const c of connections) if (!c.closed && !c.deaf) c.handlers.message(payload)
    },
  }
}

function start(pg: ReturnType<typeof server>) {
  const settled: string[] = []
  const onResync = vi.fn()
  const log = vi.fn()
  const listener = listenForSettlements({
    connect: pg.connect,
    notify: pg.notify,
    onSettled: (batchId) => settled.push(batchId),
    onResync,
    probeMs: PROBE_MS,
    echoTimeoutMs: ECHO_MS,
    log,
  })
  return { listener, settled, onResync, log }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listenForSettlements', () => {
  it('passes settled batch ids on and keeps probes to itself', async () => {
    const pg = server()
    const { listener, settled, onResync } = start(pg)
    await vi.advanceTimersByTimeAsync(0)

    await pg.notify(BATCH)
    await vi.advanceTimersByTimeAsync(PROBE_MS + ECHO_MS)

    expect(settled).toEqual([BATCH])
    expect(onResync).not.toHaveBeenCalled()
    expect(pg.connections).toHaveLength(1)
    await listener.stop()
  })

  it('ignores a payload that is not a batch id', async () => {
    const pg = server()
    const { listener, settled } = start(pg)
    await vi.advanceTimersByTimeAsync(0)
    await pg.notify('BB'.repeat(32))
    await pg.notify('drop table receipts')
    expect(settled).toEqual([])
    await listener.stop()
  })

  it('replaces a connection that went deaf, then asks everyone to re-read', async () => {
    const pg = server()
    const { listener, settled, onResync, log } = start(pg)
    await vi.advanceTimersByTimeAsync(0)
    const first = pg.connections[0]
    if (first === undefined) throw new Error('not connected')
    first.deaf = true

    await vi.advanceTimersByTimeAsync(PROBE_MS + ECHO_MS)

    expect(first.closed).toBe(true)
    expect(pg.live()).toHaveLength(1)
    expect(onResync).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0]?.[0])).toMatch(/no echo/)
    await pg.notify(BATCH)
    expect(settled).toEqual([BATCH])
    await listener.stop()
  })

  it('asks for a re-read when the driver itself re-subscribes after a drop', async () => {
    const pg = server()
    const { listener, onResync } = start(pg)
    await vi.advanceTimersByTimeAsync(0)
    expect(onResync).not.toHaveBeenCalled()

    pg.connections[0]?.handlers.listening()

    expect(onResync).toHaveBeenCalledOnce()
    await listener.stop()
  })

  it('keeps trying while the database refuses, and re-reads once it is back', async () => {
    const pg = server()
    pg.refuse = true
    const { listener, onResync, log } = start(pg)
    await vi.advanceTimersByTimeAsync(PROBE_MS * 2)
    expect(pg.connections).toHaveLength(0)
    expect(String(log.mock.calls[0]?.[0])).toContain('ECONNREFUSED')

    pg.refuse = false
    await vi.advanceTimersByTimeAsync(PROBE_MS)

    expect(pg.live()).toHaveLength(1)
    expect(onResync).toHaveBeenCalledOnce()
    await listener.stop()
  })

  it('does not take a failed probe send for a deaf listener', async () => {
    const pg = server()
    const settled: string[] = []
    const log = vi.fn()
    const listener = listenForSettlements({
      connect: pg.connect,
      notify: async () => {
        throw new Error('pool exhausted')
      },
      onSettled: (batchId) => settled.push(batchId),
      onResync: () => {},
      probeMs: PROBE_MS,
      echoTimeoutMs: ECHO_MS,
      log,
    })
    await vi.advanceTimersByTimeAsync(PROBE_MS + ECHO_MS)
    expect(pg.connections).toHaveLength(1)
    expect(pg.live()).toHaveLength(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('pool exhausted')
    await listener.stop()
  })

  it('closes its connection and stops probing when stopped', async () => {
    const pg = server()
    const notify = vi.spyOn(pg, 'notify')
    const { listener } = start(pg)
    await vi.advanceTimersByTimeAsync(0)
    await listener.stop()
    await vi.advanceTimersByTimeAsync(PROBE_MS * 3)
    expect(pg.live()).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })
})
