import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileJournal, type JournalState } from './journal.js'

const dir = () => mkdtempSync(join(tmpdir(), 'agent-journal-'))

const state: JournalState = {
  consumer: 'Agent111111111111111111111111111111111111111',
  position: { seq: 3n, cumulative: 6600n, chain: new Uint8Array(32).fill(7) },
  doubtful: [
    {
      receiptId: 'ab'.repeat(32),
      next: { seq: 4n, cumulative: 8800n, chain: new Uint8Array(32).fill(8) },
    },
  ],
}

describe('fileJournal', () => {
  it('is empty before the first write', async () => {
    expect(await fileJournal(join(dir(), 'journal.json')).read()).toBeNull()
  })

  it('gives back exactly what was written', async () => {
    const journal = fileJournal(join(dir(), 'journal.json'))
    await journal.write(state)
    expect(await journal.read()).toEqual(state)
  })

  it('replaces the file whole, leaving no temporary behind', async () => {
    const at = dir()
    const journal = fileJournal(join(at, 'journal.json'))
    await journal.write(state)
    await journal.write({ ...state, doubtful: [] })
    expect(readdirSync(at)).toEqual(['journal.json'])
    expect((await journal.read())?.doubtful).toEqual([])
  })

  // Starting over from the chain would sign seqs the gateway already holds.
  it('refuses a damaged journal instead of starting over', async () => {
    const path = join(dir(), 'journal.json')
    writeFileSync(path, '{"consumer":')
    await expect(fileJournal(path).read()).rejects.toThrow(/journal/)
  })
})
