import { fixtureUrl } from '@contentledger/fixtures'

export interface ServedContent {
  bytes: Uint8Array<ArrayBuffer>
  mediaType: string
}

export interface ContentOrigin {
  fetch(source: string): Promise<ServedContent>
}

/**
 * Only ever called for a source the registry already knows, and through the corpus
 * mapping rather than the URL itself: fetching `source` directly would make the
 * gateway an open proxy to anywhere.
 */
export function fixturesOrigin(baseUrl: string, fetchImpl: typeof fetch = fetch): ContentOrigin {
  return {
    async fetch(source) {
      const url = fixtureUrl(source, baseUrl)
      const response = await fetchImpl(url).catch((error: unknown) => {
        if (!droppedBeforeAnswer(error)) throw error
        return fetchImpl(url)
      })
      if (!response.ok) throw new Error(`origin answered ${response.status} for ${source}`)
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get('Content-Type') ?? 'application/octet-stream',
      }
    },
  }
}

/**
 * Typically a pooled keep-alive connection the origin closed just as it was reused — a
 * race between two idle timers, not a failing origin. Reading a work is idempotent, so
 * one more try on a fresh connection is safe and spares a paying agent a 500.
 */
function droppedBeforeAnswer(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause.code === 'UND_ERR_SOCKET' || cause.code === 'ECONNRESET')
  )
}
