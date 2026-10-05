import { describe, expect, it } from 'vitest'
import { uncommitted } from './provenance.js'

const z = (...entries: string[]) => entries.map((entry) => `${entry}\0`).join('')

describe('uncommitted', () => {
  it('is empty for a clean tree', () => {
    expect(uncommitted('')).toEqual([])
  })

  it('names modified, staged and untracked files', () => {
    expect(
      uncommitted(
        z(' M fixtures/corpus/manifest.json', 'A  tests/e2e/m1.test.ts', '?? tests/x.ts'),
      ),
    ).toEqual(['fixtures/corpus/manifest.json', 'tests/e2e/m1.test.ts', 'tests/x.ts'])
  })

  // Results are what a run writes: an earlier one lying uncommitted changes no code that runs.
  it('leaves out the results the runs write', () => {
    expect(uncommitted(z('?? tests/e2e/results/m1-2026-10-05T14-30.json'))).toEqual([])
  })

  it('takes a renamed file by its new path, not its old one as an entry of its own', () => {
    expect(uncommitted(z('R  tests/e2e/new.ts', 'tests/e2e/old.ts', ' M package.json'))).toEqual([
      'tests/e2e/new.ts',
      'package.json',
    ])
  })

  it('keeps paths with spaces whole', () => {
    expect(uncommitted(z('?? docs dir/a b.ts'))).toEqual(['docs dir/a b.ts'])
  })
})
