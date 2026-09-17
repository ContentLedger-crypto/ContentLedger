import { canonicalSourceId } from '@contentledger/chain/identifiers'

/**
 * Корпус живе на одному порту, а домен переїжджає в перший сегмент шляху.
 * Маршрутизація за заголовком `Host` була б ближчою до справжнього вебу, але
 * вимагала б правок у системному `hosts` — недосяжних у CI й на чужій машині.
 *
 * Наслідок, який треба називати вголос на демо: локальна адреса **не збігається**
 * з канонічним `source_id`, і саме тому переклад між ними живе в одній функції,
 * яку кличуть і шлюз, і посів реєстру, і вузол-атестатор.
 */
export function fixturePath(source: string): string {
  const url = new URL(canonicalSourceId(source))
  return `/${url.hostname}${url.pathname}`
}

/** `baseUrl` — origin сервера корпусу (`FIXTURES_BASE_URL`). */
export function fixtureUrl(source: string, baseUrl: string): string {
  return new URL(fixturePath(source), baseUrl).href
}

/** Обернений бік: із сегментів локального запиту зібрати канонічне джерело. */
export function sourceIdOf(host: string, path: string): string {
  return canonicalSourceId(`https://${host}${path}`)
}
