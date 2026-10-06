import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fixturesOrigin } from './origin.js'

const SOURCE = 'https://acme-news.test/2026/ai-act-explained.html'

describe('fixturesOrigin', () => {
  it('fetches the registered source from the corpus server, bytes untouched', async () => {
    const requested: string[] = []
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0x00, 0x41)
    const origin = fixturesOrigin('http://127.0.0.1:8880', async (url) => {
      requested.push(String(url))
      return new Response(bytes, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    })

    expect(await origin.fetch(SOURCE)).toEqual({
      bytes,
      mediaType: 'text/html; charset=utf-8',
    })
    expect(requested).toEqual(['http://127.0.0.1:8880/acme-news.test/2026/ai-act-explained.html'])
  })

  it('falls back to octet-stream when the origin names no type', async () => {
    const origin = fixturesOrigin('http://127.0.0.1:8880', async () => {
      const response = new Response(Uint8Array.of(1))
      response.headers.delete('Content-Type')
      return response
    })
    expect((await origin.fetch(SOURCE)).mediaType).toBe('application/octet-stream')
  })

  it('fails when the origin does not have the registered work', async () => {
    const origin = fixturesOrigin('http://127.0.0.1:8880', async () =>
      Response.json({ error: 'not found' }, { status: 404 }),
    )
    await expect(origin.fetch(SOURCE)).rejects.toThrow(/404/)
  })

  describe('a connection that drops before any answer', () => {
    const dropped = (code: string) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error('closed'), { code }) })

    const flaky = (failures: unknown[]) => {
      let calls = 0
      const origin = fixturesOrigin('http://127.0.0.1:8880', async () => {
        calls += 1
        const failure = failures.shift()
        if (failure !== undefined) throw failure
        return new Response(Uint8Array.of(7))
      })
      return { origin, calls: () => calls }
    }

    it.each(['UND_ERR_SOCKET', 'ECONNRESET'])('is asked again once after %s', async (code) => {
      const { origin, calls } = flaky([dropped(code)])
      expect((await origin.fetch(SOURCE)).bytes).toEqual(Uint8Array.of(7))
      expect(calls()).toBe(2)
    })

    it('gives up after the second drop', async () => {
      const { origin, calls } = flaky([dropped('UND_ERR_SOCKET'), dropped('UND_ERR_SOCKET')])
      await expect(origin.fetch(SOURCE)).rejects.toThrow('fetch failed')
      expect(calls()).toBe(2)
    })

    // A refused connection or an answer, even a 5xx, says the origin is reachable and
    // has spoken; asking again at once would only double the load on a failing origin.
    it('is not asked again for a refused connection or a server error', async () => {
      const refused = flaky([dropped('ECONNREFUSED')])
      await expect(refused.origin.fetch(SOURCE)).rejects.toThrow('fetch failed')
      expect(refused.calls()).toBe(1)

      let calls = 0
      const failing = fixturesOrigin('http://127.0.0.1:8880', async () => {
        calls += 1
        return new Response('down', { status: 503 })
      })
      await expect(failing.fetch(SOURCE)).rejects.toThrow(/503/)
      expect(calls).toBe(1)
    })

    it('recovers from a real socket the server closed without answering', async () => {
      let requests = 0
      const server = createServer((req, res) => {
        requests += 1
        if (requests === 1) req.socket.destroy()
        else res.end('ok')
      })
      await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
      try {
        const { port } = server.address() as AddressInfo
        const origin = fixturesOrigin(`http://127.0.0.1:${port}`)
        expect(new TextDecoder().decode((await origin.fetch(SOURCE)).bytes)).toBe('ok')
        expect(requests).toBe(2)
      } finally {
        server.closeAllConnections()
        await new Promise((closed) => server.close(closed))
      }
    })
  })
})
