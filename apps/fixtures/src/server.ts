import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadCorpus } from './corpus.js'

const corpus = loadCorpus()
const server = serve(
  { fetch: createApp(corpus).fetch, port: Number(process.env.FIXTURES_PORT ?? 8880) },
  (info) => {
    console.log(`корпус фікстур: ${corpus.bySource.size} творів на http://localhost:${info.port}`)
  },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close())
}
