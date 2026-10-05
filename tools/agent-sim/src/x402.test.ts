import { createHash } from 'node:crypto'
import { associatedTokenAddress, x402ProofMessage } from '@contentledger/chain'
import { type ReceiptBody, receiptId } from '@contentledger/shared'
import { utils } from '@coral-xyz/anchor'
import { ed25519 } from '@noble/curves/ed25519'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  type SignatureStatus,
  Transaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Quote, X402Method } from './protocol.js'
import {
  checkX402Delivery,
  type PendingPayment,
  paymentInstructions,
  paymentProof,
  rpcPaymentRail,
} from './x402.js'

const payer = Keypair.generate()
const MINT = Keypair.generate().publicKey.toBase58()
const OWNER = Keypair.generate().publicKey.toBase58()
const TREASURY = Keypair.generate().publicKey.toBase58()
const WORK = Keypair.generate().publicKey.toBase58()
const ataOf = (owner: string) =>
  associatedTokenAddress(new PublicKey(owner), new PublicKey(MINT)).toBase58()

const quote: Quote = { work: WORK, useType: 'train', tariff: 2000n, fee: 200n, total: 2200n }

const method = (
  legs = [
    { payTo: ataOf(OWNER), amount: 2000n, owner: OWNER },
    { payTo: TREASURY, amount: 200n },
  ],
): X402Method => ({ mint: MINT, legs })

describe('paymentInstructions', () => {
  it('creates the publisher account if needed and transfers each leg from the payer', () => {
    const built = paymentInstructions(payer.publicKey, method(), quote)
    if (!built.ok) throw new Error(built.problem)
    const [create, toPublisher, toTreasury] = built.instructions
    expect(built.instructions).toHaveLength(3)
    expect(create?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    // Idempotent: a second payer must not fail because the first created the account.
    expect([...(create?.data ?? [])]).toEqual([1])
    const transfers = [toPublisher, toTreasury].map((ix) => {
      if (!ix?.programId.equals(TOKEN_PROGRAM_ID)) throw new Error('expected a token instruction')
      const { keys, data } = decodeTransferCheckedInstruction(ix)
      return {
        source: keys.source.pubkey.toBase58(),
        destination: keys.destination.pubkey.toBase58(),
        authority: keys.owner.pubkey.toBase58(),
        mint: keys.mint.pubkey.toBase58(),
        amount: data.amount,
        decimals: data.decimals,
      }
    })
    const source = associatedTokenAddress(payer.publicKey, new PublicKey(MINT)).toBase58()
    const common = { source, authority: payer.publicKey.toBase58(), mint: MINT, decimals: 6 }
    expect(transfers).toEqual([
      { ...common, destination: ataOf(OWNER), amount: 2000n },
      { ...common, destination: TREASURY, amount: 200n },
    ])
  })

  it('pays a leg with no owner without trying to create its account', () => {
    const built = paymentInstructions(
      payer.publicKey,
      method([{ payTo: TREASURY, amount: 2200n }]),
      quote,
    )
    if (!built.ok) throw new Error(built.problem)
    expect(built.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      TOKEN_PROGRAM_ID.toBase58(),
    ])
  })

  it('refuses a leg whose account is not the owner’s for this mint', () => {
    const swapped = method([
      { payTo: Keypair.generate().publicKey.toBase58(), amount: 2000n, owner: OWNER },
      { payTo: TREASURY, amount: 200n },
    ])
    expect(paymentInstructions(payer.publicKey, swapped, quote)).toEqual({
      ok: false,
      problem: 'leg-account-mismatch',
    })
  })

  it.each([
    [
      'more than the quoted total',
      [
        { payTo: ataOf(OWNER), amount: 2001n, owner: OWNER },
        { payTo: TREASURY, amount: 200n },
      ],
    ],
    ['less than the quoted total', [{ payTo: ataOf(OWNER), amount: 2000n, owner: OWNER }]],
    [
      'a zero leg',
      [
        { payTo: ataOf(OWNER), amount: 2200n, owner: OWNER },
        { payTo: TREASURY, amount: 0n },
      ],
    ],
    [
      'one account twice',
      [
        { payTo: TREASURY, amount: 1100n },
        { payTo: TREASURY, amount: 1100n },
      ],
    ],
  ])('refuses legs that add up to %s', (_, legs) => {
    expect(paymentInstructions(payer.publicKey, method(legs), quote)).toEqual({
      ok: false,
      problem: 'terms-mismatch',
    })
  })
})

