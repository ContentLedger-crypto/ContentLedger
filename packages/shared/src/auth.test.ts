import { describe, expect, it } from 'vitest'
import { authChallengeSchema, sessionGrantSchema } from './auth.js'

const input = {
  domain: 'localhost:5173',
  address: 'Kzb7q9Np5Zr9QBo7iafi2yCBisiHJg7r7HezzgvbuQ2T',
  statement: 'Sign in to the ContentLedger publisher dashboard.',
  uri: 'http://localhost:5173',
  version: '1',
  chainId: 'solana:devnet',
  nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  issuedAt: '2026-10-07T12:00:00.000Z',
  expirationTime: '2026-10-07T12:05:00.000Z',
}

describe('authChallengeSchema', () => {
  it('keeps the challenge exactly as served', () => {
    const challenge = { input, message: 'localhost:5173 wants you to sign in…' }
    expect(authChallengeSchema.parse(challenge)).toEqual(challenge)
  })

  it('tolerates a field the gateway adds later', () => {
    expect(authChallengeSchema.safeParse({ input, message: 'm', hint: 'x' }).success).toBe(true)
  })

  it.each([
    ['an uppercase nonce', { ...input, nonce: input.nonce.toUpperCase() }],
    ['an address outside base58', { ...input, address: '0OIl-not-base58' }],
    ['an expiry without milliseconds', { ...input, expirationTime: '2026-10-07T12:05:00Z' }],
    ['no statement', { ...input, statement: undefined }],
  ])('refuses %s', (_, broken) => {
    expect(authChallengeSchema.safeParse({ input: broken, message: 'm' }).success).toBe(false)
  })

  it('refuses a challenge without the text to sign', () => {
    expect(authChallengeSchema.safeParse({ input }).success).toBe(false)
  })
})

describe('sessionGrantSchema', () => {
  const grant = {
    token: 'q3Jx0Vb2s9H_k-4mZp7LwT1nYc8RfAeD6uGiOoXjK5E',
    expiresAt: '2026-10-08T00:00:00.000Z',
  }

  it('keeps the token and its expiry as served', () => {
    expect(sessionGrantSchema.parse(grant)).toEqual(grant)
  })

  it.each([
    ['a token one character short', { ...grant, token: grant.token.slice(1) }],
    ['a token with padding', { ...grant, token: `${grant.token.slice(1)}=` }],
    ['an expiry as epoch milliseconds', { ...grant, expiresAt: 1_791_417_600_000 }],
  ])('refuses %s', (_, broken) => {
    expect(sessionGrantSchema.safeParse(broken).success).toBe(false)
  })
})
