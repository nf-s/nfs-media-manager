import type { ListeningMonth } from '@repo/schemas/lastfm'

/** Months in a stat's sparkline, as in the Artists list. */
export const RECENT_LISTENING_MONTHS = 12

/**
 * Counts for the last `count` UTC calendar months, oldest first, ending with
 * the month of `now`. Months with no scrobbles are zero.
 */
export function recentListeningMonths(
  months: readonly ListeningMonth[],
  now: Date,
  count = RECENT_LISTENING_MONTHS,
): number[] {
  const counts = new Map(months.map((month) => [month.month, month.count]))
  const year = now.getUTCFullYear()
  const current = now.getUTCMonth()
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(Date.UTC(year, current - (count - 1 - index), 1))
    const key = start.toISOString().slice(0, 7)
    return counts.get(key) ?? 0
  })
}
