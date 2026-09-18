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
const librs = join(here, '../../program/programs/contentledger/src/lib.rs')

// `address` береться з `declare_id!`, а не з того, що записав `anchor build`:
// CLI бере його з `target/deploy/*-keypair.json`, якого в CI немає (ключ
// програми не в репозиторії), і на раннері підставляє свіжозгенерований —
// перший прогін розійшовся рівно в цьому одному полі. Рантайм програми
// перевіряє саме `declare_id!`, тож це і є джерело правди.
const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(librs, 'utf8'))
if (declared === null) {
  console.error(`У ${librs} немає declare_id!`)
  process.exit(2)
}

const format = (idl) => `${JSON.stringify(idl, null, 2)}\n`

let fresh
try {
  const idl = JSON.parse(readFileSync(generated, 'utf8'))
  idl.address = declared[1]
  fresh = format(idl)
} catch {
  console.error(`Немає ${generated}. Спершу \`anchor build\` у packages/program.`)
  process.exit(2)
}

if (process.argv.includes('--check')) {
  // Копія переформатовується, але не виправляється: порівнюється зміст, а не
  // байти (форматер, що торкнувся копії, давав би червоний CI при ідентичному
  // IDL), проте хибний `address` у копії лишається видимою розбіжністю.
  const current = format(JSON.parse(readFileSync(committed, 'utf8')))
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
