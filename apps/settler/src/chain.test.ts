import {
  buildSettleBatch,
  coder,
  configPda,
  domainPda,
  escrowPda,
  PROGRAM_ID,
  settlementLogPda,
} from '@contentledger/chain'
import { BN, utils } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  type Connection,
  Keypair,
  PublicKey,
  type SignatureStatus,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fitsInPacket, packetSize, rpcSettlementChain, settlementIn } from './chain.js'

const operator = Keypair.generate()
const agent = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const treasuryAta = Keypair.generate().publicKey
const root = new Uint8Array(32).fill(0x7a)

const settle = (domains: number, seq = 12n): TransactionInstruction[] =>
  buildSettleBatch({
    authority: operator.publicKey,
    consumer: agent,
    mint,
    treasuryAta,
    voucher: { seq, cumulative: 26_400n, chain: new Uint8Array(32), signature: new Uint8Array(64) },
    root,
    legs: Array.from({ length: domains }, () => ({
      domain: Keypair.generate().publicKey,
      payoutOwner: Keypair.generate().publicKey,
      tariff: 2_000n,
    })),
  })

describe('packet size', () => {
  it('matches what a signed transaction serialises to', () => {
    const instructions = settle(2)
    const tx = new Transaction({
      feePayer: operator.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 0,
    }).add(...instructions)
    tx.sign(operator)
    expect(packetSize(instructions, operator.publicKey)).toBe(tx.serialize().length)
  })

  // Three recipients of their own fill a legacy packet: the corpus has exactly three
  // domains, a fourth goes to the next batch.
  it('takes three recipients and not four', () => {
    expect(fitsInPacket(settle(3), operator.publicKey)).toBe(true)
    expect(fitsInPacket(settle(4), operator.publicKey)).toBe(false)
  })
})

describe('settlementIn', () => {
  const message = (instructions: TransactionInstruction[]) =>
    new Transaction({
      feePayer: operator.publicKey,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 0,
    })
      .add(...instructions)
      .compileMessage()

  it('reads the settled seq and the anchored root back from the transaction', () => {
    expect(settlementIn(message(settle(1, 7n)))).toEqual({ seq: 7n, root: '7a'.repeat(32) })
  })

  it('is null for a transaction without settle_batch', () => {
    const [verification] = settle(1)
    expect(settlementIn(message([verification as TransactionInstruction]))).toBeNull()
  })
})

const account = (data: Buffer, owner = PROGRAM_ID): AccountInfo<Buffer> => ({
  data,
  owner,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
})

const encoded = async (name: string, fields: Record<string, unknown>) =>
  coder.accounts.encode(name, fields)

const configFields = {
  authority: operator.publicKey,
  treasury_ata: treasuryAta,
  mint,
  protocol_fee_bps: 1000,
  node_share_bps: 0,
  voucher_grace_s: new BN(900),
  paused: false,
  bump: 255,
  reserved: Array(64).fill(0),
}

