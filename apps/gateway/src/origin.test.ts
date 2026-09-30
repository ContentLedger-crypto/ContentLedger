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
})
