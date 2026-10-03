import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Position } from './protocol.js'

/**
 * A voucher whose fate the agent does not know: it was sent, and no answer said whether
 * the gateway kept it. Only one of them can ever be kept, since all share one seq.
 */
export interface Doubtful {
  receiptId: string
  next: Position
}

export interface JournalState {
  consumer: string
  position: Position
  doubtful: Doubtful[]
}

export interface Journal {
  read(): Promise<JournalState | null>
  write(state: JournalState): Promise<void>
}

const positionSchema = z.object({
  seq: z.string().regex(/^\d+$/).transform(BigInt),
  cumulative: z.string().regex(/^\d+$/).transform(BigInt),
  chain: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .transform((hex) => Uint8Array.from(Buffer.from(hex, 'hex'))),
})

const stateSchema = z.object({
  consumer: z.string(),
  position: positionSchema,
  doubtful: z.array(z.object({ receiptId: z.string(), next: positionSchema })),
})

const positionJson = ({ seq, cumulative, chain }: Position) => ({
  seq: seq.toString(),
  cumulative: cumulative.toString(),
  chain: Buffer.from(chain).toString('hex'),
})

export function fileJournal(path: string): Journal {
  return {
    async read() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      try {
        return stateSchema.parse(JSON.parse(text))
      } catch (error) {
        throw new Error(`agent journal ${path} is damaged`, { cause: error })
      }
    },

    // Written aside and renamed over: a crash mid-write must not leave half a journal.
    async write({ consumer, position, doubtful }) {
      const json = {
        consumer,
        position: positionJson(position),
        doubtful: doubtful.map((entry) => ({ ...entry, next: positionJson(entry.next) })),
      }
      const temporary = `${path}.tmp`
      await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`)
      await rename(temporary, path)
    },
  }
}
