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
