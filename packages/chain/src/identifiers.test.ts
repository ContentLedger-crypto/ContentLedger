import { bytesToHex } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { canonicalSourceId, hostSeed, isCanonicalHost, sourceSeed } from './identifiers.js'

describe('isCanonicalHost — дзеркало перевірки в програмі', () => {
  it('приймає канонічні хости', () => {
    for (const host of [
      'example.com',
      'a.b',
      'sub.domain.example.com',
      'xn--80ak6aa92e.com',
      'news-site.example.co.uk',
      '1.2.3.4',
    ]) {
      expect(isCanonicalHost(host), host).toBe(true)
    }
  })

  it('відхиляє ті самі 16 форм, що й програма', () => {
    for (const host of [
      '',
      'Example.com',
      'EXAMPLE.COM',
      'example.com.',
      '.example.com',
      'example..com',
      'https://example.com',
      'example.com:443',
      'example.com/path',
      'example.com ',
      ' example.com',
      'example',
      '-example.com',
      'example-.com',
      'приклад.com',
      'example.com?q=1',
    ]) {
      expect(isCanonicalHost(host), host).toBe(false)
    }
  })

  it('тримає межі довжини так само, як програма', () => {
    const label = 'a'.repeat(63)
    expect(isCanonicalHost(`${label}.com`)).toBe(true)
    expect(isCanonicalHost(`${'a'.repeat(64)}.com`)).toBe(false)
    expect(isCanonicalHost(`${[label, label, label, label].join('.')}.com`)).toBe(false)
  })
})

describe('hostSeed', () => {
  it('дає той самий сід на той самий хост і різні на різні', () => {
    expect(bytesToHex(hostSeed('example.com'))).toEqual(bytesToHex(hostSeed('example.com')))
    expect(bytesToHex(hostSeed('example.com'))).not.toEqual(bytesToHex(hostSeed('example.org')))
  })

  it('не хешує неканонічний хост, а кидає', () => {
    expect(() => hostSeed('Example.com')).toThrow(/канонічн/)
  })
})

describe('canonicalSourceId — правило, якого програма не бачить', () => {
  it('приймає абсолютний https-URL із канонічним хостом', () => {
    expect(canonicalSourceId('https://example.com/articles/1')).toBe(
      'https://example.com/articles/1',
    )
  })

  it('не переписує шлях: регістр і слеш у кінці значущі', () => {
    expect(canonicalSourceId('https://example.com/Articles/1')).toBe(
      'https://example.com/Articles/1',
    )
    expect(canonicalSourceId('https://example.com/a/')).toBe('https://example.com/a/')
  })

  it('відхиляє все, що дало б два ідентифікатори одному твору', () => {
    for (const url of [
      'http://example.com/a',
      'https://Example.com/a',
      'https://example.com:443/a',
      'https://example.com/a#section',
      'https://user:pass@example.com/a',
      '/articles/1',
      'example.com/a',
      'https://example.com',
    ]) {
      expect(() => canonicalSourceId(url), url).toThrow()
    }
  })

  it('порожній шлях і голий слеш не є твором', () => {
    expect(() => canonicalSourceId('https://example.com/')).toThrow()
  })

  it('запит зберігається — це різні твори', () => {
    expect(canonicalSourceId('https://example.com/a?page=2')).toBe('https://example.com/a?page=2')
    expect(bytesToHex(sourceSeed('https://example.com/a?page=2'))).not.toEqual(
      bytesToHex(sourceSeed('https://example.com/a')),
    )
  })
})
