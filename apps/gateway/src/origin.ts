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
      const response = await fetchImpl(fixtureUrl(source, baseUrl))
      if (!response.ok) throw new Error(`origin answered ${response.status} for ${source}`)
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get('Content-Type') ?? 'application/octet-stream',
      }
    },
  }
}
