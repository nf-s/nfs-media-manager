import type { ListeningMonth } from '@repo/schemas/lastfm'

/**
 * Counts for every UTC calendar month from the month of `from`, an ISO date,
 * to the month of `now`, oldest first. Months with no scrobbles are zero.
 */
export function listeningMonthsSince(
  months: readonly ListeningMonth[],
  from: string,
  now: Date,
): number[] {
  const counts = new Map(months.map((month) => [month.month, month.count]))
  const [fromYear = NaN, fromMonth = NaN] = from.split('-').map(Number)
  const year = now.getUTCFullYear()
  const current = now.getUTCMonth()
  const count = Math.max(
    1,
    (year - fromYear) * 12 + current - (fromMonth - 1) + 1,
  )
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(Date.UTC(year, current - (count - 1 - index), 1))
    const key = start.toISOString().slice(0, 7)
    return counts.get(key) ?? 0
  })
}
