// Копія IDL у репозиторії, бо `packages/program/target/` під `.gitignore`, а
// свіжий клон і TS-джоба в CI не мають ані Rust-тулчейну, ані 18 хвилин на
// збірку програми.
//
// `--check` звіряє копію зі згенерованим і виходить ненульовим кодом на
// розбіжності. Саме цей режим стоїть у CI-джобі `program`, яка `anchor build`
// і так робить: застаріла копія стає червоним CI, а не дивною помилкою на
// devnet або, гірше, транзакцією з не тими байтами.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const generated = join(here, '../../program/target/idl/contentledger.json')
const committed = join(here, '../src/idl/contentledger.json')

const normalise = (raw) => `${JSON.stringify(JSON.parse(raw), null, 2)}\n`

let fresh
try {
  fresh = normalise(readFileSync(generated, 'utf8'))
} catch {
  console.error(`Немає ${generated}. Спершу \`anchor build\` у packages/program.`)
  process.exit(2)
}

if (process.argv.includes('--check')) {
  // Обидва боки через ту саму нормалізацію: порівнюється зміст, а не байти.
  // Інакше будь-який форматер, що торкнувся копії, давав би червоний CI при
  // ідентичному IDL — саме так і сталося на першому прогоні.
  const current = normalise(readFileSync(committed, 'utf8'))
  if (current !== fresh) {
    console.error(
      'IDL у packages/chain розійшовся з програмою. Запусти `pnpm --filter @contentledger/chain idl:sync`.',
    )
    // Перші розбіжні рядки — інакше з CI видно лише факт, а не причину.
    const was = current.split('\n')
    const now = fresh.split('\n')
    let shown = 0
    for (let i = 0; i < Math.max(was.length, now.length) && shown < 20; i++) {
      if (was[i] !== now[i]) {
        console.error(`  рядок ${i + 1}`)
        console.error(`    копія:    ${was[i] ?? '<кінець>'}`)
        console.error(`    програма: ${now[i] ?? '<кінець>'}`)
        shown++
      }
    }
    process.exit(1)
  }
  console.log('IDL збігається з програмою.')
} else {
  writeFileSync(committed, fresh)
  console.log(`Оновлено ${committed}`)
}