describe('rpcSettlementChain', () => {
  const host = 'acme-news.test'
  const domain = domainPda(host)[0]

  const reader = (escrowOwner: PublicKey | null, domainPresent = true) => {
    const asked: string[][] = []
    const connection = {
      async getMultipleAccountsInfo(keys: PublicKey[], commitment: string) {
        expect(commitment).toBe('finalized')
        asked.push(keys.map((k) => k.toBase58()))
        return [
          account(await encoded('Config', configFields)),
          escrowOwner === null
            ? null
            : account(
                await encoded('Escrow', {
                  consumer: agent,
                  vault: Keypair.generate().publicKey,
                  settled_total: new BN(2200),
                  last_seq: new BN(1),
                  last_chain: Array(32).fill(3),
                  withdraw_after: new BN(0),
                  bump: 254,
                  vault_bump: 253,
                  reserved: Array(32).fill(0),
                }),
                escrowOwner,
              ),
          domainPresent
            ? account(
                await encoded('Domain', {
                  owner: agent,
                  payout_owner: agent,
                  host,
                  rate_train: new BN(2000),
                  rate_inference: new BN(500),
                  status: { Active: {} },
                  bump: 252,
                  reserved: Array(32).fill(0),
                }),
              )
            : null,
        ]
      },
    } as unknown as Connection
    return { chain: rpcSettlementChain(connection, operator), asked }
  }

  it('reads Config, the escrow and every recipient domain in one call', async () => {
    const { chain, asked } = reader(PROGRAM_ID)
    const state = await chain.read(agent.toBase58(), [domain.toBase58()])
    expect(asked).toEqual([[configPda()[0], escrowPda(agent)[0], domain].map((k) => k.toBase58())])
    expect(state.config.protocolFeeBps).toBe(1000)
    expect(state.escrow?.lastSeq).toBe(1n)
    expect(state.domains.get(domain.toBase58())?.payoutOwner).toBe(agent.toBase58())
  })

  it('takes lamports sent to the escrow address for no escrow', async () => {
    const { chain } = reader(PublicKey.default)
    expect((await chain.read(agent.toBase58(), [domain.toBase58()])).escrow).toBeNull()
  })

  it('refuses to settle to a domain that is not registered', async () => {
    const { chain } = reader(PROGRAM_ID, false)
    await expect(chain.read(agent.toBase58(), [domain.toBase58()])).rejects.toThrow(/Domain/)
  })

  describe('submit', () => {
    const internal = () => new Error('failed to get signature status: Internal error')

    const cluster = (statuses: (SignatureStatus | null | Error)[], height = 100) => {
      const sent: Buffer[] = []
      let polled = 0
      const connection = {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 150,
        }),
        sendRawTransaction: async (raw: Buffer) => {
          sent.push(raw)
          return utils.bytes.bs58.encode(Transaction.from(raw).signature ?? new Uint8Array())
        },
        getSignatureStatuses: async () => {
          const step = statuses[Math.min(polled, statuses.length - 1)]
          polled += 1
          if (step instanceof Error) throw step
          return { context: { slot: 1 }, value: [step ?? null] }
        },
        getBlockHeight: async () => height,
      } as unknown as Connection
      return { chain: rpcSettlementChain(connection, operator, { pollMs: 0 }), sent }
    }

    const at = (
      confirmationStatus: SignatureStatus['confirmationStatus'],
      err: SignatureStatus['err'] = null,
    ): SignatureStatus => ({ slot: 1, confirmations: null, err, confirmationStatus })

    it('resolves with the signature once the settlement is finalized', async () => {
      const { chain, sent } = cluster([null, at('confirmed'), at('finalized')])
      const signature = await chain.submit(settle(1))
      const tx = Transaction.from(sent[0] as Buffer)
      expect(tx.verifySignatures()).toBe(true)
      expect(signature).toBe(utils.bytes.bs58.encode(tx.signature ?? new Uint8Array()))
    })

    it('outlasts an RPC error mid-confirmation without sending the settlement again', async () => {
      const { chain, sent } = cluster([at('confirmed'), internal(), at('finalized')])
      await expect(chain.submit(settle(1))).resolves.toEqual(expect.any(String))
      expect(sent).toHaveLength(1)
    })

    it('throws when the settlement executed with an error', async () => {
      const { chain } = cluster([at('finalized', { InstructionError: [1, { Custom: 6011 }] })])
      await expect(chain.submit(settle(1))).rejects.toThrow(/failed: .*6011/)
    })

    it('throws when the blockhash expired before the settlement landed', async () => {
      const { chain } = cluster([null], 151)
      await expect(chain.submit(settle(1))).rejects.toThrow(/expired/)
    })
  })

  describe('findSettlement', () => {
    const log = settlementLogPda(escrowPda(agent)[0])[0]
    const history = (entries: { signature: string; seq: bigint; failed?: boolean }[]) => {
      const connection = {
        async getSignaturesForAddress(address: PublicKey, _options: unknown, commitment: string) {
          expect(address.toBase58()).toBe(log.toBase58())
          expect(commitment).toBe('finalized')
          return entries.map(({ signature, failed }) => ({
            signature,
            err: failed ? { InstructionError: [1, { Custom: 6011 }] } : null,
          }))
        },
        async getTransaction(signature: string) {
          const entry = entries.find((e) => e.signature === signature)
          if (entry === undefined) return null
          const message = new Transaction({
            feePayer: operator.publicKey,
            blockhash: PublicKey.default.toBase58(),
            lastValidBlockHeight: 0,
          })
            .add(...settle(1, entry.seq))
            .compileMessage()
          return { blockTime: 1_791_000_000, transaction: { message } }
        },
      } as unknown as Connection
      return rpcSettlementChain(connection, operator)
    }

    it('finds the landed settlement of the given seq', async () => {
      const chain = history([
        { signature: 'newer', seq: 9n },
        { signature: 'failed', seq: 7n, failed: true },
        { signature: 'mine', seq: 7n },
      ])
      expect(await chain.findSettlement(agent.toBase58(), 7n)).toEqual({
        txSig: 'mine',
        root: '7a'.repeat(32),
        settledAt: new Date(1_791_000_000_000),
      })
    })

    it('is null when no landed settlement has that seq', async () => {
      const chain = history([{ signature: 'failed', seq: 7n, failed: true }])
      expect(await chain.findSettlement(agent.toBase58(), 7n)).toBeNull()
    })
  })
})
