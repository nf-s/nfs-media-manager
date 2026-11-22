import { clientQueryDefaults } from './query-cache'

export const browsePageSize = 100

export function browseWindow({
  total,
  columns,
  rowHeight,
  scrollTop,
  viewportHeight,
  headerHeight = 0,
  pageSize = browsePageSize,
  extraRowHeights,
}: {
  total: number
  columns: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  headerHeight?: number
  pageSize?: number
  extraRowHeights?: ReadonlyMap<number, number>
}) {
  const rows = Math.ceil(total / columns)
  const extra = [...(extraRowHeights ?? [])].filter(
    ([index, height]) => index >= 0 && index < rows && height > 0,
  )
  const rowTop = (index: number) =>
    index * rowHeight +
    extra.reduce((sum, [row, height]) => (row < index ? sum + height : sum), 0)
  function rowAt(offset: number) {
    let start = 0
    let end = Math.max(0, rows - 1)
    while (start < end) {
      const middle = Math.ceil((start + end) / 2)
      if (rowTop(middle) <= offset) start = middle
      else end = middle - 1
    }
    return start
  }
  const top = Math.max(0, scrollTop - headerHeight)
  const firstVisible = extra.length
    ? rowAt(top)
    : Math.min(Math.max(0, rows - 1), Math.floor(top / rowHeight))
  const bottom = top + viewportHeight
  const bottomRow = extra.length ? rowAt(bottom) : Math.ceil(bottom / rowHeight)
  const visibleEndRow =
    extra.length && rowTop(bottomRow) < bottom ? bottomRow + 1 : bottomRow
  const startRow = Math.max(0, firstVisible - 4)
  const endRow = Math.min(
    rows,
    (extra.length
      ? rowAt(top + viewportHeight)
      : firstVisible + Math.ceil(viewportHeight / rowHeight)) + 5,
  )
  const start = startRow * columns
  const end = Math.min(total, endRow * columns)
  const pages: number[] = []
  for (
    let page = Math.floor(start / pageSize) + 1;
    page <= Math.ceil(end / pageSize);
    page++
  ) {
    pages.push(page)
  }
  return {
    start,
    end,
    firstVisibleIndex: firstVisible * columns,
    visibleEnd: Math.min(
      total,
      Math.max(firstVisible + 1, visibleEndRow) * columns,
    ),
    pages,
    padTop: rowTop(startRow),
    padBottom: rowTop(rows) - rowTop(endRow),
    height: rowTop(rows),
  }
}

// Each page has its own cancellable query. Retain visited pages so scrolling
// back or returning to a filter can show cached rows immediately.
export function browsePageOptions<T>(
  collection: string,
  identity: string,
  page: number,
  load: (page: number, signal: AbortSignal) => Promise<T>,
) {
  return virtualPageOptions([collection, 'browse', identity], page, load)
}

export function virtualPageOptions<T>(
  queryKey: readonly unknown[],
  page: number,
  load: (page: number, signal: AbortSignal) => Promise<T>,
) {
  return {
    queryKey: [...queryKey, page],
    queryFn: ({ signal }: { signal: AbortSignal }) => load(page, signal),
    ...clientQueryDefaults,
    retry: false,
  }
}
