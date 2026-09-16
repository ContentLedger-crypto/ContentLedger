import type { PublicKey } from '@solana/web3.js'
import { PublicKey as Web3PublicKey } from '@solana/web3.js'
import { hostSeed, sourceSeed } from './identifiers.js'
import { PROGRAM_ID } from './program.js'

/** Сіди мусять збігатися з константами в `state.rs`. */
const CONFIG_SEED = Buffer.from('config')
const DOMAIN_SEED = Buffer.from('domain')
const WORK_SEED = Buffer.from('work')
const ESCROW_SEED = Buffer.from('escrow')
const VAULT_SEED = Buffer.from('vault')
const LOG_SEED = Buffer.from('log')

export type Pda = [PublicKey, number]

const derive = (seeds: Array<Buffer | Uint8Array>): Pda =>
  Web3PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)

export const configPda = (): Pda => derive([CONFIG_SEED])

export const domainPda = (host: string): Pda => derive([DOMAIN_SEED, hostSeed(host)])

/**
 * Домену в сідах немає (рішення T017): джерело унікальне глобально, і шлюз
 * виводить адресу твору прямо з URL — без ланцюжка URL→хост→домен→твір, тобто
 * один RPC замість двох на кожен запит.
 */
export const workPda = (source: string): Pda => derive([WORK_SEED, sourceSeed(source)])

export const escrowPda = (consumer: PublicKey): Pda => derive([ESCROW_SEED, consumer.toBuffer()])

export const vaultPda = (escrow: PublicKey): Pda => derive([VAULT_SEED, escrow.toBuffer()])

export const settlementLogPda = (escrow: PublicKey): Pda => derive([LOG_SEED, escrow.toBuffer()])
