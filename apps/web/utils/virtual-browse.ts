export const browsePageSize = 100

export function browseWindow({
  total,
  columns,
  rowHeight,
  scrollTop,
  viewportHeight,
  headerHeight = 0,
}: {
  total: number
  columns: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  headerHeight?: number
}) {
  const rows = Math.ceil(total / columns)
  const firstVisible = Math.min(
    Math.max(0, rows - 1),
    Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight),
  )
  const startRow = Math.max(0, firstVisible - 4)
  const endRow = Math.min(
    rows,
    firstVisible + Math.ceil(viewportHeight / rowHeight) + 5,
  )
  const start = startRow * columns
  const end = Math.min(total, endRow * columns)
  const pages: number[] = []
  for (
    let page = Math.floor(start / browsePageSize) + 1;
    page <= Math.ceil(end / browsePageSize);
    page++
  ) {
    pages.push(page)
  }
  return {
    start,
    end,
    pages,
    padTop: startRow * rowHeight,
    padBottom: (rows - endRow) * rowHeight,
    height: rows * rowHeight,
  }
}

// Each page has its own cancellable query. Removing an observer discards distant
// pages immediately, rather than accumulating the whole library during a visit.
export function browsePageOptions<T>(
  collection: string,
  identity: string,
  page: number,
  load: (page: number, signal: AbortSignal) => Promise<T>,
) {
  return {
    queryKey: [collection, 'browse', identity, page],
    queryFn: ({ signal }: { signal: AbortSignal }) => load(page, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  }
}
