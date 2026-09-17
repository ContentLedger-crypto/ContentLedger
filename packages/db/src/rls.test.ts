import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.js'

/**
 * Список таблиць береться зі схеми, а не з константи: десята таблиця,
 * додана без RLS, має розсипати гейт, а не поїхати на прод відкритою.
 */

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

const sql = readdirSync(migrations)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(join(migrations, file), 'utf8'))
  .join('\n')

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map(getTableName)
  .sort()

describe('RLS «нікому»', () => {
  it('бачить усі девʼять таблиць схеми', () => {
    expect(tables).toEqual([
      'attestations',
      'auth_challenges',
      'batches',
      'domains',
      'escrows',
      'receipts',
      'sessions',
      'vouchers',
      'works',
    ])
  })

  it('вмикає RLS на кожній таблиці схеми', () => {
    for (const table of tables) {
      expect(sql, table).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`)
    }
  })

  it('кладе на кожну таблицю RESTRICTIVE-заборону для anon і authenticated', () => {
    for (const table of tables) {
      expect(sql, table).toContain(
        `CREATE POLICY "${table}_deny_all" ON "${table}" ` +
          'AS RESTRICTIVE FOR ALL TO "anon", "authenticated" ' +
          'USING (false) WITH CHECK (false);',
      )
    }
  })

  it('не має жодної політики, яка щось дозволяє', () => {
    const policies = sql.match(/CREATE POLICY[^;]+;/g) ?? []
    expect(policies).toHaveLength(tables.length)
    for (const policy of policies) {
      expect(policy).toContain('AS RESTRICTIVE')
      expect(policy).toContain('USING (false)')
      expect(policy).toContain('WITH CHECK (false)')
    }
  })
})
