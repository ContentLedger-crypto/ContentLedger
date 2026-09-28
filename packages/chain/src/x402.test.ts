import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import {
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { verifyX402Payment, x402ProofMessage } from './x402.js'

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsL5WeUyvGSQX7N7hwVTzAh')

const payerSeed = new Uint8Array(32).fill(7)
const strangerSeed = new Uint8Array(32).fill(9)
const payer = new PublicKey(ed25519.getPublicKey(payerSeed)).toBase58()
const stranger = new PublicKey(ed25519.getPublicKey(strangerSeed)).toBase58()

const payerAta = new PublicKey(new Uint8Array(32).fill(1)).toBase58()
const publisherAta = new PublicKey(new Uint8Array(32).fill(2)).toBase58()
const treasuryAta = new PublicKey(new Uint8Array(32).fill(3)).toBase58()
const otherAta = new PublicKey(new Uint8Array(32).fill(4)).toBase58()

const signature = utils.bytes.bs58.encode(new Uint8Array(64).fill(5))
const legs = [
  { destination: publisherAta, amount: 2000n },
  { destination: treasuryAta, amount: 200n },
]

type Ix = ParsedInstruction | PartiallyDecodedInstruction

function transfer(destination: string, amount: bigint, authority = payer): ParsedInstruction {
  return {
    program: 'spl-token',
    programId: TOKEN_PROGRAM,
    parsed: {
      type: 'transfer',
      info: { source: payerAta, destination, authority, amount: amount.toString() },
    },
  }
}

function transferChecked(destination: string, amount: bigint): ParsedInstruction {
  return {
    program: 'spl-token',
    programId: TOKEN_PROGRAM,
    parsed: {
      type: 'transferChecked',
      info: {
        source: payerAta,
        destination,
        authority: payer,
        mint: 'F2snBajNcBXZ6GheR5LPhMvc9Ai2vG9uGweXrciNM1oF',
        tokenAmount: {
          amount: amount.toString(),
          decimals: 6,
          uiAmount: Number(amount) / 1e6,
          uiAmountString: String(Number(amount) / 1e6),
        },
      },
    },
  }
}

function paymentTx(
  instructions: Ix[],
  options: { err?: { InstructionError: [number, string] }; inner?: Ix[] } = {},
): ParsedTransactionWithMeta {
  return {
    slot: 412_000_000,
    blockTime: 1_790_000_000,
    version: 0,
    meta: {
      err: options.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: options.inner ? [{ index: 0, instructions: options.inner }] : [],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [{ pubkey: new PublicKey(payer), signer: true, writable: true }],
        recentBlockhash: '11111111111111111111111111111111',
        instructions,
      },
    },
  }
}

const proofBy = (seed: Uint8Array, sig = signature) => ed25519.sign(x402ProofMessage(sig), seed)
const expect402 = (proof = proofBy(payerSeed)) => ({ signature, legs, proof })

describe('x402ProofMessage', () => {
  it('is the domain tag followed by the raw 64 signature bytes', () => {
    const message = x402ProofMessage(signature)
    expect(message).toHaveLength(13 + 64)
    expect(new TextDecoder().decode(message.subarray(0, 13))).toBe('CLDGR:x402:v1')
    expect(message.subarray(13)).toEqual(new Uint8Array(64).fill(5))
  })

  it('rejects a string that is not a 64-byte signature', () => {
    expect(() => x402ProofMessage(payer)).toThrow(/64/)
  })
})

