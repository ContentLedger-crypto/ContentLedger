/**
 * Пара колонок для `accepted_at`.
 *
 * `receipts.accepted_at` зберігає **байти з підписаного тіла**, а
 * `receipts.accepted_ts` — той самий момент у придатному для запитів вигляді.
 * Інваріант «вони про один момент» тримається не дисципліною викликів, а тим,
 * що обидві колонки роблить одна функція з одного рядка: другого шляху їх
 * заповнити немає.
 *
 * Зворотного перетворення тут немає навмисно. Відновлювати канонічний рядок із
 * `timestamptz` — рівно те місце, де мікросекунди або `+00:00` замість `Z`
 * тихо ламають `receipts.id` усіх квитанцій разом із доказами включення.
 */

/** Той самий вигляд, що прибитий у `receiptBodySchema` (T011). */
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export interface AcceptedAtColumns {
  acceptedAt: string
  acceptedTs: Date
}

export function acceptedAtColumns(canonical: string): AcceptedAtColumns {
  if (!CANONICAL.test(canonical)) {
    throw new TypeError(`accepted_at не в канонічній формі: ${JSON.stringify(canonical)}`)
  }

  const acceptedTs = new Date(canonical)
  if (Number.isNaN(acceptedTs.getTime())) {
    throw new TypeError(`accepted_at не є моментом часу: ${JSON.stringify(canonical)}`)
  }
  // Форма пройшла регекс, але `2026-02-30T…` регексу не суперечить, а Date
  // мовчки переносить на березень — і колонки розійшлися б на добу.
  if (acceptedTs.toISOString() !== canonical) {
    throw new TypeError(`такої дати не існує: ${JSON.stringify(canonical)}`)
  }

  return { acceptedAt: canonical, acceptedTs }
}
