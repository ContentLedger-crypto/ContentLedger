import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** A production build served as a host would: files as they are, any other path the app shell. */
export async function serveStatic(
  root: string,
): Promise<{ origin: string; close(): Promise<void> }> {
  const base = normalize(root) + sep
  const server = createServer(async (req, res) => {
    const path = normalize(
      join(base, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)),
    )
    const file = path.startsWith(base) && extname(path) !== '' ? path : join(base, 'index.html')
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  }
}
