# ContentLedger

A royalty rail for AI data. An agent asks the gateway for one specific work, learns its
price, pays in the same exchange, and gets the content back together with a receipt. The
publisher's share lands in the publisher's wallet without a person on either side, and
anyone can later check that receipt against a root anchored on Solana — without trusting
the gateway that issued it.

The payment for one request to one work is a fraction of a cent. Every existing lever a
publisher has — `robots.txt`, lawsuits, bilateral licensing deals, pay-per-crawl proxies —
stops working at that size, because its overhead is larger than the payment. ContentLedger
is built so that the full cost of a licensed request stays below 0.1 cent.

Status: milestone **M1** — the payment path works end to end on devnet and is measured.
See [What M1 does not have yet](#what-m1-does-not-have-yet) before relying on anything.

## One request, end to end

```
agent ── GET /v1/content?source=…&use=train ──▶ gateway
      ◀── 402: tariff, protocol fee, two ways to pay ──
      ── same request + proof of payment ──────────▶ gateway ── checks the proof
      ◀── 200: the content + a signed receipt ─────────────── proxies the registered source
                                         settler ── settle_batch ──▶ program on Solana
                                                     USDC to each publisher,
                                                     Merkle root of the batch on-chain
anyone ── verify-receipt <id> ── root from the network, composition from the gateway
```

1. **The price comes first.** A request without payment gets `402 Payment Required`. The
   body names the work, the use type (`train` or `inference`), the publisher's tariff and
   the protocol fee as separate amounts, and the payment methods available for this
   agent. An unregistered source is refused outright — it is never served for free.
2. **The agent pays and repeats the request** with the proof in a header.
3. **The gateway checks the proof, then serves.** Only sources registered on-chain are
   proxied: `source` is a registry key, not a URL the gateway will fetch for anyone. The
   response carries a receipt naming the work, use type, amount and time.
4. **Settlement.** The settler batches an agent's receipts into one `settle_batch`
   transaction: it moves the tariffs to the publishers' token accounts and the fee to the
   treasury, and writes the batch's Merkle root into an on-chain log.
5. **Independent verification.** `verify-receipt` takes a receipt id and checks it
   against the network, not against the gateway's word.

## Two ways to pay

| | Escrow voucher | x402, per request |
|---|---|---|
| What the agent sends | A voucher signed with its key, drawn on its on-chain escrow | A signed USDC transfer for this one request |
| Transactions per request | None — receipts settle later in batches | One |
| Replay protection | A cumulative amount and a hash chain over every earlier voucher; the program refuses to settle beyond what the agent signed | The transfer signature is single-use |
| Suits | An agent making many requests | An agent making a few, or one without an escrow |

The escrow path is the reason the cost stays under a cent: a batch costs two signatures in
fees whatever its size, so the per-request cost falls as batches grow. The operator key
that signs settlements cannot spend an escrow beyond the cumulative amount its agent
signed.

## Checking a receipt without trusting the gateway

```sh
pnpm --filter @contentledger/verify-receipt verify <receipt id, 64 hex>
```

It runs four steps and reports each one:

1. **Root and chain from the network** — the settlement transaction is read from Solana
   RPC, and its root and payer chain from the on-chain log.
2. **Inclusion** — the receipt's Merkle path leads to that root.
3. **Payer chain** — the published batch composition reproduces the agent's hash chain.
4. **Amounts** — the composition adds up to what the transaction actually debited.

The gateway only supplies the batch composition; every claim about money is checked
against the chain. A forged field anywhere — including a batch invented whole and
internally consistent — fails one of the four steps.

## M1 on devnet, measured

One run, 1,000 licensed requests (900 by escrow voucher, 100 by x402), on the commit
recorded in the result. The full record — every transaction signature, the price feed
used, per-process RPC usage — is in
[`tests/e2e/results/m1-2026-10-06T12-34.json`](tests/e2e/results/m1-2026-10-06T12-34.json).

| Criterion | Budget | Measured | |
|---|---|---|---|
| Full cost of one licensed request, network fees included | < 0.1 cent | escrow 0.003 cent, x402 0.06 cent (SOL at $120.37) | pass |
| Content delivered for a valid proof, p95 | < 3 s | escrow 0.79 s, x402 0.82 s | pass |
| Payouts equal payments, on tariffs that do not divide evenly | 0 base units apart | 0 apart over 5,550,429 base units; 167 receipts on a rounding boundary | pass |
| A request without a valid proof gets no content | 100% of ≥ 50 attempts | 70 of 70 refused across 11 kinds, replays included | pass |
| A thousand requests within a free RPC tier | < 1M credits a month | 2.91 credits a request, 343 such sessions a month | pass |

Cost break-even: the escrow path stays under 0.1 cent until SOL reaches $4,615, x402
until $200.

Reported honestly as a miss: the **full x402 cycle** — from the first unpaid request to
the content, the payment transaction's confirmation included — has a p95 of 3.3 s. It is
outside the 3 s budget, which applies to delivery against a proof; it is recorded in the
result file as `fail` and is tracked for a later milestone.

Receipt verification is not part of this run; the verifier's own test suite covers it,
tampering with each field in turn and settling a batch invented whole.

Re-running the measurement spends devnet SOL and takes about 25 minutes. The harness
refuses to start on a working tree that differs from `HEAD`, so the commit it records is
the code that ran:

```sh
pnpm --filter @contentledger/tests e2e:m1
```

## Running it

You need Node ≥ 22, pnpm 9.15, a Postgres database (the project uses Supabase's pooler),
and a devnet RPC endpoint with WebSocket support. The program is already deployed on
devnet at `HFoHycv5MSCFizdb4GhPSYgLWFfwu1MgEW8qx8zuWKh2`.

```sh
pnpm install
cp .env.example .env            # fill in the RPC key and both database URLs
DATABASE_MIGRATION_URL=<session-mode URL from .env> \
  pnpm --filter @contentledger/db exec drizzle-kit migrate

pnpm --filter @contentledger/fixtures start   # the fixture corpus the registry points at
pnpm --filter @contentledger/gateway start
pnpm --filter @contentledger/settler start
```

Then, as an agent:

```sh
pnpm --filter @contentledger/agent-sim agent keygen
pnpm --filter @contentledger/agent-sim agent deposit --amount 1000000
pnpm --filter @contentledger/agent-sim agent fetch \
  --source https://devblog.test/posts/rust-zero-copy --use train
pnpm --filter @contentledger/agent-sim agent fetch \
  --source https://devblog.test/posts/rust-zero-copy --pay x402
```

`.env.example` explains every variable and why it has the value it has.

The gate every commit passes, locally and in CI:

```sh
pnpm gate        # lint, typecheck, tests
```

## Repository map

| Path | What lives there |
|---|---|
| `packages/program` | The Anchor program: config, registry of domains and works, agent escrow, batch settlement |
| `packages/chain` | TypeScript client for the program, PDAs, transaction confirmation |
| `packages/shared` | Receipts, the voucher hash chain, Merkle tree, amounts — shared by every side |
| `packages/db` | Postgres schema and migrations |
| `apps/gateway` | The HTTP gateway: quotes, 402, proof checks, content, public receipts and batches |
| `apps/settler` | Batches receipts and settles them on-chain |
| `apps/fixtures` | The fixture corpus of three publishers and their licence marks |
| `apps/web` | The publisher dashboard (mock data until M2) |
| `tools/agent-sim` | A command-line agent that pays both ways |
| `tools/verify-receipt` | The independent receipt verifier |
| `tools/deploy`, `tools/seed-registry` | Program bootstrap and registry seeding |
| `tests/e2e` | The milestone runs and their recorded results |

## What M1 does not have yet

- **The dashboard runs on mock data.** Publishers cannot yet see their live income; that
  is milestone M2.
- **No attestor nodes.** Domains are seeded into the registry by the operator's script, so
  a publisher's claim to a domain is, for now, an assertion rather than a proof. The
  attestor's share in the on-chain config is zero.
- **The corpus is fixtures** — three made-up publishers on `.test` domains.
- **The currency is a test mint** with 6 decimals created on devnet, not Circle's USDC.
- **The on-chain log keeps the last 120 settlements.** A root older than that window is
  read from the RPC's transaction history instead of the account.
- **Publishers cannot register themselves yet**; self-service onboarding is milestone M3.
