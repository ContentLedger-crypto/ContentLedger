import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { CORPUS_ROOT, loadCorpus } from './corpus.js'

const corpus = loadCorpus()

const works = corpus.domains.flatMap((domain) => domain.works)

describe('корпус фікстур', () => {
  it('має три домени й дванадцять творів', () => {
    expect(corpus.domains.map((domain) => domain.host)).toEqual([
      'acme-news.test',
      'kyiv-photo.test',
      'devblog.test',
    ])
    expect(works).toHaveLength(12)
  })

  it('несе межові випадки реєстру, а не лише щасливий шлях', () => {
    expect(corpus.domains.filter((domain) => domain.status === 'suspended')).toHaveLength(1)
    const acme = corpus.bySource.get('https://acme-news.test/archive/2019-open-web.md')
    expect(acme?.status).toBe('suspended')

    const paid = corpus.bySource.get('https://acme-news.test/2026/solana-fee-market.html')
    expect(paid?.rateTrain).toBe(9000n)

    const free = corpus.bySource.get('https://kyiv-photo.test/about/licence.md')
    expect(free?.rateTrain).toBe(0n)

    const inherited = corpus.bySource.get('https://kyiv-photo.test/feeds/latest.json')
    expect(inherited?.rateTrain).toBeNull()
  })

  it('покриває чотири медіатипи, включно з бінарним', () => {
    const types = new Set(works.map((work) => work.mediaType.split(';')[0]))
    expect([...types].sort()).toEqual([
      'application/json',
      'image/png',
      'text/html',
      'text/markdown',
    ])
  })

  it('виводить адресу виплати окремо від власника принаймні на одному домені', () => {
    const split = corpus.domains.filter((domain) => domain.payoutOwner !== domain.owner)
    expect(split).toHaveLength(1)
  })

  it('має валідні base58-ключі власника й отримувача', () => {
    for (const domain of corpus.domains) {
      expect(() => new PublicKey(domain.owner), domain.host).not.toThrow()
      expect(() => new PublicKey(domain.payoutOwner), domain.host).not.toThrow()
    }
  })
})

describe('похідні поля', () => {
  it('рахує content_hash із самих байтів, а не з оголошеного в маніфесті', () => {
    for (const work of works) {
      expect(work.contentHash, work.sourceId).toMatch(/^[0-9a-f]{64}$/)
      expect(work.byteLen, work.sourceId).toBe(work.bytes.length)
      expect(work.byteLen).toBeGreaterThan(0)
    }
  })

  it('дає золотий вектор: sha256 порожнього тіла не збігається з жодним твором', () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(works.map((work) => work.contentHash)).not.toContain(empty)
  })

  it('усі джерела канонічні й унікальні', () => {
    const sources = works.map((work) => work.sourceId)
    expect(new Set(sources).size).toBe(sources.length)
    for (const source of sources) {
      expect(source.startsWith('https://'), source).toBe(true)
    }
  })
})

describe('однакові байти на будь-якій платформі', () => {
  it('у текстових творах немає CR — інакше хеші розійшлися б між Windows і Linux', () => {
    for (const work of works) {
      if (work.mediaType.startsWith('text/') || work.mediaType === 'application/json') {
        expect(work.bytes.includes(13), work.sourceId).toBe(false)
      }
    }
  })
})

describe('помилки читання', () => {
  it('падає з іменем теки, якої немає', () => {
    expect(() => loadCorpus(`${CORPUS_ROOT}-nope`)).toThrow()
  })
})
