type FilterLike = {
  field: string
  value: string
}

function filtersMatch<TFilter extends FilterLike>(
  left: TFilter,
  right: TFilter,
): boolean {
  return left.field === right.field && left.value === right.value
}

export function appendUniqueFilter<TFilter extends FilterLike>(
  filters: TFilter[],
  nextFilter: TFilter,
): TFilter[] {
  if (filters.some((filter) => filtersMatch(filter, nextFilter))) {
    return filters
  }

  return [...filters, nextFilter]
}

export function removeFilter<TFilter extends FilterLike>(
  filters: TFilter[],
  nextFilter: TFilter,
): TFilter[] {
  return filters.filter((filter) => !filtersMatch(filter, nextFilter))
}