describe('paymentProof', () => {
  it('signs the gateway’s proof message for this transaction with the payer key', () => {
    const signature = utils.bytes.bs58.encode(new Uint8Array(64).fill(7))
    const proof = utils.bytes.bs58.decode(paymentProof(payer, signature))
    expect(ed25519.verify(proof, x402ProofMessage(signature), payer.publicKey.toBytes())).toBe(true)
  })
})

describe('checkX402Delivery', () => {
  const BYTES = Buffer.from('<h1>paid for</h1>')
  const signature = utils.bytes.bs58.encode(new Uint8Array(64).fill(9))
  const pending: PendingPayment = {
    signature,
    transaction: '',
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 100,
    source: 'https://acme-news.test/a.html',
    use: 'train',
    work: WORK,
    tariff: '2000',
    fee: '200',
  }
  const body: ReceiptBody = {
    consumer: payer.publicKey.toBase58(),
    work: WORK,
    useType: 'train',
    tariff: '2000',
    fee: '200',
    rateLevel: 'domain',
    servedHash: createHash('sha256').update(BYTES).digest('hex'),
    registryHash: createHash('sha256').update(BYTES).digest('hex'),
    acceptedAt: '2026-10-03T12:00:00.000Z',
    paymentMethod: 'x402',
    paymentRef: signature,
  }
  const header = (receipt: ReceiptBody, id = receiptId(receipt)) =>
    Buffer.from(JSON.stringify({ id, ...receipt, hashMatch: true })).toString('base64url')
  const consumer = payer.publicKey.toBase58()

  it('accepts the receipt for this payment over the bytes it names', () => {
    expect(checkX402Delivery(BYTES, header(body), pending, consumer)).toEqual({
      ok: true,
      receipt: { id: receiptId(body), ...body, hashMatch: true },
    })
  })

  it.each([
    ['another payment', { paymentRef: utils.bytes.bs58.encode(new Uint8Array(64).fill(1)) }],
    ['another payer', { consumer: Keypair.generate().publicKey.toBase58() }],
    ['another work', { work: Keypair.generate().publicKey.toBase58() }],
    ['another use', { useType: 'inference' as const }],
    ['another tariff', { tariff: '1999' }],
    ['another fee', { fee: '201' }],
  ])('rejects a receipt for %s', (_, change) => {
    expect(checkX402Delivery(BYTES, header({ ...body, ...change }), pending, consumer)).toEqual({
      ok: false,
      reason: 'receipt-mismatch',
    })
  })

  it('rejects a receipt whose id is not the hash of its body', () => {
    expect(checkX402Delivery(BYTES, header(body, 'ab'.repeat(32)), pending, consumer)).toEqual({
      ok: false,
      reason: 'receipt-mismatch',
    })
  })

  it('rejects bytes that are not the ones the receipt names', () => {
    expect(checkX402Delivery(Buffer.from('other'), header(body), pending, consumer)).toEqual({
      ok: false,
      reason: 'served-hash-mismatch',
    })
  })

  it('reports a missing receipt', () => {
    expect(checkX402Delivery(BYTES, undefined, pending, consumer)).toEqual({
      ok: false,
      reason: 'receipt-missing',
    })
  })
})

