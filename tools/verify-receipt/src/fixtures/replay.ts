import { z } from 'zod'
import recording from './devnet-batch-1-4.json'

export const RPC_URL = 'http://rpc.test'
export const GATEWAY_URL = 'http://gateway.test'

export const CONSUMER = '2NGugv7R7XXE7FVCS8iqLDEbWu2KRu48AK63A35y3ZVG'
export const ESCROW = 'BokvGA1FZ7yVJhhHRgkhEMaGUvfaE1PjpdrwQdxSverd'
export const SETTLEMENT_LOG = '3xYBeQzGonJxabAX3VdfMucsvf3zpcNXB4DvsKG2HS6D'
export const TX_SIG =
  '5EPZVgE5Enq11KeEQWsYRHXxM8XxM4ernVYLWz2vSnCQgP5755PNZRhGW294vbQGrNmVMQNPPkLu7s7v4324Vqcp'
export const RECEIPT_IDS = [
  'da34bb9570abbcc2c48bed81c6560528074b8a79df0d520276b9bb63c7d6e5bd',
  '024f1aea200b79a694199494b112fcef9b84314c6bee617ec32f724992e67aa1',
  '3bb445b729500c3488c8bde29d6f3a1a7599d28dbd241edb0dfe315706527680',
  '24c35c4a684483a8c44abd21350205fed02b8b974daf288260245ec5474ab00b',
] as const

export type RecordedRpc = Record<string, Record<string, unknown>>
export type RecordedGateway = Record<string, unknown>

/** A fresh deep copy each time, so a test that edits it cannot leak into the next one. */
export const recorded = (): { rpc: RecordedRpc; gateway: RecordedGateway } =>
  structuredClone(recording)

const rpcRequest = z.object({
  method: z.string(),
  params: z.tuple([z.unknown()]).rest(z.unknown()),
})

const paramKey = (param: unknown): string =>
  Array.isArray(param) ? param.join(',') : String(param)

/**
 * Answers RPC and gateway requests with what devnet and the gateway answered on
 * 2026-10-03 for the first live batch, `seq 1..4`. Anything not recorded answers as the
 * real thing does for an unknown key: `null` from the node, 404 from the gateway.
 */
export function replay({ rpc, gateway } = recorded()): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    if (url === RPC_URL) {
      const { method, params } = rpcRequest.parse(JSON.parse(String(init?.body)))
      const result = rpc[method]?.[paramKey(params[0])] ?? null
      return Response.json({ jsonrpc: '2.0', id: 1, result })
    }
    const body = gateway[url.slice(GATEWAY_URL.length)]
    return body === undefined
      ? Response.json({ error: { code: 'NOT_FOUND', message: 'not recorded' } }, { status: 404 })
      : Response.json(body)
  }
}
