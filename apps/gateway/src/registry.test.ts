import { coder, configPda, domainPda, PROGRAM_ID, workPda } from '@contentledger/chain'
import { BN } from '@coral-xyz/anchor'
import { type AccountInfo, type Commitment, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { rpcRegistry } from './registry.js'

const SOURCE = 'https://acme-news.test/2026/ai-act-explained.html'
const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed))

const account = (data: Buffer): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1_000_000,
  owner: PROGRAM_ID,
  rentEpoch: 0,
})

const configData = () =>
  coder.accounts.encode('Config', {
    authority: key(1),
    treasury_ata: key(2),
    mint: key(3),
    protocol_fee_bps: 1000,
    node_share_bps: 0,
    voucher_grace_s: new BN(900),
    paused: false,
    bump: 255,
    reserved: Array(64).fill(0),
  })

const domainData = () =>
  coder.accounts.encode('Domain', {
    owner: key(4),
    payout_owner: key(5),
    host: 'acme-news.test',
    rate_train: new BN(2000),
    rate_inference: new BN(500),
    status: { Active: {} },
    bump: 254,
    reserved: Array(32).fill(0),
  })

const workData = () =>
  coder.accounts.encode('Work', {
    domain: domainPda('acme-news.test')[0],
    source_hash: Array(32).fill(0x11),
    content_hash: Array(32).fill(0x22),
    rate_train: new BN(9000),
    rate_inference: null,
    status: { Active: {} },
    attested_by: 0,
    bump: 253,
    reserved: Array(32).fill(0),
  })

function connection(infos: Array<AccountInfo<Buffer> | null>) {
  const calls: Array<{ keys: string[]; commitment: Commitment | undefined }> = []
  return {
    calls,
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: Commitment) => {
      calls.push({ keys: keys.map((k) => k.toBase58()), commitment })
      return infos
    },
  }
}

describe('rpcRegistry', () => {
  it('reads Config, the host domain and the work in one confirmed call', async () => {
    const rpc = connection([
      account(await configData()),
      account(await domainData()),
      account(await workData()),
    ])
    const snapshot = await rpcRegistry(rpc).read(SOURCE)

    expect(rpc.calls).toEqual([
      {
        keys: [
          configPda()[0].toBase58(),
          domainPda('acme-news.test')[0].toBase58(),
          workPda(SOURCE)[0].toBase58(),
        ],
        commitment: 'confirmed',
      },
    ])
    expect(snapshot.config.protocolFeeBps).toBe(1000)
    expect(snapshot.domain).toEqual({
      address: domainPda('acme-news.test')[0].toBase58(),
      account: expect.objectContaining({ payoutOwner: key(5).toBase58(), rateTrain: 2000n }),
    })
    expect(snapshot.work).toEqual({
      address: workPda(SOURCE)[0].toBase58(),
      account: expect.objectContaining({ rateTrain: 9000n, rateInference: null }),
    })
  })

  it('reports absent domain and work as null', async () => {
    const rpc = connection([account(await configData()), null, null])
    const snapshot = await rpcRegistry(rpc).read(SOURCE)
    expect(snapshot.domain).toBeNull()
    expect(snapshot.work).toBeNull()
  })

  it('fails loudly when Config is missing, since no price can be right without it', async () => {
    const rpc = connection([null, account(await domainData()), account(await workData())])
    await expect(rpcRegistry(rpc).read(SOURCE)).rejects.toThrow(/Config/)
  })
})
