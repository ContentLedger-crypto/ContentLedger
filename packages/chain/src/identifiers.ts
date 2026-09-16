import { sha256 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'

/**
 * Ідентифікатори, з яких виводяться сіди.
 *
 * `isCanonicalHost` — свідоме **друге** втілення перевірки з програми
 * (`is_canonical_host` у `registry.rs`). Одну реалізацію тут мати неможливо:
 * програма мусить перевіряти сама, бо хеш є сідом, а клієнт мусить перевіряти
 * до відправки, щоб не платити за відмову. Дві реалізації звіряються тією
 * самою таблицею форм у тестах з обох боків.
 *
 * Канонічний вигляд `source_id` **програма не бачить взагалі** — вона отримує
 * лише 32 байти. Тому правило живе тільки тут, і саме тому воно суворе:
 * єдиний захист від того, що шлюз і посів реєстру порахують два різні хеші
 * для одного твору, — те, що обидва кличуть цю функцію.
 */

export const MAX_HOST_LEN = 253
const MAX_LABEL_LEN = 63

/** Канонічний хост: lowercase ASCII, без схеми, порту й кінцевої крапки. */
export function isCanonicalHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOST_LEN) {
    return false
  }

  const labels = host.split('.')
  if (labels.length < 2) {
    return false
  }

  return labels.every((label) => {
    if (label.length === 0 || label.length > MAX_LABEL_LEN) {
      return false
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      return false
    }
    return /^[a-z0-9-]+$/.test(label)
  })
}

export function assertCanonicalHost(host: string): string {
  if (!isCanonicalHost(host)) {
    throw new TypeError(`хост не в канонічній формі: ${JSON.stringify(host)}`)
  }
  return host
}

/** sha256 канонічного хоста — сід `Domain`. */
export function hostSeed(host: string): Uint8Array {
  return sha256(utf8ToBytes(assertCanonicalHost(host)))
}

/**
 * Канонічний ідентифікатор джерела. Не переписує URL, а **відхиляє**
 * неканонічний: мовчазне переписування дало б два ідентифікатори одному твору
 * рівно там, де його не видно — у хеші.
 */
export function canonicalSourceId(source: string): string {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new TypeError(`джерело має бути абсолютним URL: ${JSON.stringify(source)}`)
  }

  if (url.protocol !== 'https:') {
    throw new TypeError(`джерело має бути https, а не ${url.protocol}`)
  }
  if (url.port !== '') {
    throw new TypeError('порт у джерелі не записується — навіть типовий')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('облікові дані в URL джерела не допускаються')
  }
  if (url.hash !== '') {
    throw new TypeError('фрагмент не є частиною твору')
  }
  assertCanonicalHost(url.hostname)
  if (url.pathname === '' || url.pathname === '/') {
    throw new TypeError('джерело мусить указувати на твір, а не на корінь домену')
  }
  if (url.href !== source) {
    throw new TypeError(`джерело не в канонічній формі: ${JSON.stringify(source)}`)
  }

  return source
}

/** sha256 канонічного джерела — сід `Work`. */
export function sourceSeed(source: string): Uint8Array {
  return sha256(utf8ToBytes(canonicalSourceId(source)))
}

/** Хост, під яким лежить джерело: звʼязок «твір → домен» на боці клієнта. */
export function hostOf(source: string): string {
  return new URL(canonicalSourceId(source)).hostname
}
