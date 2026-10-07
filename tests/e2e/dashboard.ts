import { createPrivateKey, sign } from 'node:crypto'
import type { Keypair } from '@solana/web3.js'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { z } from 'zod'

const WALLET_NAME = 'M2 Harness'
const SIGN = '__contentledgerSign'
const ROW = '__contentledgerRow'

/** One publisher's dashboard, open in a browser context of its own. */
export interface Dashboard {
  owner: string
  page: Page
  /** Receipt id → when its row entered this page, epoch ms on the page's clock. */
  sightings: ReadonlyMap<string, number>
  /** The session the dashboard signed in with, read back from its own storage. */
  token(): Promise<string>
  /** How far the page's clock stood from this process's when asked, ms; 0 is one clock. */
  clockOffset(): Promise<number>
  close(): Promise<void>
}

const storedSession = z.object({ wallet: z.string(), token: z.string() })

// A raw ed25519 seed signs through node:crypto only as a JWK; the key never enters the page.
function signerOf(keypair: Keypair): (message: Uint8Array) => Uint8Array {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: b64(keypair.secretKey.slice(0, 32)),
      x: b64(keypair.publicKey.toBytes()),
    },
    format: 'jwk',
  })
  return (message) => new Uint8Array(sign(null, message, key))
}

/**
 * Runs in the page before the app: a Wallet Standard wallet that signs messages through the
 * harness, and a watcher that notes the first time each takings row enters the document.
 */
function installHarness(args: {
  name: string
  address: string
  publicKey: number[]
  sign: string
  row: string
}) {
  const bridge = window as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>
  const signRemote = bridge[args.sign] as (message: number[]) => Promise<number[]>
  const report = bridge[args.row] as (id: string, at: number) => Promise<void>

  const seen = new Set<string>()
  const note = (node: Node, at: number) => {
    if (!(node instanceof Element)) return
    for (const element of [node, ...node.querySelectorAll('[data-receipt-id]')]) {
      const id = element.getAttribute('data-receipt-id')
      if (id === null || seen.has(id)) continue
      seen.add(id)
      void report(id, at)
    }
  }
  new MutationObserver((records) => {
    const at = Date.now()
    for (const record of records) for (const node of record.addedNodes) note(node, at)
  }).observe(document, { childList: true, subtree: true })

  type Listener = (properties: { accounts?: unknown[] }) => void
  const listeners = new Set<Listener>()
  const chains = ['solana:devnet'] as const
  const account = {
    address: args.address,
    publicKey: new Uint8Array(args.publicKey),
    chains,
    features: ['solana:signMessage'] as const,
  }
  const wallet = {
    version: '1.0.0' as const,
    name: args.name,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=',
    chains,
    accounts: [] as (typeof account)[],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          wallet.accounts = [account]
          for (const listener of listeners) listener({ accounts: wallet.accounts })
          return { accounts: wallet.accounts }
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          wallet.accounts = []
          for (const listener of listeners) listener({ accounts: wallet.accounts })
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (_event: 'change', listener: Listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: (...inputs: { message: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ message }) => ({
              signedMessage: message,
              signature: new Uint8Array(await signRemote(Array.from(message))),
            })),
          ),
      },
      // The wallet adapter lists only wallets that can sign a transaction; this one never will.
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async () => {
          throw new Error('the harness wallet signs messages only')
        },
      },
    },
  }

  const register = ({ register }: { register: (w: typeof wallet) => void }) => register(wallet)
  window.addEventListener('wallet-standard:app-ready', (event) =>
    register((event as CustomEvent<{ register: (w: typeof wallet) => void }>).detail),
  )
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
}

/** Opens the dashboard at `url` as the owner of `keypair` and waits for its live feed. */
export async function openDashboard(
  browser: Browser,
  url: string,
  keypair: Keypair,
): Promise<Dashboard> {
  const owner = keypair.publicKey.toBase58()
  const signer = signerOf(keypair)
  const sightings = new Map<string, number>()
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  await context.exposeFunction(SIGN, (message: number[]) =>
    Array.from(signer(Uint8Array.from(message))),
  )
  await context.exposeFunction(ROW, (id: string, at: number) => {
    if (!sightings.has(id)) sightings.set(id, at)
  })
  await context.addInitScript(installHarness, {
    name: WALLET_NAME,
    address: owner,
    publicKey: Array.from(keypair.publicKey.toBytes()),
    sign: SIGN,
    row: ROW,
  })

  const page = await context.newPage()
  await page.goto(url)
  await page.getByRole('button', { name: new RegExp(WALLET_NAME) }).click()
  await page.getByRole('heading', { name: 'Recent takings' }).waitFor({ timeout: 30_000 })
  await page.getByRole('status').filter({ hasText: 'live' }).waitFor({ timeout: 30_000 })

  return {
    owner,
    page,
    sightings,
    async token() {
      const raw = await page.evaluate(() => window.sessionStorage.getItem('contentledger.session'))
      const session = storedSession.parse(JSON.parse(raw ?? 'null'))
      if (session.wallet !== owner)
        throw new Error(`the dashboard for ${owner} signed in as ${session.wallet}`)
      return session.token
    },
    async clockOffset() {
      const before = Date.now()
      const inPage = await page.evaluate(() => Date.now())
      const after = Date.now()
      return inPage < before ? inPage - before : inPage > after ? inPage - after : 0
    },
    close: () => context.close(),
  }
}
