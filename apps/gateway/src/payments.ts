import { type X402Transaction, x402TransactionSchema } from '@contentledger/chain'
import { z } from 'zod'

export interface PaymentReader {
  /** `null` when the node does not have the transaction at `confirmed`, yet or at all. */
  transaction(signature: string): Promise<X402Transaction | null>
}

const rpcAnswer = z.union([
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ result: z.unknown() }),
])

/**
 * `confirmed`, not the `finalized` default: an agent presents its payment as soon as the
 * transfer lands, and finalized trails that by ~13 s. Version 1 is accepted because the
 * payer's wallet picks the version.
 */
export function rpcPayments(rpcUrl: string, fetchImpl: typeof fetch = fetch): PaymentReader {
  return {
    async transaction(signature) {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            signature,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
          ],
        }),
      })
      if (!response.ok) throw new Error(`getTransaction answered HTTP ${response.status}`)
      const answer = rpcAnswer.parse(await response.json())
      if ('error' in answer) {
        throw new Error(`getTransaction failed: ${answer.error.code} ${answer.error.message}`)
      }
      return answer.result === null ? null : x402TransactionSchema.parse(answer.result)
    },
  }
}
