import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Дзеркало ончейн-стану плюс те, чого в ланцюгу немає: квитанції, склад
 * батчів, сесії. Джерело правди — ончейн (FR-006); тут швидке читання.
 *
 * Три наскрізні рішення:
 *
 * **Гроші — `bigint({ mode: 'bigint' })`, ніде не `number`.** Дефолтів на цих
 * колонках немає навмисно: `.default(0n)` валить `drizzle-kit generate` через
 * `JSON.stringify`, який BigInt не серіалізує. Значення ставляться в коді.
 * Межа `int8` — 2^63−1, тобто вдвічі менше за `u64`, який приймає `money.ts`;
 * це в 500 разів більше за всю емісію USDC, а спроба записати більше дасть
 * помилку Postgres, не мовчазне обрізання. `check (>= 0)` стоїть скрізь, бо
 * `int8` знаковий, а відʼємних сум у нас не буває.
 *
 * **Хеші й ключі — текст**: hex для хешів, base58 для ключів і підписів. Ті
 * самі рядки, що в API, у тілі квитанції та в декодерах `packages/chain`, тож
 * перетворень між шарами немає взагалі.
 *
 * **Час підписаних полів зберігається двічі.** `accepted_at` — `text` у
 * канонічній формі (саме ці байти входять у хеш, який і є `receipts.id`), а
 * `accepted_ts` — `timestamptz` для сортування, індексів і періодів. Один
 * timestamptz не годиться: відтворення канонічного рядка форматуванням — це
 * місце, де мікросекунди або `+00:00` замість `Z` тихо ламають `id` **усіх**
 * квитанцій і всі докази включення.
 */

export const licenceStatus = pgEnum('licence_status', ['active', 'suspended'])
export const useType = pgEnum('use_type', ['train', 'inference'])
export const rateLevel = pgEnum('rate_level', ['domain', 'work'])
export const paymentMethod = pgEnum('payment_method', ['escrow', 'x402'])

const hex64 = (name: string) => char(name, { length: 64 })
const base58 = (name: string) => text(name)
/** Базові одиниці USDC. Без дефолту — див. пастку `drizzle-kit` вище. */
const usdc = (name: string) => bigint(name, { mode: 'bigint' })

export const domains = pgTable(
  'domains',
  {
    host: text('host').primaryKey(),
    owner: base58('owner').notNull(),
    payoutOwner: base58('payout_owner').notNull(),
    rateTrain: usdc('rate_train').notNull(),
    rateInference: usdc('rate_inference').notNull(),
    status: licenceStatus('status').notNull(),
    /** Слот, на якому знято дзеркало: старіше дзеркало не перезаписує новіше. */
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    index('domains_owner_idx').on(table.owner),
    check('domains_rate_train_non_negative', sql`${table.rateTrain} >= 0`),
    check('domains_rate_inference_non_negative', sql`${table.rateInference} >= 0`),
  ],
)

export const works = pgTable(
  'works',
  {
    /** Адреса PDA твору в base58 — той самий ключ, що в тілі квитанції. */
    id: base58('id').primaryKey(),
    host: text('host')
      .notNull()
      .references(() => domains.host),
    /** Канонічний URL. Перевіряє `canonicalSourceId` у `packages/chain`. */
    sourceId: text('source_id').notNull(),
    contentHash: hex64('content_hash').notNull(),
    /** `null` — перекриття не задано; нуль тут є ставкою «безкоштовно». */
    rateTrain: usdc('rate_train'),
    rateInference: usdc('rate_inference'),
    status: licenceStatus('status').notNull(),
    mediaType: text('media_type').notNull(),
    byteLen: integer('byte_len').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('works_source_id_idx').on(table.sourceId),
    index('works_host_idx').on(table.host),
    check('works_rate_train_non_negative', sql`${table.rateTrain} >= 0`),
    check('works_rate_inference_non_negative', sql`${table.rateInference} >= 0`),
    check('works_byte_len_non_negative', sql`${table.byteLen} >= 0`),
  ],
)

export const escrows = pgTable(
  'escrows',
  {
    consumer: base58('consumer').primaryKey(),
    deposited: usdc('deposited').notNull(),
    settledTotal: usdc('settled_total').notNull(),
    lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull(),
    lastChain: hex64('last_chain').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    check('escrows_deposited_non_negative', sql`${table.deposited} >= 0`),
    check('escrows_settled_total_non_negative', sql`${table.settledTotal} >= 0`),
    check('escrows_last_seq_non_negative', sql`${table.lastSeq} >= 0`),
  ],
)

