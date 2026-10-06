import { Hono } from 'hono'
import { apiError, errorChain } from './errors.js'

/** Route groups arrive built, each with its own dependencies; this adds what they share. */
export function createApp(...routes: Hono[]): Hono {
  const app = new Hono()
  for (const group of routes) app.route('/', group)

  // RPC errors carry the provider URL, and with it the API key: neither the client
  // nor the host's log may see it.
  app.onError((error, c) => {
    console.error(`${c.req.method} ${c.req.path} failed: ${redactKeys(errorChain(error))}`)
    return c.json(apiError('INTERNAL', 'internal error', {}), 500)
  })
  app.notFound((c) => c.json(apiError('NOT_FOUND', 'no such endpoint', {}), 404))

  return app
}

const redactKeys = (text: string): string => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')
