import {
  buildSetDomainRates,
  buildSetDomainStatus,
  buildSetWorkRates,
  buildSetWorkStatus,
  type Domain,
  decodeDomain,
  decodeWork,
  type Work,
} from '@contentledger/chain'
import type { ChangeRefusal, ChangeRequest, PreparedRegistration } from '@contentledger/shared'
import { type AccountInfo, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { assemble, isRegistered, type RegistrationChain } from './registration.js'

export type ChangePreparation =
  | { ok: true; prepared: PreparedRegistration }
  | { ok: false; reason: ChangeRefusal }

const refuse = (reason: ChangeRefusal): ChangePreparation => ({ ok: false, reason })

// The decoder checks the discriminator, so a work's address passed for a domain fails here
// rather than being read as one.
function decoded<T>(info: AccountInfo<Buffer> | null | undefined, decode: (data: Buffer) => T) {
  if (!isRegistered(info) || !info) return null
  try {
    return decode(info.data)
  } catch {
    return null
  }
}

/**
 * Only the fields that differ go into the transaction, and a request that differs in
 * none is refused: the publisher would pay a fee to change nothing. Receipts already
 * issued keep their tariff whatever lands here (FR-004).
 */
export async function prepareChange(
  wallet: string,
  request: ChangeRequest,
  chain: RegistrationChain,
): Promise<ChangePreparation> {
  const owner = new PublicKey(wallet)

  if (request.kind === 'domain') {
    const address = new PublicKey(request.domain)
    const [info] = await chain.getMultipleAccountsInfo([address], 'confirmed')
    const domain = decoded(info, decodeDomain)
    if (!domain) return refuse('not-registered')
    if (domain.owner !== wallet) return refuse('not-yours')

    const instructions: TransactionInstruction[] = []
    if (domain.rateTrain !== request.rateTrain || domain.rateInference !== request.rateInference) {
      instructions.push(
        buildSetDomainRates({
          owner,
          host: domain.host,
          rateTrain: request.rateTrain,
          rateInference: request.rateInference,
        }),
      )
    }
    if (domain.status !== request.status) {
      instructions.push(buildSetDomainStatus({ owner, host: domain.host, status: request.status }))
    }
    return finish(chain, owner, address, instructions)
  }

  const address = new PublicKey(request.work)
  const [workInfo] = await chain.getMultipleAccountsInfo([address], 'confirmed')
  const work = decoded(workInfo, decodeWork)
  if (!work) return refuse('not-registered')
  const [domainInfo] = await chain.getMultipleAccountsInfo(
    [new PublicKey(work.domain)],
    'confirmed',
  )
  const domain = decoded(domainInfo, decodeDomain)
  if (!domain) return refuse('not-registered')
  if (domain.owner !== wallet) return refuse('not-yours')

  return finish(chain, owner, address, workInstructions(owner, domain, address, work, request))
}

function workInstructions(
  owner: PublicKey,
  domain: Domain,
  address: PublicKey,
  work: Work,
  request: Extract<ChangeRequest, { kind: 'work' }>,
) {
  const target = { owner, host: domain.host, work: address }
  const instructions: TransactionInstruction[] = []
  if (work.rateTrain !== request.rateTrain || work.rateInference !== request.rateInference) {
    instructions.push(
      buildSetWorkRates({
        ...target,
        rateTrain: request.rateTrain,
        rateInference: request.rateInference,
      }),
    )
  }
  if (work.status !== request.status) {
    instructions.push(buildSetWorkStatus({ ...target, status: request.status }))
  }
  return instructions
}

const finish = async (
  chain: RegistrationChain,
  owner: PublicKey,
  address: PublicKey,
  instructions: TransactionInstruction[],
): Promise<ChangePreparation> =>
  instructions.length === 0 ? refuse('unchanged') : assemble(chain, owner, address, instructions)
