import { describe, expect, it } from 'vitest'
import { arrivalVerdict, isolationVerdict, takingsVerdict } from './publishers.js'

const ACME = 'acme-owner'
const KYIV = 'kyiv-owner'
const HARBOUR = 'harbour-owner'
const AGENT = 'agent-wallet'
const OTHER_AGENT = 'other-agent'
const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

const issued = [
  { id: 'a1', owner: ACME, acceptedAt: at(0), tariff: 2000n },
  { id: 'k1', owner: KYIV, acceptedAt: at(100), tariff: 5000n },
  { id: 'h1', owner: HARBOUR, acceptedAt: at(200), tariff: 4000n },
  { id: 'a2', owner: ACME, acceptedAt: at(300), tariff: 9000n },
]

const sightings = (entries: [string, [string, number][]][]) =>
  new Map(entries.map(([owner, rows]) => [owner, new Map(rows)]))

describe("SC-003: from accepted_at to the row in that publisher's window", () => {
  it('passes when every receipt shows up in its own window inside 5 s at p95', () => {
    const verdict = arrivalVerdict(
      issued,
      sightings([
        [
          ACME,
          [
            ['a1', T0 + 400],
            ['a2', T0 + 900],
          ],
        ],
        [KYIV, [['k1', T0 + 350]]],
        [HARBOUR, [['h1', T0 + 1200]]],
      ]),
    )

    expect(verdict.verdict).toBe('pass')
    expect(verdict.byPublisher[ACME]).toMatchObject({ issued: 2, appeared: 2, p95: 600, max: 600 })
    expect(verdict.byPublisher[HARBOUR]).toMatchObject({ p95: 1000, missing: [] })
    expect(verdict.all).toMatchObject({ count: 4, p50: 400, p95: 1000 })
  })

  it("fails on one publisher's p95, even when the others are fast", () => {
    const verdict = arrivalVerdict(
      issued,
      sightings([
        [
          ACME,
          [
            ['a1', T0 + 400],
            ['a2', T0 + 900],
          ],
        ],
        [KYIV, [['k1', T0 + 5100]]],
        [HARBOUR, [['h1', T0 + 1200]]],
      ]),
    )

    expect(verdict.byPublisher[KYIV]).toMatchObject({ p95: 5000 })
    expect(verdict.verdict).toBe('fail')
  })

  it('fails when a receipt never reaches its window: an absent row is not a fast one', () => {
    const verdict = arrivalVerdict(
      issued,
      sightings([
        [ACME, [['a1', T0 + 400]]],
        [KYIV, [['k1', T0 + 350]]],
        [HARBOUR, [['h1', T0 + 1200]]],
      ]),
    )

    expect(verdict.byPublisher[ACME]).toMatchObject({ issued: 2, appeared: 1, missing: ['a2'] })
    expect(verdict.verdict).toBe('fail')
  })

  it("does not count a row seen in someone else's window as arrived", () => {
    const verdict = arrivalVerdict(
      issued,
      sightings([
        [
          ACME,
          [
            ['a1', T0 + 400],
            ['a2', T0 + 900],
            ['k1', T0 + 150],
          ],
        ],
        [KYIV, []],
        [HARBOUR, [['h1', T0 + 1200]]],
      ]),
    )

    expect(verdict.byPublisher[KYIV]).toMatchObject({ appeared: 0, missing: ['k1'] })
    expect(verdict.verdict).toBe('fail')
  })

  it('is unmeasured when a row appears before it was accepted: the two clocks are not one', () => {
    const verdict = arrivalVerdict(
      issued,
      sightings([
        [
          ACME,
          [
            ['a1', T0 - 20],
            ['a2', T0 + 900],
          ],
        ],
        [KYIV, [['k1', T0 + 350]]],
        [HARBOUR, [['h1', T0 + 1200]]],
      ]),
    )

    expect(verdict.verdict).toBe('unmeasured')
    expect(verdict.why).toMatch(/before it was accepted/)
  })

  it('is unmeasured when nothing was issued', () => {
    expect(arrivalVerdict([], new Map()).verdict).toBe('unmeasured')
  })
})

