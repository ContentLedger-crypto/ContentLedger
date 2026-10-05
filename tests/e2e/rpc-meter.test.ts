import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { creditsOf, type RpcMeter, rpcMethods, startRpcMeter } from './rpc-meter.js'

describe('rpcMethods', () => {
  it('names the method of a single call', () => {
    expect(
      rpcMethods('{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[]}'),
    ).toEqual(['getMultipleAccounts'])
  })

  it('names every call of a batch, since the provider bills each one', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses' },
      { jsonrpc: '2.0', id: 2, method: 'getBlockHeight' },
    ])
    expect(rpcMethods(batch)).toEqual(['getSignatureStatuses', 'getBlockHeight'])
  })

  it('counts a body it cannot read as one unknown call rather than none', () => {
    expect(rpcMethods('not json')).toEqual(['<unreadable>'])
    expect(rpcMethods('{"id":1}')).toEqual(['<unreadable>'])
  })
})

describe('creditsOf', () => {
  it('bills a call at one credit and getProgramAccounts at ten', () => {
    expect(
      creditsOf({
        calls: { getMultipleAccounts: 3, getProgramAccounts: 2 },
        wsConnections: 0,
        wsBytes: 0,
      }),
    ).toBe(23)
  })

  it('bills streamed bytes by the started 0.1 MB, plus each connection', () => {
    expect(creditsOf({ calls: {}, wsConnections: 2, wsBytes: 100_000 })).toBe(4)
    expect(creditsOf({ calls: {}, wsConnections: 1, wsBytes: 100_001 })).toBe(5)
  })

  it('bills nothing for no usage', () => {
    expect(creditsOf({ calls: {}, wsConnections: 0, wsBytes: 0 })).toBe(0)
  })
})

describe('startRpcMeter', () => {
  const servers: Server[] = []
  let meter: RpcMeter | undefined

  afterEach(async () => {
    await meter?.close()
    meter = undefined
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  })

  async function listen(server: Server): Promise<number> {
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return address.port
  }

  async function upstream() {
    const seen: { url: string | undefined; body: string }[] = []
    const upgrades: { url: string | undefined; headers: IncomingHttpHeaders }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        seen.push({ url: req.url, body })
        if (body.includes('failMe')) {
          res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"slow down"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"result":"ok"}')
      })
    })
    server.on('upgrade', (req, socket) => {
      upgrades.push({ url: req.url, headers: req.headers })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      )
      socket.write('x'.repeat(1000))
      socket.end()
    })
    const port = await listen(server)
    return { port, seen, upgrades }
  }

  it('forwards each call to the upstream with its key and counts it under its lane', async () => {
    const up = await upstream()
    meter = await startRpcMeter({
      http: `http://127.0.0.1:${up.port}/?api-key=secret`,
      ws: `ws://127.0.0.1:${up.port}/?api-key=secret`,
    })
    const res = await fetch(meter.url('gateway'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[]}',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: 'ok' })
    expect(up.seen).toEqual([
      {
        url: '/?api-key=secret',
        body: '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[]}',
      },
    ])
    expect(meter.usage()).toEqual({
      gateway: { calls: { getTransaction: 1 }, wsConnections: 0, wsBytes: 0 },
    })
  })

  it('passes an upstream refusal through unchanged, still counted', async () => {
    const up = await upstream()
    meter = await startRpcMeter({
      http: `http://127.0.0.1:${up.port}/`,
      ws: `ws://127.0.0.1:${up.port}/`,
    })
    const res = await fetch(meter.url('settler'), {
      method: 'POST',
      body: '{"jsonrpc":"2.0","id":1,"method":"failMe"}',
    })
    expect(res.status).toBe(429)
    expect(meter.usage().settler?.calls).toEqual({ failMe: 1 })
  })

  it('never shows the upstream URL to the caller, even when the upstream is down', async () => {
    const up = await upstream()
    const downPort = up.port
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
    meter = await startRpcMeter({
      http: `http://127.0.0.1:${downPort}/?api-key=secret`,
      ws: `ws://127.0.0.1:${downPort}/?api-key=secret`,
    })
    const res = await fetch(meter.url('agent'), { method: 'POST', body: '{"method":"getSlot"}' })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret')
  })

  // web3.js derives a WebSocket endpoint from an HTTP one with an explicit port by adding one.
  it('takes WebSockets on the next port, upstream path and uncompressed, counting bytes', async () => {
    const up = await upstream()
    meter = await startRpcMeter({
      http: `http://127.0.0.1:${up.port}/?api-key=secret`,
      ws: `ws://127.0.0.1:${up.port}/?api-key=secret`,
    })
    const wsPort = Number(new URL(meter.url('agent')).port) + 1
    const received = await new Promise<number>((done, fail) => {
      let bytes = 0
      const socket = connect(wsPort, '127.0.0.1', () => {
        socket.write(
          [
            'GET /agent HTTP/1.1',
            `Host: 127.0.0.1:${wsPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
            '',
            '',
          ].join('\r\n'),
        )
      })
      socket.on('data', (chunk) => {
        bytes += chunk.length
      })
      socket.on('end', () => done(bytes))
      socket.on('error', fail)
    })
    expect(received).toBeGreaterThan(1000)
    expect(up.upgrades).toHaveLength(1)
    expect(up.upgrades[0]?.url).toBe('/?api-key=secret')
    expect(up.upgrades[0]?.headers.host).toBe(`127.0.0.1:${up.port}`)
    // Helius bills uncompressed bytes; compressed frames would make the count lie low.
    expect(up.upgrades[0]?.headers['sec-websocket-extensions']).toBeUndefined()
    expect(meter.usage().agent).toEqual({ calls: {}, wsConnections: 1, wsBytes: received })
  })
})
