import { Hono } from 'hono'
import type { Corpus, CorpusWork } from './corpus.js'
import { sourceIdOf } from './url.js'

const LICENCE_MARK_PATH = '/.well-known/contentledger.json'

/**
 * Формат мітки наш — стандарту тут немає (`PLAN.md` → Атестатори). Вузол
 * зіставляє `owner` із власником домену в реєстрі; більше в мітці нічого немає,
 * бо все інше вузол бере ончейн, де воно підписане.
 */
interface LicenceMark {
  version: 1
  owner: string
}

const notFound = { error: { code: 'NOT_FOUND', message: 'джерела немає в корпусі' } } as const

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
      // `sourceIdOf` кидає на неканонічній формі — зокрема на `/acme-news.test/`,
      // де шлях порожній. Такого джерела в корпусі немає за визначенням.
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
