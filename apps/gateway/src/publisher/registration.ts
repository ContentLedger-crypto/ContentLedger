import { createHash } from 'node:crypto'
import {
  buildRegisterDomain,
  buildRegisterWork,
  buildSetWorkRates,
  decodeDomain,
  domainPda,
  hostOf,
  isCanonicalHost,
  PROGRAM_ID,
  workPda,
} from '@contentledger/chain'
import type {
  PreparedRegistration,
  RegistrationRefusal,
  RegistrationRequest,
  RegistrationStatus,
} from '@contentledger/shared'
import {
  type AccountInfo,
  PublicKey,
  type SignatureStatus,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { errorChain } from '../errors.js'
import type { ContentOrigin } from '../origin.js'

export interface RegistrationChain {
  getMultipleAccountsInfo(
    keys: PublicKey[],
    commitment: 'confirmed',
  ): Promise<Array<AccountInfo<Buffer> | null>>
  getLatestBlockhash(
    commitment: 'confirmed',
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>
}

export interface SignatureChain {
  getBlockHeight(commitment: 'confirmed'): Promise<number>
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ context: { slot: number }; value: Array<SignatureStatus | null> }>
}

export type Preparation =
  | { ok: true; prepared: PreparedRegistration }
  | { ok: false; reason: RegistrationRefusal }

const refuse = (reason: RegistrationRefusal): Preparation => ({ ok: false, reason })

// Anyone can send lamports to a PDA before it is created; that leaves a system-owned
// account the program's `init` still takes over, so it is not a registration.
const isRegistered = (info: AccountInfo<Buffer> | null | undefined) =>
  info?.owner.equals(PROGRAM_ID) === true

/**
 * Checks here only spare the publisher a fee for a transaction the program or the gateway
 * would refuse; the program checks again, since nothing stops a wallet from sending its own.
 */
export async function prepareRegistration(
  wallet: string,
  request: RegistrationRequest,
  { chain, origin }: { chain: RegistrationChain; origin: ContentOrigin },
): Promise<Preparation> {
  const payer = new PublicKey(wallet)

  if (request.kind === 'domain') {
    if (!isCanonicalHost(request.host)) return refuse('host-not-canonical')
    const [address] = domainPda(request.host)
    const [existing] = await chain.getMultipleAccountsInfo([address], 'confirmed')
    if (isRegistered(existing)) return refuse('domain-taken')

    return assemble(chain, payer, address, [
      buildRegisterDomain({
        payer,
        host: request.host,
        owner: payer,
        payoutOwner: payer,
        rateTrain: request.rateTrain,
        rateInference: request.rateInference,
      }),
    ])
  }

  let host: string
  try {
    host = hostOf(request.source)
  } catch {
    return refuse('source-not-canonical')
  }
  const [domainAddress] = domainPda(host)
  const [address] = workPda(request.source)
  const [domainInfo, workInfo] = await chain.getMultipleAccountsInfo(
    [domainAddress, address],
    'confirmed',
  )
  if (!domainInfo || !isRegistered(domainInfo)) return refuse('domain-missing')
  if (decodeDomain(domainInfo.data).owner !== wallet) return refuse('domain-not-yours')
  if (isRegistered(workInfo)) return refuse('source-taken')

  // Hashed from the origin the gateway will serve the work from, so its receipts match.
  const content = await origin.fetch(request.source).catch((error: unknown) => {
    console.error(`registration of ${request.source}: origin unreadable: ${errorChain(error)}`)
    return null
  })
  if (content === null) return refuse('source-unreachable')
  const contentHash = createHash('sha256').update(content.bytes).digest()

  const instructions = [buildRegisterWork({ payer, host, source: request.source, contentHash })]
  if (request.rateTrain !== null || request.rateInference !== null) {
    instructions.push(
      buildSetWorkRates({
        owner: payer,
        host,
        source: request.source,
        rateTrain: request.rateTrain,
        rateInference: request.rateInference,
      }),
    )
  }
  return assemble(chain, payer, address, instructions)
}

async function assemble(
  chain: RegistrationChain,
  payer: PublicKey,
  address: PublicKey,
  instructions: TransactionInstruction[],
): Promise<Preparation> {
  const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash('confirmed')
  const transaction = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
    ...instructions,
  )
  return {
    ok: true,
    prepared: {
      transaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      address: address.toBase58(),
      lastValidBlockHeight,
    },
  }
}

/**
 * The height is read before the status: a transaction unseen by then and past its last
 * valid height can no longer land, while the other order could call expired one that
 * landed between the two reads.
 */
export async function registrationStatus(
  signature: string,
  lastValidBlockHeight: number,
  chain: SignatureChain,
): Promise<RegistrationStatus> {
  const height = await chain.getBlockHeight('confirmed')
  const {
    value: [status],
  } = await chain.getSignatureStatuses([signature])

  if (status) {
    if (status.err !== null) return { state: 'failed', reason: failureReason(status.err) }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { state: 'confirmed' }
    }
    return { state: 'pending' }
  }
  return height > lastValidBlockHeight ? { state: 'expired' } : { state: 'pending' }
}

// 0 comes from the system program under `init`: the account already exists, which is
// how a second registration of the same domain or source lands (FR-005).
const FAILURES: Record<number, Extract<RegistrationStatus, { state: 'failed' }>['reason']> = {
  0: 'already-registered',
  6003: 'host-not-canonical',
  6004: 'unauthorized',
  6005: 'host-not-canonical',
}

function failureReason(err: unknown): Extract<RegistrationStatus, { state: 'failed' }>['reason'] {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return 'rejected'
  const [, cause] = err.InstructionError as [number, unknown]
  if (typeof cause !== 'object' || cause === null || !('Custom' in cause)) return 'rejected'
  return FAILURES[cause.Custom as number] ?? 'rejected'
}
