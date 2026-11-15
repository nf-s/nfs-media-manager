'use client'

import { useQuery, useQueryClient, hashKey } from '@tanstack/react-query'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react'
import {
  mediaGridGeometry,
  preserveGridScroll,
  type BrowseView,
} from '@/utils/media-grid'
import { subscriptionGridGeometry } from '@/utils/subscriptions'
import { browsePageSize, browseWindow } from '@/utils/virtual-browse'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  useVirtualPages,
  type VirtualPageData,
  type VirtualPageOptions,
} from './useVirtualBrowse'

type TableGeometry = {
  rowHeight?: number
  headerHeight?: number
  extraRowHeights?: ReadonlyMap<number, number>
  presentation?: {
    view: BrowseView
    mediaType: 'album' | 'film' | 'subscription'
  }
}

type VirtualTableOptions<Page extends VirtualPageData> = Omit<
  VirtualPageOptions<Page>,
  'pageSize'
> &
  TableGeometry & { pageSize?: number; viewportKey?: readonly unknown[] }

function useTableViewport(
  identity: string,
  tableRowHeight: number,
  tableHeaderHeight: number,
  presentation: TableGeometry['presentation'],
) {
  const [element, scroller] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ height: 420, width: 480 })
  const [position, setPosition] = useState({ identity, top: 0 })
  const view = presentation?.view ?? 'table'
  const grid =
    presentation?.view === 'grid'
      ? presentation.mediaType === 'subscription'
        ? subscriptionGridGeometry(viewport.width)
        : mediaGridGeometry({
            width: viewport.width,
            mediaType: presentation.mediaType,
            density: 'standard',
          })
      : undefined
  const columns = grid?.columns ?? 1
  const gap = grid?.gap ?? 0
  const rowHeight = grid?.rowHeight ?? (view === 'list' ? 64 : tableRowHeight)
  const headerHeight = view === 'table' ? tableHeaderHeight : 0
  const previousLayout = useRef({ columns, rowHeight, headerHeight })
  const prior = previousLayout.current
  const resized =
    prior.columns !== columns ||
    prior.rowHeight !== rowHeight ||
    prior.headerHeight !== headerHeight
  const scrollTop =
    position.identity !== identity || position.top === 0
      ? 0
      : resized
        ? preserveGridScroll(position.top - prior.headerHeight, prior, {
            columns,
            rowHeight,
          }) + headerHeight
        : position.top
  useLayoutEffect(() => {
    if (!element) return
    function measure() {
      const height = element?.clientHeight
      const width = element?.clientWidth
      if (height && width) {
        setViewport((previous) =>
          previous.height === height && previous.width === width
            ? previous
            : { height, width },
        )
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  useLayoutEffect(() => {
    previousLayout.current = { columns, rowHeight, headerHeight }
    if (element?.isConnected && element.scrollTop !== scrollTop) {
      element.scrollTo({ top: scrollTop })
      setPosition({ identity, top: element.scrollTop })
    } else if (position.identity !== identity || resized) {
      setPosition({ identity, top: scrollTop })
    }
  }, [
    columns,
    element,
    headerHeight,
    identity,
    position.identity,
    resized,
    rowHeight,
    scrollTop,
  ])

  return {
    scroller,
    viewportHeight: viewport.height,
    scrollTop,
    columns,
    gap,
    rowHeight,
    headerHeight,
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      const top = event.currentTarget.scrollTop
      setPosition((previous) =>
        previous.identity === identity && previous.top === top
          ? previous
          : { identity, top },
      )
    },
  }
}

/** Server-paged table backed by the same independent page queries as Browse. */
export function useVirtualTable<Page extends VirtualPageData>({
  rowHeight = 32,
  headerHeight = 24,
  pageSize = browsePageSize,
  extraRowHeights,
  presentation,
  viewportKey,
  ...request
}: VirtualTableOptions<Page>) {
  const client = useQueryClient()
  const identity = hashKey(request.queryKey)
  const viewport = useTableViewport(
    viewportKey ? hashKey(viewportKey) : identity,
    rowHeight,
    headerHeight,
    presentation,
  )
  const window = useVirtualPages({
    ...request,
    ...viewport,
    pageSize,
    extraRowHeights:
      !presentation || presentation.view === 'table'
        ? extraRowHeights
        : undefined,
  })
  return {
    ...viewport,
    ...window,
    get loadedSlots() {
      const loaded: { index: number; item: Page['items'][number] }[] = []
      for (const [key, data] of client.getQueriesData<Page>({
        queryKey: request.queryKey,
      })) {
        const page = key.at(-1)
        if (
          typeof page !== 'number' ||
          hashKey(key.slice(0, -1)) !== identity ||
          !data
        )
          continue
        data.items.forEach((item, offset) => {
          const index = (page - 1) * pageSize + offset
          if (index < window.total) loaded.push({ index, item })
        })
      }
      return loaded.sort((a, b) => a.index - b.index)
    },
  }
}

/** Keep page rows available while the independently cached matching count loads. */
export function useCountedVirtualTable<
  Page extends VirtualPageData & { hasMore: boolean },
>({
  countKey,
  loadCount,
  loadPage,
  ...options
}: Omit<VirtualTableOptions<Page>, 'totalCount'> & {
  countKey: readonly unknown[]
  loadCount: (signal: AbortSignal) => Promise<{ totalCount: number }>
}) {
  const count = useQuery({
    queryKey: countKey,
    queryFn: ({ signal }) => loadCount(signal),
    enabled: options.enabled,
    ...clientQueryDefaults,
    retry: false,
  })
  const window = useVirtualTable({
    ...options,
    totalCount: count.data?.totalCount,
    loadPage: async (page, size, signal) => {
      const result = await loadPage(page, size, signal)
      return {
        ...result,
        totalCount:
          page === 1 && !result.hasMore ? result.items.length : undefined,
      }
    },
  })
  const conflict =
    window.conflictingPage === undefined
      ? undefined
      : hashKey([...countKey, count.data?.totalCount])
  const lastConflict = useRef<string>(undefined)
  const refetchCount = count.refetch
  useEffect(() => {
    if (
      options.enabled === false ||
      !conflict ||
      count.isFetching ||
      lastConflict.current === conflict
    )
      return
    lastConflict.current = conflict
    void refetchCount({ cancelRefetch: false })
  }, [options.enabled, conflict, count.isFetching, refetchCount])
  return {
    window,
    isCounting: !window.hasTotal || conflict !== undefined,
    countError:
      !count.isFetching &&
      ((!window.hasTotal && count.isError) ||
        (conflict !== undefined && lastConflict.current === conflict)),
    retryCount: () => void refetchCount({ cancelRefetch: false }),
  }
}

/** Render just the visible rows of a complete, already filtered local dataset. */
export function useVirtualRows<Item>({
  rows,
  identity,
  rowHeight = 32,
  headerHeight = 24,
  extraRowHeights,
  presentation,
}: TableGeometry & { rows: readonly Item[]; identity: string }) {
  const viewport = useTableViewport(
    identity,
    rowHeight,
    headerHeight,
    presentation,
  )
  const total = rows.length
  const window = browseWindow({
    ...viewport,
    total,
    extraRowHeights:
      !presentation || presentation.view === 'table'
        ? extraRowHeights
        : undefined,
  })
  return {
    ...viewport,
    ...window,
    total,
    slots: rows
      .slice(window.start, window.end)
      .map((item, offset) => ({ index: window.start + offset, item })),
  }
}
