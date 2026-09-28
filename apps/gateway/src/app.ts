import { Hono } from 'hono'
import { apiError } from './errors.js'
import type { RegistryReader } from './registry.js'
import { quoteRoutes } from './routes/quote.js'

export interface GatewayDeps {
  registry: RegistryReader
}

export function createApp({ registry }: GatewayDeps): Hono {
  const app = new Hono()
  app.route('/', quoteRoutes(registry))

  // RPC errors carry the provider URL, and with it the API key: neither the client
  // nor the host's log may see it.
  app.onError((error, c) => {
    console.error(`${c.req.method} ${c.req.path} failed: ${redactKeys(String(error))}`)
    return c.json(apiError('INTERNAL', 'internal error', {}), 500)
  })
  app.notFound((c) => c.json(apiError('NOT_FOUND', 'no such endpoint', {}), 404))

  return app
}

const redactKeys = (text: string): string => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')
