import { describe, expect, it } from 'vitest'
import { acceptedAtColumns } from './accepted-at.js'

const CANONICAL = '2026-09-03T17:04:11.412Z'

describe('acceptedAtColumns', () => {
  it('обидві колонки походять з одного рядка', () => {
    const { acceptedAt, acceptedTs } = acceptedAtColumns(CANONICAL)
    expect(acceptedAt).toBe(CANONICAL)
    expect(acceptedTs.toISOString()).toBe(CANONICAL)
    expect(acceptedTs.getTime()).toBe(Date.parse(CANONICAL))
  })

  it('мілісекунди не губляться', () => {
    expect(acceptedAtColumns('2026-09-03T17:04:11.001Z').acceptedTs.getMilliseconds()).toBe(1)
    expect(acceptedAtColumns('2026-09-03T17:04:11.000Z').acceptedTs.getMilliseconds()).toBe(0)
  })

  it('відхиляє інші коректні записи того самого моменту', () => {
    for (const value of [
      '2026-09-03T17:04:11Z',
      '2026-09-03T17:04:11.412000Z',
      '2026-09-03T17:04:11.412+00:00',
      '2026-09-03T20:04:11.412+03:00',
      '2026-09-03 17:04:11.412Z',
    ]) {
      expect(() => acceptedAtColumns(value), value).toThrow(/канонічн/)
    }
  })

  it('відхиляє дату, якої не існує, хоч форма й правильна', () => {
    expect(() => acceptedAtColumns('2026-02-30T17:04:11.412Z')).toThrow(/не існує/)
    expect(() => acceptedAtColumns('2026-13-01T17:04:11.412Z')).toThrow()
  })
})
