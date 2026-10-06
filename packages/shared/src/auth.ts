import { z } from 'zod'
import { base58KeySchema, utcInstantSchema } from './voucher.js'

/** The Sign In With Solana fields the wallet's `signIn` takes, as the gateway issues them. */
export const signInInputSchema = z.object({
  domain: z.string(),
  address: base58KeySchema,
  statement: z.string(),
  uri: z.string(),
  version: z.string(),
  chainId: z.string(),
  nonce: z.string().regex(/^[0-9a-f]{32}$/, 'expected 16 bytes of lowercase hex'),
  issuedAt: utcInstantSchema,
  expirationTime: utcInstantSchema,
})

/** `message` is the same text for wallets that only have `signMessage`. */
export const authChallengeSchema = z.object({
  input: signInInputSchema,
  message: z.string(),
})

export const sessionGrantSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected 32 bytes of unpadded base64url'),
  expiresAt: utcInstantSchema,
})

export type SignInFields = z.output<typeof signInInputSchema>
export type AuthChallenge = z.output<typeof authChallengeSchema>
export type SessionGrant = z.output<typeof sessionGrantSchema>