export const batches = pgTable(
  'batches',
  {
    /** Hex меркл-кореня: батч так само content-addressed, як і квитанція. */
    id: hex64('id').primaryKey(),
    consumer: base58('consumer').notNull(),
    seqFrom: bigint('seq_from', { mode: 'bigint' }).notNull(),
    seqTo: bigint('seq_to', { mode: 'bigint' }).notNull(),
    root: hex64('root').notNull(),
    chain: hex64('chain').notNull(),
    txSig: base58('tx_sig').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('batches_consumer_idx').on(table.consumer, table.seqTo),
    check('batches_range_ordered', sql`${table.seqTo} >= ${table.seqFrom}`),
    check('batches_seq_from_positive', sql`${table.seqFrom} >= 1`),
  ],
)

export const receipts = pgTable(
  'receipts',
  {
    /** Hex листкового хеша тіла (T011). Content-addressed, тому не серійний. */
    id: hex64('id').primaryKey(),
    consumer: base58('consumer').notNull(),
    workId: base58('work_id')
      .notNull()
      .references(() => works.id),
    useType: useType('use_type').notNull(),
    tariff: usdc('tariff').notNull(),
    fee: usdc('fee').notNull(),
    /** Поза підписаним тілом: рахується з `Config` у момент сетлменту. */
    nodeCut: usdc('node_cut'),
    rateLevel: rateLevel('rate_level').notNull(),
    servedHash: hex64('served_hash').notNull(),
    registryHash: hex64('registry_hash').notNull(),
    /** Виводиться з двох хешів, тому в тілі його немає (FR-011b). */
    hashMatch: boolean('hash_match').notNull(),
    paymentMethod: paymentMethod('payment_method').notNull(),
    /** Підпис x402-транзакції; для escrow — `null` (FR-013c). */
    paymentRef: base58('payment_ref'),
    /** Канонічні байти з підписаного тіла. Форматуванню не підлягає. */
    acceptedAt: text('accepted_at').notNull(),
    /** Той самий момент у придатному для запитів вигляді. */
    acceptedTs: timestamp('accepted_ts', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    batchId: hex64('batch_id').references(() => batches.id),
  },
  (table) => [
    index('receipts_consumer_idx').on(table.consumer, table.acceptedTs),
    index('receipts_work_idx').on(table.workId, table.acceptedTs),
    index('receipts_batch_idx').on(table.batchId),
    check('receipts_tariff_non_negative', sql`${table.tariff} >= 0`),
    check('receipts_fee_non_negative', sql`${table.fee} >= 0`),
    check('receipts_node_cut_non_negative', sql`${table.nodeCut} >= 0`),
    // Дискримінований союз із тіла квитанції, повторений як обмеження: інакше
    // «квитанція x402 без посилання на платіж» була б валідним рядком.
    check(
      'receipts_payment_ref_matches_method',
      sql`(${table.paymentMethod} = 'x402') = (${table.paymentRef} is not null)`,
    ),
    // Батч збирається тільки з escrow-квитанцій (FR-013c).
    check(
      'receipts_x402_never_batched',
      sql`${table.paymentMethod} = 'escrow' or ${table.batchId} is null`,
    ),
  ],
)

export const vouchers = pgTable(
  'vouchers',
  {
    consumer: base58('consumer').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    cumulative: usdc('cumulative').notNull(),
    chain: hex64('chain').notNull(),
    signature: base58('signature').notNull(),
    receiptId: hex64('receipt_id')
      .notNull()
      .references(() => receipts.id),
    batchId: hex64('batch_id').references(() => batches.id),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.seq] }),
    uniqueIndex('vouchers_receipt_idx').on(table.receiptId),
    index('vouchers_batch_idx').on(table.batchId),
    check('vouchers_seq_positive', sql`${table.seq} >= 1`),
    check('vouchers_cumulative_non_negative', sql`${table.cumulative} >= 0`),
  ],
)

export const attestations = pgTable(
  'attestations',
  {
    workId: base58('work_id')
      .notNull()
      .references(() => works.id),
    nodeKey: base58('node_key').notNull(),
    contentHash: hex64('content_hash').notNull(),
    ownerClaimed: base58('owner_claimed').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workId, table.nodeKey] })],
)

export const authChallenges = pgTable('auth_challenges', {
  nonce: text('nonce').primaryKey(),
  wallet: base58('wallet').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Не `null` рівно з моменту використання: другий раз виклик не приймається. */
  usedAt: timestamp('used_at', { withTimezone: true }),
})

export const sessions = pgTable(
  'sessions',
  {
    /** Хеш токена, не сам токен: витік дампа не дає чинних сесій. */
    tokenHash: hex64('token_hash').primaryKey(),
    wallet: base58('wallet').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('sessions_wallet_idx').on(table.wallet)],
)
