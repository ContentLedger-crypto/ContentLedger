import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'

/** Helius' published price list, applied to what the meter counted. */
export const HELIUS_CREDITS = {
  source: 'https://www.helius.dev/docs/billing/credits',
  perCall: 1,
  perCallByMethod: { getProgramAccounts: 10 } as Readonly<Record<string, number>>,
  perWsUnit: 2,
  wsUnitBytes: 100_000,
  // The current list is silent on connections; an earlier one charged a credit each, and
  // over-counting a handful of credits is the safe side of a budget verdict.
  perWsConnection: 1,
} as const

export interface LaneUsage {
  calls: Record<string, number>
  wsConnections: number
  /** Bytes the upstream streamed back, framing included, never compressed. */
  wsBytes: number
}

export interface RpcMeter {
  /** The RPC URL a process gets: its lane names it in the meter's tally. */
  url(lane: string): string
  usage(): Record<string, LaneUsage>
  close(): Promise<void>
}

export function rpcMethods(body: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return ['<unreadable>']
  }
  const calls = Array.isArray(json) ? json : [json]
  return calls.map((call: unknown) =>
    typeof call === 'object' && call !== null && 'method' in call && typeof call.method === 'string'
      ? call.method
      : '<unreadable>',
  )
}

export function creditsOf({ calls, wsConnections, wsBytes }: LaneUsage): number {
  let credits = 0
  for (const [method, count] of Object.entries(calls)) {
    credits += count * (HELIUS_CREDITS.perCallByMethod[method] ?? HELIUS_CREDITS.perCall)
  }
  return (
    credits +
    wsConnections * HELIUS_CREDITS.perWsConnection +
    Math.ceil(wsBytes / HELIUS_CREDITS.wsUnitBytes) * HELIUS_CREDITS.perWsUnit
  )
}

const laneOf = (path: string | undefined): string =>
  new URL(path ?? '/', 'http://meter').pathname.split('/')[1] || 'unlabelled'

/**
 * A counting proxy in front of the real provider, so every process of the run reaches the
 * network only through it and never holds the provider key. HTTP is counted per JSON-RPC
 * call; WebSockets are piped raw and counted by the bytes the upstream sends.
 */
export async function startRpcMeter(upstream: { http: string; ws: string }): Promise<RpcMeter> {
  const usage: Record<string, LaneUsage> = {}
  const lane = (name: string): LaneUsage => {
    usage[name] ??= { calls: {}, wsConnections: 0, wsBytes: 0 }
    return usage[name]
  }
  const sockets = new Set<Socket>()

  const http = createServer(async (req, res) => {
    const body = await readBody(req)
    const tally = lane(laneOf(req.url))
    for (const method of rpcMethods(body)) tally.calls[method] = (tally.calls[method] ?? 0) + 1
    try {
      const answer = await fetch(upstream.http, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      res.writeHead(answer.status, {
        'content-type': answer.headers.get('content-type') ?? 'application/json',
      })
      res.end(Buffer.from(await answer.arrayBuffer()))
    } catch {
      // The fetch error carries the upstream URL, and with it the key.
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(
        '{"jsonrpc":"2.0","error":{"code":-32603,"message":"rpc meter: upstream unreachable"}}',
      )
    }
  })

  const ws = createServer((_req, res) => res.writeHead(426).end())
  ws.on('upgrade', (req, client: Socket, head: Buffer) => {
    const tally = lane(laneOf(req.url))
    tally.wsConnections += 1
    const target = new URL(upstream.ws)
    const secure = target.protocol === 'wss:'
    const port = Number(target.port || (secure ? 443 : 80))
    const server: Socket = secure
      ? connectTls({ host: target.hostname, port, servername: target.hostname })
      : connectTcp({ host: target.hostname, port })
    sockets.add(client).add(server)
    server.once(secure ? 'secureConnect' : 'connect', () => {
      server.write(upgradeRequest(req, target))
      if (head.length > 0) server.write(head)
      client.pipe(server)
    })
    server.on('data', (chunk: Buffer) => {
      tally.wsBytes += chunk.length
      client.write(chunk)
    })
    const drop = () => {
      client.destroy()
      server.destroy()
      sockets.delete(client)
      sockets.delete(server)
    }
    server.on('end', () => client.end())
    client.on('end', () => server.end())
    server.on('close', drop)
    client.on('close', drop)
    server.on('error', drop)
    client.on('error', drop)
  })

  const port = await listenPair(http, ws)
  return {
    url: (name) => `http://127.0.0.1:${port}/${name}`,
    usage: () => structuredClone(usage),
    async close() {
      for (const socket of sockets) socket.destroy()
      for (const server of [http, ws]) {
        server.closeAllConnections()
        await new Promise((done) => server.close(done))
      }
    },
  }
}

function upgradeRequest(req: IncomingMessage, target: URL): string {
  const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? ''
    const lower = name.toLowerCase()
    // Without an extension offer the upstream cannot compress, so bytes counted are billed bytes.
    if (lower === 'host' || lower === 'sec-websocket-extensions') continue
    lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** web3.js reaches for WebSockets on the HTTP port plus one, so the two ports come as a pair. */
async function listenPair(http: Server, ws: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('meter has no port')
    const taken = await new Promise<boolean>((done) => {
      ws.once('error', () => done(true))
      ws.listen(address.port + 1, '127.0.0.1', () => done(false))
    })
    if (!taken) return address.port
    await new Promise((done) => http.close(done))
  }
  throw new Error('no free pair of adjacent ports for the RPC meter')
}
