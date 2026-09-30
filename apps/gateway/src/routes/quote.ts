import {
  associatedTokenAddress,
  canonicalSourceId,
  PROGRAM_ID,
  type X402Leg,
} from '@contentledger/chain'
import {
  type RateLevel,
  resolveRate,
  splitPayment,
  USDC_DECIMALS,
  type UseType,
  useTypeSchema,
} from '@contentledger/shared'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { apiError } from '../errors.js'
import type { FundsRejection } from '../escrow.js'
import type { RegistryReader, RegistrySnapshot } from '../registry.js'
import type { EscrowReceiptBody } from '../voucher.js'

export interface Quote {
  work: string
  useType: UseType
  tariff: bigint
  fee: bigint
  total: bigint
  rateLevel: RateLevel
  /** Payout wallet of the domain; the tariff lands in its ATA. */
  recipient: string
  publisherAta: string
  treasuryAta: string
  verified: boolean
}

export type QuoteOutcome =
  | { kind: 'quoted'; quote: Quote }
  | { kind: 'unregistered'; reason: 'work-missing' | 'domain-missing' | 'work-under-other-domain' }
  | { kind: 'unlicensed'; reason: 'domain-suspended' | 'work-suspended' }

export function quoteFor(
  { config, domain, work }: RegistrySnapshot,
  useType: UseType,
): QuoteOutcome {
  if (work === null) return { kind: 'unregistered', reason: 'work-missing' }
  if (domain === null) return { kind: 'unregistered', reason: 'domain-missing' }
  // The program sees only the source hash, so nothing on chain stops the owner of
  // one domain registering a URL on another host. Paying that owner would pay the
  // wrong publisher; the host of the URL decides.
  if (work.account.domain !== domain.address) {
    return { kind: 'unregistered', reason: 'work-under-other-domain' }
  }

  const rate = resolveRate(domain.account, work.account, useType)
  if (!rate.licensed) return { kind: 'unlicensed', reason: rate.reason }

  // settle_batch refuses a non-zero node share until attestors exist (M4); quoting
  // it anyway would sell issuances that can never settle.
  if (config.nodeShareBps !== 0) {
    throw new Error(`node share ${config.nodeShareBps} bps is not payable yet`)
  }
  const split = splitPayment({
    tariff: rate.tariff,
    feeBps: config.protocolFeeBps,
    nodeShareBps: config.nodeShareBps,
  })

  const payout = domain.account.payoutOwner
  return {
    kind: 'quoted',
    quote: {
      work: work.address,
      useType,
      tariff: split.tariff,
      fee: split.fee,
      total: split.total,
      rateLevel: rate.level,
      recipient: payout,
      publisherAta: associatedTokenAddress(
        new PublicKey(payout),
        new PublicKey(config.mint),
      ).toBase58(),
      treasuryAta: config.treasuryAta,
      verified: work.account.attestedBy > 0,
    },
  }
}

/** The same legs the gateway later checks the payment against, so the two cannot drift. */
export function x402Legs(quote: Quote): X402Leg[] {
  return [
    { destination: quote.publisherAta, amount: quote.tariff },
    { destination: quote.treasuryAta, amount: quote.fee },
  ].filter((leg) => leg.amount > 0n)
}

/** Either a draft to sign, or why the escrow path cannot take this request right now. */
export type EscrowTerms =
  | {
      offer: {
        id: string
        body: EscrowReceiptBody
        cumulativeAfter: bigint
        expiresAt: Date
      }
    }
  | { unavailable: 'consumer-required' | FundsRejection }

function escrowMethod(quote: Quote, terms: EscrowTerms) {
  const method = { kind: 'escrow', program: PROGRAM_ID.toBase58(), amount: quote.total.toString() }
  if ('unavailable' in terms) return { ...method, unavailable: terms.unavailable }
  const { id, body, cumulativeAfter, expiresAt } = terms.offer
  return {
    ...method,
    offer: {
      id,
      body,
      cumulativeAfter: cumulativeAfter.toString(),
      expiresAt: expiresAt.toISOString(),
    },
  }
}

function paymentMethods(quote: Quote, terms: EscrowTerms) {
  const escrow = escrowMethod(quote, terms)
  const legs = x402Legs(quote)
  // A free work is still issued against a voucher: every issuance has a payer and a
  // receipt (FR-012), and an x402 payment of nothing does not exist.
  if (legs.length === 0) return [escrow]
  return [
    escrow,
    {
      kind: 'x402',
      legs: legs.map((leg) => ({ payTo: leg.destination, amount: leg.amount.toString() })),
    },
  ]
}

/** `reason` is set when a voucher came for an offer the gateway no longer holds. */
export function paymentRequired(quote: Quote, terms: EscrowTerms, reason?: 'offer-expired') {
  return apiError('PAYMENT_REQUIRED', 'this work is licensed per request; pay to receive it', {
    ...(reason && { reason }),
    work: quote.work,
    useType: quote.useType,
    tariff: quote.tariff.toString(),
    fee: quote.fee.toString(),
    total: quote.total.toString(),
    currency: 'USDC',
    decimals: USDC_DECIMALS,
    rateLevel: quote.rateLevel,
    methods: paymentMethods(quote, terms),
  })
}

const canonicalSource = z.string().refine((source) => {
  try {
    return canonicalSourceId(source) === source
  } catch {
    return false
  }
}, 'expected a canonical https source URL')

export const quoteQuery = z.object({ source: canonicalSource, use: useTypeSchema })

export function quoteRoutes(registry: RegistryReader): Hono {
  const app = new Hono()

  app.get('/v1/quote', async (c) => {
    const query = quoteQuery.safeParse(c.req.query())
    if (!query.success) {
      return c.json(
        apiError('INVALID_INPUT', 'invalid quote request', { issues: z.flattenError(query.error) }),
        400,
      )
    }
    const { source, use } = query.data

    const outcome = quoteFor(await registry.read(source), use)
    switch (outcome.kind) {
      case 'unregistered':
        return c.json(
          apiError('NOT_FOUND', 'work is not registered', { reason: outcome.reason }),
          404,
        )
      case 'unlicensed':
        return c.json(
          apiError('NOT_LICENSED', 'the owner has withdrawn this licence', {
            reason: outcome.reason,
          }),
          403,
        )
      case 'quoted': {
        const { quote } = outcome
        return c.json({
          work: quote.work,
          useType: quote.useType,
          tariff: quote.tariff.toString(),
          fee: quote.fee.toString(),
          total: quote.total.toString(),
          currency: 'USDC',
          decimals: USDC_DECIMALS,
          rateLevel: quote.rateLevel,
          recipient: quote.recipient,
          escrowProgram: PROGRAM_ID.toBase58(),
          verified: quote.verified,
        })
      }
    }
  })

  return app
}
