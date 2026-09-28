import { serve } from '@hono/node-server'
import { Connection } from '@solana/web3.js'
import { z } from 'zod'
import { createApp } from './app.js'
import { rpcRegistry } from './registry.js'

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    PORT: z.coerce.number().int().positive().default(8879),
  })
  .parse(process.env)

const app = createApp({ registry: rpcRegistry(new Connection(env.SOLANA_RPC_URL, 'confirmed')) })
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close())
}
