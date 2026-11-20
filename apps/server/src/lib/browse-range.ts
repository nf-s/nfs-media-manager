import { sql, type SQL } from 'drizzle-orm'
import type { BrowseRange } from '@repo/schemas/browse'

// Keep whole-number comparisons in PostgreSQL's integer B-tree operator family.
// Fractional and larger bounds still compare exactly against numeric columns.
function numericBound(value: number): SQL {
  return Number.isSafeInteger(value)
    ? sql`${value}::bigint`
    : sql`${value}::numeric`
}

export function rangeCondition(
  range: BrowseRange,
  value: SQL,
  bound: (value: number) => SQL = numericBound,
) {
  const bounds: SQL[] = []
  if (range.min !== undefined) bounds.push(sql`${value} >= ${bound(range.min)}`)
  if (range.max !== undefined) bounds.push(sql`${value} <= ${bound(range.max)}`)
  if (!bounds.length)
    return range.includeMissing ? sql`true` : sql`${value} is not null`
  const predicate = sql`(${sql.join(bounds, sql` and `)})`
  return range.includeMissing
    ? sql`(${predicate} or ${value} is null)`
    : predicate
}

function isTimestampBound(value: number | undefined) {
  if (value === undefined) return true
  if (!Number.isSafeInteger(value)) return false
  const year = new Date(value).getUTCFullYear()
  return year >= 1 && year <= 9999
}

/** Compare stored UTC timestamps directly for ordinary millisecond bounds. */
export function timestampRangeCondition(range: BrowseRange, value: SQL) {
  // Keep numeric comparisons for sub-millisecond precision and dates outside
  // the four-digit AD years shared by JavaScript ISO strings and PostgreSQL.
  if (!isTimestampBound(range.min) || !isTimestampBound(range.max))
    return rangeCondition(range, sql`extract(epoch from ${value}) * 1000`)
  return rangeCondition(
    range,
    value,
    (bound) => sql`${new Date(bound).toISOString()}::timestamp`,
  )
}
