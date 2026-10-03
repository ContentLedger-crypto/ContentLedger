import { z } from 'zod'
import { rpcNetwork } from './network.js'
import { gatewayPublication } from './publication.js'
import { type Steps, verifyReceipt } from './verify.js'

const env = z
  .object({
    SOLANA_RPC_URL: z.url(),
    GATEWAY_URL: z.url().default('http://127.0.0.1:8879'),
  })
  .parse(process.env)

const redactKeys = (text: string): string => text.replace(/(api-key=)[^&\s"']+/gi, '$1***')

const STEP_TITLES: Record<keyof Steps, string> = {
  onchain: '1 root and chain from the network',
  inclusion: '2 inclusion path to the root',
  chain: '3 payer chain over the composition',
  amounts: '4 amounts against the debit',
}

async function main(): Promise<number> {
  const id = z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'usage: verify-receipt <receipt id, 64 hex>')
    .parse(process.argv[2])
  const report = await verifyReceipt(id, {
    network: rpcNetwork(env.SOLANA_RPC_URL),
    publication: gatewayPublication(env.GATEWAY_URL),
  })
  if (!('steps' in report)) {
    console.log(`receipt ${id}: ${report.outcome}`)
    return 1
  }
  for (const [step, verdict] of Object.entries(report.steps) as [
    keyof Steps,
    Steps[keyof Steps],
  ][]) {
    const mark = { pass: '✓', fail: '✗', skipped: '·' }[verdict.status]
    const reason = verdict.status === 'fail' ? ` — ${verdict.reason}` : ''
    console.log(`${mark} ${STEP_TITLES[step]}${reason}`)
  }
  console.log(`receipt ${id}: ${report.outcome}`)
  return report.outcome === 'verified' ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(redactKeys(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  },
)
