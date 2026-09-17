import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usdcAmountSchema } from '@contentledger/shared'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { z } from 'zod'
import { sourceIdOf } from './url.js'

export const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/corpus')

const statusSchema = z.enum(['active', 'suspended'])

const base58KeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'не схоже на base58-ключ')

const manifestSchema = z.object({
  version: z.literal(1),
  domains: z
    .array(
      z.object({
        host: z.string(),
        owner: base58KeySchema,
        payoutOwner: base58KeySchema,
        rateTrain: usdcAmountSchema,
        rateInference: usdcAmountSchema,
        status: statusSchema,
        works: z
          .array(
            z.object({
              path: z.string().startsWith('/'),
              mediaType: z.string().min(1),
              status: statusSchema,
              rateTrain: usdcAmountSchema.optional(),
              rateInference: usdcAmountSchema.optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

export type LicenceStatus = z.infer<typeof statusSchema>

export interface CorpusWork {
  host: string
  path: string
  sourceId: string
  mediaType: string
  status: LicenceStatus
  /** `null` — перекриття не задано; нуль тут є ставкою «безкоштовно». */
  rateTrain: bigint | null
  rateInference: bigint | null
  /** Параметр не косметичний: `Hono.body` не приймає `ArrayBufferLike`. */
  bytes: Uint8Array<ArrayBuffer>
  contentHash: string
  byteLen: number
}

export interface CorpusDomain {
  host: string
  owner: string
  payoutOwner: string
  rateTrain: bigint
  rateInference: bigint
  status: LicenceStatus
  works: CorpusWork[]
}

export interface Corpus {
  domains: CorpusDomain[]
  bySource: ReadonlyMap<string, CorpusWork>
}

/**
 * `content_hash` і `byte_len` **виводяться з байтів**, а не оголошуються в
 * маніфесті: оголошене значення стало б другим джерелом правди, яке розходиться
 * з файлом мовчки — і розходження випливло б аж на devnet як розбіжність хешу.
 *
 * Увесь корпус читається в памʼять на старті. Дванадцять файлів — це дешево, а
 * запит більше не торкається файлової системи взагалі, тож вихід за межі теки
 * неможливий за побудовою, а не завдяки перевірці шляху.
 */
export function loadCorpus(root: string = CORPUS_ROOT): Corpus {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')),
  )

  const bySource = new Map<string, CorpusWork>()
  const domains = manifest.domains.map((domain) => ({
    ...domain,
    works: domain.works.map((work) => {
      const bytes = Uint8Array.from(readFileSync(join(root, domain.host, work.path)))
      const loaded: CorpusWork = {
        host: domain.host,
        path: work.path,
        sourceId: sourceIdOf(domain.host, work.path),
        mediaType: work.mediaType,
        status: work.status,
        rateTrain: work.rateTrain ?? null,
        rateInference: work.rateInference ?? null,
        bytes,
        contentHash: bytesToHex(sha256(bytes)),
        byteLen: bytes.length,
      }
      bySource.set(loaded.sourceId, loaded)
      return loaded
    }),
  }))

  return { domains, bySource }
}
