import { buildInitConfig, configPda, decodeConfig, PROGRAM_ID } from '@contentledger/chain'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token'
import {
  type Connection,
  type Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import type { BootstrapSnapshot, BootstrapStep } from './plan.js'
import { USDC_DECIMALS } from './plan.js'

export interface InitConfigParams {
  protocolFeeBps: number
  nodeShareBps: number
  voucherGraceS: bigint
}

type Reader = Pick<Connection, 'getMultipleAccountsInfo'>

/** Два запити на весь знімок: програма і Config разом, потім мінт і скарбниця разом. */
export async function readSnapshot(
  connection: Reader,
  operator: PublicKey,
  requestedMint: PublicKey | null,
): Promise<BootstrapSnapshot> {
  const [program, configInfo] = await connection.getMultipleAccountsInfo([
    PROGRAM_ID,
    configPda()[0],
  ])
  const config = configInfo ? decodeConfig(configInfo.data) : null
  const mintAddress = config ? new PublicKey(config.mint) : requestedMint

  if (mintAddress === null) {
    return {
      operator: operator.toBase58(),
      programDeployed: program !== null,
      requestedMint: null,
      mint: null,
      treasuryAta: null,
      config,
    }
  }

  const treasury = getAssociatedTokenAddressSync(mintAddress, operator)
  const [mintInfo, treasuryInfo] = await connection.getMultipleAccountsInfo([mintAddress, treasury])

  return {
    operator: operator.toBase58(),
    programDeployed: program !== null,
    requestedMint: requestedMint?.toBase58() ?? null,
    mint: mintInfo
      ? {
          address: mintAddress.toBase58(),
          decimals: unpackMint(mintAddress, mintInfo, mintInfo.owner).decimals,
          tokenProgram: mintInfo.owner.toBase58(),
        }
      : null,
    treasuryAta: { address: treasury.toBase58(), exists: treasuryInfo !== null },
    config,
  }
}

/** Повертає мінт, із яким іти далі: `create_mint` — єдиний крок, що його змінює. */
export async function applyStep(
  connection: Connection,
  operator: Keypair,
  step: BootstrapStep,
  mint: PublicKey | null,
  params: InitConfigParams,
): Promise<PublicKey> {
  if (step === 'create_mint') {
    return createMint(connection, operator, operator.publicKey, null, USDC_DECIMALS)
  }
  if (mint === null) {
    throw new Error(`крок ${step} без мінта`)
  }

  const treasury = getAssociatedTokenAddressSync(mint, operator.publicKey)
  const instruction =
    step === 'create_treasury_ata'
      ? createAssociatedTokenAccountIdempotentInstruction(
          operator.publicKey,
          treasury,
          operator.publicKey,
          mint,
        )
      : buildInitConfig({
          authority: operator.publicKey,
          mint,
          treasuryAta: treasury,
          protocolFeeBps: params.protocolFeeBps,
          nodeShareBps: params.nodeShareBps,
          voucherGraceS: params.voucherGraceS,
        })

  await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [operator])
  return mint
}
