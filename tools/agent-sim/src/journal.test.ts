import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  payments: [
    {
      signature: '5'.repeat(88),
      transaction: 'AQID',
      blockhash: '1'.repeat(32),
      lastValidBlockHeight: 4_200,
      source: 'https://acme-news.test/a.html',
      use: 'inference',
      work: 'Work1111111111111111111111111111111111111111',
      tariff: '500',
      fee: '50',
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

  it('reads a journal written before x402 as one with no pending payments', async () => {
    const path = join(dir(), 'journal.json')
    const journal = fileJournal(path)
    await journal.write(state)
    const { payments: _payments, ...older } = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify(older))
    expect(await journal.read()).toEqual({ ...state, payments: [] })
  })

  // Starting over from the chain would sign seqs the gateway already holds.
  it('refuses a damaged journal instead of starting over', async () => {
    const path = join(dir(), 'journal.json')
    writeFileSync(path, '{"consumer":')
    await expect(fileJournal(path).read()).rejects.toThrow(/journal/)
  })
})
