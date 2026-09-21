import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configPda, decodeConfig } from '@contentledger/chain'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { bootstrapPlan } from './plan.js'
import { applyStep, readSnapshot } from './rpc.js'

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    'skip-program': { type: 'boolean', default: false },
    rpc: { type: 'string' },
    operator: { type: 'string' },
    mint: { type: 'string' },
    'fee-bps': { type: 'string', default: '1000' },
    'node-share-bps': { type: 'string', default: '0' },
    'grace-s': { type: 'string', default: '900' },
  },
})

const bps = z.coerce.number().int().min(0).max(10_000)
const options = z
  .object({
    rpc: z.url(),
    operator: z.string().min(1),
    mint: z.string().min(32).optional(),
    protocolFeeBps: bps,
    nodeShareBps: bps,
    voucherGraceS: z.coerce.bigint().positive(),
  })
  .parse({
    rpc: values.rpc ?? process.env.SOLANA_RPC_URL,
    operator: values.operator ?? process.env.OPERATOR_KEYPAIR_PATH,
    mint: values.mint ?? process.env.USDC_MINT,
    protocolFeeBps: values['fee-bps'],
    nodeShareBps: values['node-share-bps'],
    voucherGraceS: values['grace-s'],
  })

const repoRoot = resolve(import.meta.dirname, '../../..')
/** `.env` пише шляхи від кореня репо, а pnpm запускає скрипт із теки пакета. */
const operatorPath = resolve(repoRoot, options.operator)

/**
 * anchor-cli і Agave живуть у WSL, Node-тулчейн — на Windows. Шлях до ключа
 * відносний від кореня репо, тож один і той самий файл видно з обох боків.
 */
function deployProgram(): void {
  const script = 'tools/deploy/deploy.sh'
  const args = [options.operator, options.rpc]
  const result =
    process.platform === 'win32'
      ? spawnSync('wsl.exe', ['--cd', repoRoot, '-e', 'bash', '-l', script, ...args], {
          stdio: 'inherit',
        })
      : spawnSync('bash', ['-l', script, ...args], { cwd: repoRoot, stdio: 'inherit' })

  if (result.status !== 0) {
    throw new Error(`${script} завершився з кодом ${result.status}`)
  }
}

async function main(): Promise<void> {
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(operatorPath, 'utf8'))),
  )
  const connection = new Connection(options.rpc, 'confirmed')

  if (values.apply && !values['skip-program']) {
    deployProgram()
  }

  const requestedMint = options.mint === undefined ? null : new PublicKey(options.mint)
  const plan = bootstrapPlan(await readSnapshot(connection, operator.publicKey, requestedMint))

  console.log(`оператор   ${operator.publicKey.toBase58()}`)
  console.log(`мінт       ${plan.mint ?? '— (буде створений)'}`)
  for (const problem of plan.problems) {
    console.log(`! ${problem}`)
  }
  for (const step of plan.steps) {
    console.log(`  ${step}`)
  }
  if (plan.problems.length > 0) {
    process.exitCode = 1
    return
  }
  if (plan.steps.length === 0) {
    console.log('кроків немає — усе на місці')
  }
  if (!values.apply) {
    return
  }

  const { protocolFeeBps, nodeShareBps, voucherGraceS } = options
  let mint = plan.mint === null ? null : new PublicKey(plan.mint)
  for (const step of plan.steps) {
    mint = await applyStep(connection, operator, step, mint, {
      protocolFeeBps,
      nodeShareBps,
      voucherGraceS,
    })
    console.log(`✓ ${step}${step === 'create_mint' ? `  ${mint.toBase58()}` : ''}`)
  }

  const info = await connection.getAccountInfo(configPda()[0])
  if (info === null) {
    throw new Error('Config не зʼявився після init_config')
  }
  const config = decodeConfig(info.data)
  console.log(
    `Config     fee ${config.protocolFeeBps} bps · node ${config.nodeShareBps} bps · grace ${config.voucherGraceS} s · mint ${config.mint}`,
  )
  if (plan.steps.includes('create_mint')) {
    console.log(`\nдопиши в .env: USDC_MINT=${config.mint}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
