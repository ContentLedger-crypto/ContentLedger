import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import idl from './idl/contentledger.json'

/**
 * IDL — **копія** згенерованого `packages/program/target/idl/contentledger.json`.
 *
 * `target/` під `.gitignore`, а свіжий клон і TS-джоба в CI не мають ані
 * Rust-тулчейну, ані 18 хвилин на збірку програми. Від застарівання копію
 * стереже `pnpm --filter @contentledger/chain idl:check` у CI-джобі `program`,
 * яка `anchor build` і так робить.
 */
export const IDL = idl as Idl

export const PROGRAM_ID = new PublicKey(idl.address)

/**
 * Тільки кодек, без `Program` і `Provider`: бібліотека суто обчислювальна, тож
 * тестується без мережі й без моків. Звідки брати `Connection` — справа шлюзу.
 */
export const coder = new BorshCoder(IDL)
