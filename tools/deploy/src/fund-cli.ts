import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configPda, decodeConfig } from '@contentledger/chain'
import { usdcAmountSchema } from '@contentledger/shared'
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { z } from 'zod'
import { fundingInstructions } from './fund.js'

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    to: { type: 'string' },
    usdc: { type: 'string', default: '0' },
    lamports: { type: 'string', default: '0' },
  },
})

const options = z
  .object({
    rpc: z.url(),
    operator: z.string().min(1),
    to: z.string().min(32),
    usdc: usdcAmountSchema,
    lamports: z.coerce.bigint().nonnegative(),
  })
  .parse({
    rpc: process.env.SOLANA_RPC_URL,
    operator: process.env.OPERATOR_KEYPAIR_PATH,
    to: values.to,
    usdc: values.usdc,
    lamports: values.lamports,
  })

async function main(): Promise<void> {
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(resolve(import.meta.dirname, '../../..', options.operator), 'utf8')),
    ),
  )
  const connection = new Connection(options.rpc, 'confirmed')
  const configInfo = await connection.getAccountInfo(configPda()[0])
  if (configInfo === null) throw new Error('Config does not exist: run bootstrap first')
  // The mint pinned in Config, not USDC_MINT: an escrow only accepts that one.
  const mint = new PublicKey(decodeConfig(configInfo.data).mint)
  const recipient = new PublicKey(options.to)

  const instructions = fundingInstructions({
    operator: operator.publicKey,
    recipient,
    mint,
    usdc: options.usdc,
    lamports: options.lamports,
  })
  console.log(
    `fund ${recipient.toBase58()} · ${options.usdc} base units of ${mint.toBase58()} · ${options.lamports} lamports`,
  )
  if (!values.apply) {
    console.log('dry run: pass --apply to send')
    return
  }
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...instructions),
    [operator],
  )
  console.log(`✓ ${signature}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
