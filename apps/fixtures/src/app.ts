import { Hono } from 'hono'
import type { Corpus, CorpusWork } from './corpus.js'
import { sourceIdOf } from './url.js'

const LICENCE_MARK_PATH = '/.well-known/contentledger.json'

/**
 * The mark format is our own — there is no standard for it. An attestor node
 * matches `owner` against the domain owner in the registry; the mark holds nothing
 * else, because the node takes everything else on-chain, where it is signed.
 */
interface LicenceMark {
  version: 1
  owner: string
}

const notFound = { error: { code: 'NOT_FOUND', message: 'no such source in the corpus' } } as const

export function createApp(corpus: Corpus): Hono {
  const app = new Hono()
  const owners = new Map(corpus.domains.map((domain) => [domain.host, domain.owner]))

  app.get(`/:host${LICENCE_MARK_PATH}`, (c) => {
    const owner = owners.get(c.req.param('host'))
    if (owner === undefined) {
      return c.json(notFound, 404)
    }

    return c.json({ version: 1, owner } satisfies LicenceMark)
  })

  app.get('/:host/*', (c) => {
    const host = c.req.param('host')
    const path = c.req.path.slice(`/${host}`.length)

    let work: CorpusWork | undefined
    try {
      work = corpus.bySource.get(sourceIdOf(host, path))
    } catch {
      // `sourceIdOf` throws on a non-canonical form — `/acme-news.test/` among them,
      // where the path is empty. No such source is in the corpus by definition.
      work = undefined
    }
    if (work === undefined) {
      return c.json(notFound, 404)
    }

    return c.body(work.bytes, 200, { 'Content-Type': work.mediaType })
  })

  app.notFound((c) => c.json(notFound, 404))

  return app
}
