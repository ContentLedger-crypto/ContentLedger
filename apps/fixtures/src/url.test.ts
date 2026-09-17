import { describe, expect, it } from 'vitest'
import { fixturePath, fixtureUrl, sourceIdOf } from './url.js'

const BASE = 'http://localhost:8880'

describe('fixturePath', () => {
  it('кладе хост першим сегментом шляху', () => {
    expect(fixturePath('https://acme-news.test/2026/ai-act-explained.html')).toBe(
      '/acme-news.test/2026/ai-act-explained.html',
    )
  })

  it('не втрачає вкладеності шляху', () => {
    expect(fixturePath('https://kyiv-photo.test/gallery/podil-morning.png')).toBe(
      '/kyiv-photo.test/gallery/podil-morning.png',
    )
  })

  it('відхиляє неканонічне джерело, а не переписує його', () => {
    expect(() => fixturePath('https://ACME-News.test/a')).toThrow(TypeError)
    expect(() => fixturePath('http://acme-news.test/a')).toThrow(TypeError)
    expect(() => fixturePath('https://acme-news.test/')).toThrow(TypeError)
  })
})

describe('fixtureUrl', () => {
  it('приклеює шлях до бази', () => {
    expect(fixtureUrl('https://devblog.test/posts/hono-sse.html', BASE)).toBe(
      'http://localhost:8880/devblog.test/posts/hono-sse.html',
    )
  })

  it('не подвоює слеш, якщо база закінчується на нього', () => {
    expect(fixtureUrl('https://devblog.test/feeds/atom.json', 'http://localhost:8880/')).toBe(
      'http://localhost:8880/devblog.test/feeds/atom.json',
    )
  })
})

describe('sourceIdOf', () => {
  it('є оберненим до fixturePath', () => {
    const source = 'https://acme-news.test/data/2026-crawler-traffic.json'
    const path = fixturePath(source)
    const [, host, ...rest] = path.split('/')
    expect(sourceIdOf(host ?? '', `/${rest.join('/')}`)).toBe(source)
  })

  it('відхиляє хост, який не пройшов би реєстрацію', () => {
    expect(() => sourceIdOf('acme_news.test', '/a')).toThrow(TypeError)
    expect(() => sourceIdOf('localhost', '/a')).toThrow(TypeError)
  })
})
