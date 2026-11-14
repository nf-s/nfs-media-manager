export type TableSort<Key extends string = string> = {
  key: Key
  direction: 'asc' | 'desc'
}
export type TableValue = string | number | boolean | null | undefined

/** Sort raw values, keep missing values last, and preserve input order for ties. */
export function sortTableRows<T, Key extends string>(
  rows: readonly T[],
  sort: TableSort<Key>,
  value: (row: T, key: Key) => TableValue,
): T[] {
  return [...rows].sort((left, right) => {
    const a = value(left, sort.key)
    const b = value(right, sort.key)
    const missingA = a == null || (typeof a === 'number' && !Number.isFinite(a))
    const missingB = b == null || (typeof b === 'number' && !Number.isFinite(b))
    if (missingA || missingB)
      return missingA === missingB ? 0 : missingA ? 1 : -1
    const comparison =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : typeof a === 'boolean' && typeof b === 'boolean'
          ? Number(a) - Number(b)
          : String(a).localeCompare(String(b), undefined, {
              numeric: true,
              sensitivity: 'base',
            })
    return sort.direction === 'asc' ? comparison : -comparison
  })
}
