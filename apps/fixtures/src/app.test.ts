import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { loadCorpus } from './corpus.js'

const corpus = loadCorpus()
const app = createApp(corpus)

describe('ліцензійна мітка', () => {
  it('віддає власника домену за /.well-known/contentledger.json', async () => {
    const res = await app.request('/acme-news.test/.well-known/contentledger.json')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      version: 1,
      owner: '7ddMq1eic5MmuNAvoUzBnFo7epc383GAMyoY1atS7PQZ',
    })
  })

  it('віддає мітку і для знятого домену — статус є справою реєстру, не джерела', async () => {
    const res = await app.request('/devblog.test/.well-known/contentledger.json')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ owner: expect.any(String) })
  })

  it('на невідомому домені не вигадує мітки', async () => {
    const res = await app.request('/nosuch.test/.well-known/contentledger.json')

    expect(res.status).toBe(404)
  })
})

describe('видача вмісту', () => {
  it('віддає текстовий твір байт у байт із оголошеним медіатипом', async () => {
    const work = corpus.bySource.get('https://acme-news.test/2026/ai-act-explained.html')
    const res = await app.request('/acme-news.test/2026/ai-act-explained.html')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(work?.bytes)
  })

  it('віддає бінарний твір без спотворення', async () => {
    const work = corpus.bySource.get('https://kyiv-photo.test/gallery/podil-morning.png')
    const res = await app.request('/kyiv-photo.test/gallery/podil-morning.png')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(work?.bytes)
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('віддає знятий твір так само — платіж вирішує реєстр, а не сервер джерел', async () => {
    const res = await app.request('/acme-news.test/archive/2019-open-web.md')

    expect(res.status).toBe(200)
  })
})

describe('чого сервер не віддає', () => {
  it('невідомий шлях під відомим доменом', async () => {
    const res = await app.request('/acme-news.test/2026/not-a-work.html')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('невідомий домен', async () => {
    const res = await app.request('/nosuch.test/anything')

    expect(res.status).toBe(404)
  })

  it('нічого поза маніфестом — вихід із теки корпусу не працює', async () => {
    for (const path of [
      '/acme-news.test/../../package.json',
      '/acme-news.test/%2e%2e/%2e%2e/package.json',
      '/../fixtures/corpus/manifest.json',
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('корінь без домену', async () => {
    expect((await app.request('/')).status).toBe(404)
  })

  it('домен без шляху — це не твір', async () => {
    expect((await app.request('/acme-news.test/')).status).toBe(404)
    expect((await app.request('/acme-news.test')).status).toBe(404)
  })
})
