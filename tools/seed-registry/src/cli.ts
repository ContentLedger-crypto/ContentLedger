import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadCorpus } from '@contentledger/fixtures'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { diffSeedPlan, type SeedStepStatus } from './diff.js'
import { buildSeedPlan } from './plan.js'
import { applyStep, readRegistry } from './rpc.js'

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    rpc: { type: 'string' },
    operator: { type: 'string' },
    keys: { type: 'string', default: '.secrets/fixtures' },
  },
})

const keypair = (path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))

/** Ключі індексуються за pubkey, а не за іменем файла: імен корпус не задає. */
function loadOwners(directory: string): Map<string, Keypair> {
  const owners = new Map<string, Keypair>()

  for (const file of readdirSync(directory)) {
    if (file.endsWith('.keypair.json')) {
      const loaded = keypair(join(directory, file))
      owners.set(loaded.publicKey.toBase58(), loaded)
    }
  }

  return owners
}

function report(statuses: SeedStepStatus[]): void {
  for (const [index, { step, state, note }] of statuses.entries()) {
    const mark = { todo: ' ', done: '✓', mismatch: '!' }[state]
    const number = String(index + 1).padStart(2)
    console.log(
      `${mark} ${number} ${step.kind.padEnd(17)} ${step.subject}${note ? `  ${note}` : ''}`,
    )
  }

  const count = (state: string) => statuses.filter((entry) => entry.state === state).length
  console.log(
    `\nдо виконання ${count('todo')} · зроблено ${count('done')} · розбіжностей ${count('mismatch')}`,
  )
}

async function main(): Promise<void> {
  const operatorPath = values.operator ?? process.env.OPERATOR_KEYPAIR_PATH
  const rpcUrl = values.rpc ?? process.env.SOLANA_RPC_URL

  const plan = buildSeedPlan(
    loadCorpus(),
    operatorPath === undefined ? PublicKey.default : keypair(operatorPath).publicKey,
  )

  if (values.offline) {
    report(diffSeedPlan(plan, { domains: new Map(), works: new Map() }))
    return
  }

  if (rpcUrl === undefined) {
    throw new Error('потрібен --rpc або SOLANA_RPC_URL; для друку плану без мережі — --offline')
  }
  if (operatorPath === undefined) {
    throw new Error('потрібен --operator або OPERATOR_KEYPAIR_PATH')
  }

  const connection = new Connection(rpcUrl, 'confirmed')
  const statuses = diffSeedPlan(plan, await readRegistry(connection, plan))
  report(statuses)

  if (!values.apply) {
    return
  }

  // Часткові збіги посів не лікує: дописати твори в реєстр, де домен належить
  // комусь іншому, означає засіяти половину корпусу під чужим власником.
  if (statuses.some(({ state }) => state === 'mismatch')) {
    throw new Error('реєстр розходиться з корпусом — посів зупинено, розбіжності вище')
  }

  const operator = keypair(operatorPath)
  const owners = loadOwners(values.keys)

  for (const { step, state } of statuses) {
    if (state !== 'todo') {
      continue
    }
    const signature = await applyStep(connection, step, operator, owners)
    console.log(`  ${step.kind} ${step.subject}  ${signature}`)
  }
}

await main()