describe('rpcPaymentRail', () => {
  const BLOCKHASH = Keypair.generate().publicKey.toBase58()

  const at = (
    confirmationStatus: SignatureStatus['confirmationStatus'],
    err: SignatureStatus['err'] = null,
  ): SignatureStatus => ({ slot: 1, confirmations: null, err, confirmationStatus })

  const connection = (behaviour: {
    send?: () => Promise<string>
    statuses?: (SignatureStatus | null | Error)[]
    height?: number
  }) => {
    const sent: Buffer[] = []
    const statuses = behaviour.statuses ?? [at('confirmed')]
    let polled = 0
    return {
      sent,
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 }),
      sendRawTransaction: async (raw: Buffer | Uint8Array | number[]) => {
        sent.push(Buffer.from(raw as Uint8Array))
        return behaviour.send ? behaviour.send() : 'sent'
      },
      getSignatureStatuses: async () => {
        const step = statuses[Math.min(polled, statuses.length - 1)]
        polled += 1
        if (step instanceof Error) throw step
        return { context: { slot: 1 }, value: [step ?? null] }
      },
      getBlockHeight: async () => behaviour.height ?? 100,
    } as unknown as Parameters<typeof rpcPaymentRail>[0] & { sent: Buffer[] }
  }

  const rail = (conn: Parameters<typeof rpcPaymentRail>[0]) =>
    rpcPaymentRail(conn, payer, { pollMs: 0 })

  const instructions = () => {
    const built = paymentInstructions(payer.publicKey, method(), quote)
    if (!built.ok) throw new Error(built.problem)
    return built.instructions
  }

  it('signs a payment whose signature is the one the transaction carries', async () => {
    const prepared = await rail(connection({})).prepare(instructions())
    const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
    expect(tx.verifySignatures()).toBe(true)
    expect(utils.bytes.bs58.encode(tx.signature ?? new Uint8Array())).toBe(prepared.signature)
    expect(prepared).toMatchObject({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 })
  })

  it('lands a payment the cluster confirms', async () => {
    const conn = connection({ statuses: [null, at('processed'), at('confirmed')] })
    const payments = rail(conn)
    expect(await payments.land(await payments.prepare(instructions()))).toBe('landed')
    expect(conn.sent).toHaveLength(1)
  })

  it('outlasts an RPC error mid-confirmation without sending the payment again', async () => {
    const conn = connection({
      statuses: [
        at('processed'),
        new Error('failed to get signature status: Internal error'),
        at('confirmed'),
      ],
    })
    const payments = rail(conn)
    expect(await payments.land(await payments.prepare(instructions()))).toBe('landed')
    expect(conn.sent).toHaveLength(1)
  })

  it('takes a payment sent again after it already landed as landed', async () => {
    const payments = rail(
      connection({
        send: async () => {
          throw new Error(
            'Transaction simulation failed: This transaction has already been processed',
          )
        },
      }),
    )
    expect(await payments.land(await payments.prepare(instructions()))).toBe('landed')
  })

  it('reports a payment that executed with an error as failed', async () => {
    const payments = rail(
      connection({ statuses: [at('confirmed', { InstructionError: [1, 'x'] })] }),
    )
    expect(await payments.land(await payments.prepare(instructions()))).toBe('failed')
  })

  it('reports a payment preflight refuses as failed rather than retrying it forever', async () => {
    const payments = rail(
      connection({
        send: async () => {
          throw new SendTransactionError({
            action: 'send',
            signature: '',
            transactionMessage: 'Transaction simulation failed: insufficient funds',
            logs: [],
          })
        },
      }),
    )
    expect(await payments.land(await payments.prepare(instructions()))).toBe('failed')
  })

  it('reports a payment whose blockhash expired before it landed', async () => {
    const payments = rail(connection({ statuses: [null], height: 501 }))
    expect(await payments.land(await payments.prepare(instructions()))).toBe('expired')
  })

  it('surfaces a network failure instead of deciding the payment', async () => {
    const payments = rail(
      connection({
        send: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    )
    await expect(payments.land(await payments.prepare(instructions()))).rejects.toThrow(
      /fetch failed/,
    )
  })
})
