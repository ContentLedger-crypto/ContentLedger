import { bytesToHex } from '@noble/hashes/utils'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { hostSeed, sourceSeed } from './identifiers.js'
import { configPda, domainPda, escrowPda, settlementLogPda, vaultPda, workPda } from './pda.js'

/**
 * Золоті вектори адрес.
 *
 * Ті самі числа прибиті в `programs/contentledger/tests/golden.rs`. Це не
 * дубль заради дубля: TS і Rust виводять адреси незалежно, тож будь-яка зміна
 * сіду — байтового префікса, порядку, наявності домену в сідах твору —
 * розсипає рівно один бік, і розбіжність видно в гейті, а не на devnet, де
 * вона виглядає як «акаунт не знайдено».
 *
 * Значення оновлюються **тільки разом** із програмою і тільки свідомо.
 */

const CONSUMER = '7Xw3kQhVvVfN4dLpAqTzR9mBcJyU2sHnEgWxPd6ZaKtF'
const HOST = 'example.com'
const SOURCE = 'https://example.com/articles/1'

const GOLDEN = {
  hostHash: 'a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947',
  sourceHash: '60922123737102689c2e81d3c5c4ccd677dfa86f8336b4cc4f2d36bc75163453',
  config: ['APuw7hAys97GMS71GZqBcwAPZGNUqAXPsijKA3aqrzka', 255],
  domain: ['4ykZ4k6M3dBVkQE5uGT218TeZ9NjJ8iHATjm2yYzb4AG', 254],
  work: ['EiH5VpKYtWGy2CX4R1Chd68LXfygYS4S22ceaoDf3pfB', 253],
  escrow: ['8jpMQyQboQ22Xh1FjptmJKBvH7JHENHVT38B8FL1aoCa', 253],
  vault: ['2cHpQ3ESXdF5xineBKjcJjLmJSFbCpHB5Bhp3S8M7gDC', 254],
  log: ['J2qKbSJNNMX4P51RZwfMh5G7yk3zbC6x5yuDaoEmTAfd', 254],
} as const

describe('золоті вектори', () => {
  it('хеші ідентифікаторів', () => {
    expect(bytesToHex(hostSeed(HOST))).toBe(GOLDEN.hostHash)
    expect(bytesToHex(sourceSeed(SOURCE))).toBe(GOLDEN.sourceHash)
  })

  it('адреси й канонічні bump збігаються з прибитими', () => {
    const consumer = new PublicKey(CONSUMER)
    const escrow = escrowPda(consumer)

    const actual = {
      config: configPda(),
      domain: domainPda(HOST),
      work: workPda(SOURCE),
      escrow,
      vault: vaultPda(escrow[0]),
      log: settlementLogPda(escrow[0]),
    }

    for (const [name, [address, bump]] of Object.entries(actual)) {
      const [expectedAddress, expectedBump] = GOLDEN[name as keyof typeof actual]
      expect(address.toBase58(), name).toBe(expectedAddress)
      expect(bump, name).toBe(expectedBump)
    }
  })
})