describe('verifyX402Payment', () => {
  it('accepts a transaction paying every leg exactly and names the payer', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: true, payer })
  })

  it('accepts transferChecked and ignores unrelated instructions in the same transaction', () => {
    const createAta: PartiallyDecodedInstruction = {
      programId: ATA_PROGRAM,
      accounts: [],
      data: '',
    }
    const tx = paymentTx([
      createAta,
      transferChecked(publisherAta, 2000n),
      transfer(otherAta, 999n),
      transferChecked(treasuryAta, 200n),
    ])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: true, payer })
  })

  it('counts transfers made through CPI', () => {
    const cpi: PartiallyDecodedInstruction = { programId: ATA_PROGRAM, accounts: [], data: '' }
    const tx = paymentTx([cpi], {
      inner: [transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)],
    })
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: true, payer })
  })

  it('sums split transfers to one leg', () => {
    const tx = paymentTx([
      transfer(publisherAta, 1500n),
      transfer(publisherAta, 500n),
      transfer(treasuryAta, 200n),
    ])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: true, payer })
  })

  it('accepts a zero leg only when nothing was sent to it', () => {
    const free = [
      { destination: publisherAta, amount: 0n },
      { destination: treasuryAta, amount: 200n },
    ]
    const clean = paymentTx([transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(clean, { signature, legs: free, proof: proofBy(payerSeed) })).toEqual({
      ok: true,
      payer,
    })
    const stray = paymentTx([transfer(publisherAta, 1n), transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(stray, { signature, legs: free, proof: proofBy(payerSeed) })).toEqual({
      ok: false,
      reason: 'leg_mismatch',
    })
  })

  it('reports a transaction the RPC does not know', () => {
    expect(verifyX402Payment(null, expect402())).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rejects a transaction that failed on chain', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)], {
      err: { InstructionError: [1, 'InsufficientFunds'] },
    })
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: false, reason: 'failed' })
  })

  it('rejects a transaction whose metadata is missing', () => {
    const tx = { ...paymentTx([transfer(publisherAta, 2000n)]), meta: null }
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: false, reason: 'failed' })
  })

  it('rejects a transaction fetched under a different signature', () => {
    const other = utils.bytes.bs58.encode(new Uint8Array(64).fill(6))
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)])
    const verdict = verifyX402Payment(tx, {
      signature: other,
      legs,
      proof: proofBy(payerSeed, other),
    })
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it.each([
    ['an underpaid leg', [transfer(publisherAta, 1999n), transfer(treasuryAta, 200n)]],
    ['an overpaid leg', [transfer(publisherAta, 2001n), transfer(treasuryAta, 200n)]],
    ['a missing leg', [transfer(publisherAta, 2000n)]],
    ['a fee sent to the publisher', [transfer(publisherAta, 2200n)]],
  ])('rejects %s', (_, instructions) => {
    expect(verifyX402Payment(paymentTx(instructions), expect402())).toEqual({
      ok: false,
      reason: 'leg_mismatch',
    })
  })

  it('does not count a Token-2022 transfer', () => {
    const t22 = { ...transfer(publisherAta, 2000n), programId: TOKEN_2022_PROGRAM }
    const tx = paymentTx([t22, transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: false, reason: 'leg_mismatch' })
  })

  it('does not count a multisig transfer, which carries no single authority', () => {
    const multisig: ParsedInstruction = {
      program: 'spl-token',
      programId: TOKEN_PROGRAM,
      parsed: {
        type: 'transfer',
        info: {
          source: payerAta,
          destination: publisherAta,
          multisigAuthority: payer,
          signers: [payer],
          amount: '2000',
        },
      },
    }
    const tx = paymentTx([multisig, transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: false, reason: 'leg_mismatch' })
  })

  it('rejects legs paid by two different wallets', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n, stranger)])
    expect(verifyX402Payment(tx, expect402())).toEqual({ ok: false, reason: 'ambiguous_payer' })
  })

  it('rejects a proof signed by someone other than the payer', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402(proofBy(strangerSeed)))).toEqual({
      ok: false,
      reason: 'proof_invalid',
    })
  })

  it('rejects a payer proof made for another transaction', () => {
    const other = utils.bytes.bs58.encode(new Uint8Array(64).fill(6))
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402(proofBy(payerSeed, other)))).toEqual({
      ok: false,
      reason: 'proof_invalid',
    })
  })

  it('rejects a malformed proof instead of throwing', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n), transfer(treasuryAta, 200n)])
    expect(verifyX402Payment(tx, expect402(new Uint8Array(10)))).toEqual({
      ok: false,
      reason: 'proof_invalid',
    })
  })

  it('throws on expectations that describe no payment', () => {
    const tx = paymentTx([transfer(publisherAta, 2000n)])
    const proof = proofBy(payerSeed)
    expect(() => verifyX402Payment(tx, { signature, legs: [], proof })).toThrow(/leg/)
    expect(() =>
      verifyX402Payment(tx, {
        signature,
        legs: [{ destination: publisherAta, amount: 0n }],
        proof,
      }),
    ).toThrow(/zero/)
    expect(() =>
      verifyX402Payment(tx, {
        signature,
        legs: [
          { destination: publisherAta, amount: 1n },
          { destination: publisherAta, amount: 2n },
        ],
        proof,
      }),
    ).toThrow(/duplicate/)
  })
})
