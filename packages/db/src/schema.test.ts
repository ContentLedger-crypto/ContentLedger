import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Обмеження живуть у згенерованому SQL, а не в голові. Перегенерація, яка
 * тихо загубила б `check`, розсипає цей тест — інакше про втрату дізналися б
 * із рядка в базі, якого не мало бути.
 */

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

const sql = readdirSync(migrations)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => readFileSync(join(migrations, file), 'utf8'))
  .join('\n')

describe('перша міграція', () => {
  it('містить усі дев’ять таблиць', () => {
    for (const table of [
      'attestations',
      'auth_challenges',
      'batches',
      'domains',
      'escrows',
      'receipts',
      'sessions',
      'vouchers',
      'works',
    ]) {
      expect(sql, table).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('несе payment_method, registry_hash, accepted_at і settled_at з першої версії', () => {
    for (const column of [
      'payment_method',
      'payment_ref',
      'registry_hash',
      'accepted_at',
      'settled_at',
    ]) {
      expect(sql, column).toContain(`"${column}"`)
    }
  })

  it('дискримінований союз квитанції є обмеженням, а не домовленістю', () => {
    expect(sql).toContain('receipts_payment_ref_matches_method')
    expect(sql).toContain('receipts_x402_never_batched')
  })

  it('жодна сума не може стати відʼємною', () => {
    for (const constraint of [
      'domains_rate_train_non_negative',
      'works_rate_train_non_negative',
      'escrows_deposited_non_negative',
      'receipts_tariff_non_negative',
      'receipts_fee_non_negative',
      'receipts_node_cut_non_negative',
      'vouchers_cumulative_non_negative',
    ]) {
      expect(sql, constraint).toContain(constraint)
    }
  })

  it('гроші зберігаються як bigint, а не numeric чи double', () => {
    expect(sql).toContain('"tariff" bigint NOT NULL')
    expect(sql).toContain('"cumulative" bigint NOT NULL')
    expect(sql).not.toContain('double precision')
  })

  it('час підписаного поля зберігається текстом, а не тільки міткою', () => {
    expect(sql).toContain('"accepted_at" text NOT NULL')
    expect(sql).toContain('"accepted_ts" timestamp with time zone NOT NULL')
  })

  it('джерело твору унікальне так само, як і ончейн', () => {
    expect(sql).toContain('works_source_id_idx')
  })
})