describe('SC-004: three publishers at once, each sees exactly its own', () => {
  const hosts = new Map([
    [ACME, new Set(['acme-news.test'])],
    [KYIV, new Set(['kyiv-photo.test'])],
    [HARBOUR, new Set(['harbour-almanac.test'])],
  ])
  const listedRow = (id: string, host: string) => ({ id, sourceId: `https://${host}/w` })
  const listed = new Map([
    [
      ACME,
      [
        listedRow('a1', 'acme-news.test'),
        listedRow('a2', 'acme-news.test'),
        listedRow('a0', 'acme-news.test'),
      ],
    ],
    [KYIV, [listedRow('k1', 'kyiv-photo.test')]],
    [HARBOUR, [listedRow('h1', 'harbour-almanac.test')]],
  ])
  const windows = new Map([
    [ACME, new Set(['a1', 'a2', 'a0'])],
    [KYIV, new Set(['k1'])],
    [HARBOUR, new Set(['h1'])],
  ])

  it('passes 3 of 3 when each window and listing holds all its own and nothing else', () => {
    const verdict = isolationVerdict({ hosts, issued, windows, listed })

    expect(verdict).toMatchObject({ publishers: 3, complete: 3, foreignRows: 0, verdict: 'pass' })
  })

  it("takes an earlier row of the publisher's own listing as its own, not as foreign", () => {
    const verdict = isolationVerdict({ hosts, issued, windows, listed })

    expect(verdict.byPublisher[ACME]).toMatchObject({ foreignInWindow: [], foreignListed: [] })
  })

  it("counts another publisher's receipt in a window as foreign", () => {
    const leaked = new Map(windows).set(HARBOUR, new Set(['h1', 'k1']))
    const verdict = isolationVerdict({ hosts, issued, windows: leaked, listed })

    expect(verdict.byPublisher[HARBOUR]).toMatchObject({ foreignInWindow: ['k1'] })
    expect(verdict).toMatchObject({ foreignRows: 1, verdict: 'fail' })
  })

  it('counts a row the window shows but no listing of its own explains as foreign', () => {
    const odd = new Map(windows).set(KYIV, new Set(['k1', 'zz']))

    expect(
      isolationVerdict({ hosts, issued, windows: odd, listed }).byPublisher[KYIV],
    ).toMatchObject({
      foreignInWindow: ['zz'],
    })
  })

  it('counts a listed row on a host the publisher does not own as foreign', () => {
    const wide = new Map(listed).set(KYIV, [
      listedRow('k1', 'kyiv-photo.test'),
      listedRow('x9', 'acme-news.test'),
    ])
    const verdict = isolationVerdict({ hosts, issued, windows, listed: wide })

    expect(verdict.byPublisher[KYIV]).toMatchObject({ foreignListed: ['x9'] })
    expect(verdict.verdict).toBe('fail')
  })

  it('fails when a publisher misses one of its own, in the window or in the listing', () => {
    const short = new Map(listed).set(ACME, [listedRow('a1', 'acme-news.test')])
    const verdict = isolationVerdict({ hosts, issued, windows, listed: short })

    expect(verdict.byPublisher[ACME]).toMatchObject({ missingListed: ['a2'], missingInWindow: [] })
    expect(verdict).toMatchObject({ complete: 2, verdict: 'fail' })
  })

  it('fails with fewer than three publishers, however clean', () => {
    const two = new Map([...hosts].filter(([owner]) => owner !== HARBOUR))
    const verdict = isolationVerdict({
      hosts: two,
      issued: issued.filter((r) => r.owner !== HARBOUR),
      windows,
      listed,
    })

    expect(verdict).toMatchObject({ publishers: 2, foreignRows: 0, verdict: 'fail' })
  })
})

describe("takings: the dashboard total, the run's receipts and the chain agree per publisher", () => {
  const payouts = new Map([
    [ACME, 'acme-ata'],
    [KYIV, 'kyiv-payout-ata'],
    [HARBOUR, 'harbour-ata'],
  ])
  const summaryOf = (
    total: bigint,
    count: number,
    extra: { consumer: string; total: bigint }[] = [],
  ) => ({
    byConsumer: [{ consumer: AGENT, count, total }, ...extra.map((e) => ({ ...e, count: 1 }))],
  })
  const summaries = new Map([
    [ACME, summaryOf(11_000n, 2, [{ consumer: OTHER_AGENT, total: 70n }])],
    [KYIV, summaryOf(5000n, 1)],
    [HARBOUR, summaryOf(4000n, 1)],
  ])
  const flows = [
    new Map([
      ['vault', -12_100n],
      ['acme-ata', 2000n],
      ['kyiv-payout-ata', 5000n],
      ['harbour-ata', 4000n],
      ['treasury', 1100n],
    ]),
    new Map([
      ['agent-ata', -9900n],
      ['acme-ata', 9000n],
      ['treasury', 900n],
    ]),
  ]

  it("passes when all three numbers match for every publisher; other agents' takings stay out", () => {
    const verdict = takingsVerdict({ consumer: AGENT, issued, summaries, payouts, flows })

    expect(verdict.byPublisher[ACME]).toEqual({
      receipts: 2,
      charged: 11_000n,
      dashboard: { count: 2, total: 11_000n },
      onChain: 11_000n,
    })
    expect(verdict.verdict).toBe('pass')
  })

  it('fails when the dashboard total drifts from the receipts', () => {
    const drifted = new Map(summaries).set(KYIV, summaryOf(4999n, 1))

    expect(
      takingsVerdict({ consumer: AGENT, issued, summaries: drifted, payouts, flows }).verdict,
    ).toBe('fail')
  })

  it('fails when the chain paid a publisher other than what its receipts say', () => {
    const short = [flows[0] as Map<string, bigint>]

    const verdict = takingsVerdict({ consumer: AGENT, issued, summaries, payouts, flows: short })

    expect(verdict.byPublisher[ACME]).toMatchObject({ onChain: 2000n })
    expect(verdict.verdict).toBe('fail')
  })

  it("fails when the agent is absent from a publisher's summary", () => {
    const blank = new Map(summaries).set(HARBOUR, { byConsumer: [] })
    const verdict = takingsVerdict({ consumer: AGENT, issued, summaries: blank, payouts, flows })

    expect(verdict.byPublisher[HARBOUR]).toMatchObject({ dashboard: { count: 0, total: 0n } })
    expect(verdict.verdict).toBe('fail')
  })
})
