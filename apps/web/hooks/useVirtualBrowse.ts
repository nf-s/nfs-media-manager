'use client'

import {
  hashKey,
  QueryObserver,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { z } from 'zod'
import { BrowseCountSchema, BrowsePageSliceSchema } from '@repo/schemas/browse'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import { fetchApiData } from '@/utils/api'
import {
  browsePageSize,
  browseWindow,
  virtualPageOptions,
} from '@/utils/virtual-browse'
import { clientQueryDefaults } from '@/utils/query-cache'
import { isBrowseCounting } from '@/utils/browse-items'
import {
  useBrowsePerformance,
  type BrowsePageTiming,
  type BrowsePerformanceScreen,
} from './useBrowsePerformance'

const DefaultItemSchema = z.union([AlbumListItemSchema, FilmListItemSchema])

type VirtualBrowseOptions = {
  apiBaseUrl: string
  /** Names the library in query keys. */
  collection: string
  /** The API collection when it differs, as for Mixes read from Subscriptions. */
  endpoint?: string
  identity: string
  params: URLSearchParams
  enabled: boolean
  performanceScreen?: BrowsePerformanceScreen
  columns: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  headerHeight: number
  extraRowHeights?: ReadonlyMap<number, number>
}

function useBrowsePages<Item extends z.ZodTypeAny>(
  itemSchema: Item,
  {
    apiBaseUrl,
    collection,
    endpoint = collection,
    identity,
    params,
    enabled,
    performanceScreen,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    extraRowHeights,
  }: VirtualBrowseOptions,
) {
  const PageSchema = BrowsePageSliceSchema(itemSchema)
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction', 'listeningSort', 'page', 'size'])
    countParams.delete(key)
  countParams.sort()
  const countIdentity = countParams.toString()
  const client = useQueryClient()
  const pageKey = [collection, 'browse', identity]
  const countOptions = queryOptions({
    queryKey: [collection, 'browse-count', countIdentity],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${endpoint}/browse-count?${countParams}`,
        BrowseCountSchema,
        { signal, priority: 'low' },
      ),
    ...clientQueryDefaults,
    retry: false,
  })
  async function loadPage(page: number, size: number, signal: AbortSignal) {
    const query = new URLSearchParams(params)
    query.set('page', String(page))
    query.set('size', String(size))
    const requestedAt = performanceScreen ? performance.now() : undefined
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/${endpoint}/browse-page?${query}`,
      PageSchema,
      { signal },
    )
    return {
      ...result,
      pageTiming:
        requestedAt === undefined
          ? undefined
          : { requestedAt, readyAt: performance.now() },
      totalCount:
        page === 1 && !result.hasMore ? result.items.length : undefined,
    }
  }
  const rows = useVirtualPages({
    queryKey: pageKey,
    pageSize: browsePageSize,
    loadPage,
    enabled,
    performanceScreen,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    extraRowHeights,
    totalCount: client.getQueryData(countOptions.queryKey)?.totalCount,
    prioritizeVisible: true,
  })
  const count = useQuery({
    ...countOptions,
    enabled: enabled && rows.visiblePagesSettled,
  })
  const conflict =
    rows.conflictingPage === undefined
      ? undefined
      : JSON.stringify([collection, countIdentity, count.data?.totalCount])
  const lastConflict = useRef<string>(undefined)
  const refetchCount = count.refetch
  useEffect(() => {
    if (
      !enabled ||
      !rows.visiblePagesSettled ||
      !conflict ||
      count.isFetching ||
      lastConflict.current === conflict
    )
      return
    lastConflict.current = conflict
    void refetchCount({ cancelRefetch: false })
  }, [
    enabled,
    rows.visiblePagesSettled,
    conflict,
    count.isFetching,
    refetchCount,
  ])
  return {
    ...rows,
    isCounting: isBrowseCounting({
      hasTotal: rows.hasTotal,
      conflict: conflict !== undefined,
      countSettled: !enabled || count.data !== undefined || count.isError,
    }),
    /** The count without the page's filters, for `12 of 128`. */
    unfilteredTotal: count.data?.unfilteredCount,
    countError:
      !count.isFetching &&
      ((!rows.hasTotal && count.isError) ||
        (conflict !== undefined && lastConflict.current === conflict)),
    retryCount: () => count.refetch({ cancelRefetch: false }),
    resolveTotal: async (index: number) => {
      if (rows.hasTotal && !conflict) return rows.total
      // A playing queue still needs its count if the user leaves Browse.
      const release = new QueryObserver(client, {
        ...countOptions,
        enabled: false,
      }).subscribe(() => undefined)
      try {
        const fresh = await client.fetchQuery(
          conflict ? { ...countOptions, staleTime: 0 } : countOptions,
        )
        if (
          fresh.totalCount <= index ||
          (rows.firstPage?.hasMore &&
            fresh.totalCount <= rows.firstPage.items.length)
        )
          throw new Error('Browse results changed while counting.')
        return fresh.totalCount
      } finally {
        release()
      }
    },
  }
}

export type VirtualPageData = {
  items: readonly unknown[]
  totalCount?: number
  hasMore?: boolean
  pageTiming?: BrowsePageTiming
}

export type VirtualPageOptions<Page extends VirtualPageData> = {
  queryKey: readonly unknown[]
  pageSize: number
  loadPage: (page: number, size: number, signal: AbortSignal) => Promise<Page>
  enabled?: boolean
  performanceScreen?: BrowsePerformanceScreen
  prioritizeVisible?: boolean
  viewportEnabled?: boolean
  totalCount?: number
  refetchInterval?: number | ((page: Page | undefined) => number | false)
}

/** Keep the first-page count available and observe the current window. */
export function useVirtualPages<Page extends VirtualPageData>({
  queryKey,
  pageSize,
  loadPage,
  enabled = true,
  performanceScreen,
  prioritizeVisible = false,
  viewportEnabled = true,
  refetchInterval,
  extraRowHeights,
  totalCount,
  columns,
  rowHeight,
  scrollTop,
  viewportHeight,
  headerHeight,
}: VirtualPageOptions<Page> &
  Pick<
    VirtualBrowseOptions,
    'columns' | 'rowHeight' | 'scrollTop' | 'viewportHeight' | 'headerHeight'
  > & { extraRowHeights?: ReadonlyMap<number, number> }) {
  const client = useQueryClient()
  function options(page: number, pageEnabled = enabled) {
    return {
      ...virtualPageOptions(queryKey, page, (number, signal) =>
        loadPage(number, pageSize, signal),
      ),
      enabled: pageEnabled,
      refetchInterval:
        typeof refetchInterval === 'function'
          ? (query: { state: { data?: Page } }) =>
              refetchInterval(query.state.data)
          : refetchInterval,
    }
  }
  const firstData = client.getQueryData<Page>([...queryKey, 1])
  // A cached count can end inside a page whose response proves more rows exist.
  const lastPage = Math.max(1, Math.ceil((totalCount ?? 0) / pageSize))
  const lastData =
    lastPage === 1
      ? firstData
      : client.getQueryData<Page>([...queryKey, lastPage])
  const lastEnd = (lastPage - 1) * pageSize + (lastData?.items.length ?? 0)
  const outgrewCount =
    totalCount !== undefined &&
    lastData?.hasMore !== undefined &&
    (lastEnd > totalCount || (lastEnd === totalCount && lastData.hasMore))
  const anchorPage = outgrewCount ? lastPage : 1
  const anchor = outgrewCount ? lastData : firstData
  let loadedEnd = (anchorPage - 1) * pageSize + (anchor?.items.length ?? 0)
  let hasMore = anchor?.hasMore === true
  let total = firstData?.totalCount ?? (outgrewCount ? undefined : totalCount)
  if (total === undefined && anchor?.hasMore === false) total = loadedEnd
  // Follow cached pages from the known boundary. The extra slot gives the
  // viewport a way to request the next page before an exact count arrives.
  if (total === undefined && hasMore) {
    for (let page = anchorPage + 1; ; page++) {
      const data = client.getQueryData<Page>([...queryKey, page])
      if (!data) break
      loadedEnd = (page - 1) * pageSize + data.items.length
      hasMore = data.hasMore === true
      if (!hasMore) {
        if (data.hasMore === false) total = loadedEnd
        break
      }
    }
  }
  const reserved = Math.max(1, Math.ceil(viewportHeight / rowHeight)) * columns
  const extent = firstData ? loadedEnd + Number(hasMore) : reserved
  const window = browseWindow({
    total: total ?? extent,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    pageSize,
    extraRowHeights,
  })
  const pageNumbers =
    viewportEnabled && (total !== undefined || hasMore)
      ? window.pages.filter((page) => page !== 1)
      : []
  const visiblePage = Math.floor(window.firstVisibleIndex / pageSize) + 1
  const lastVisiblePage = Math.max(
    visiblePage,
    Math.ceil(window.visibleEnd / pageSize),
  )
  const isVisible = (page: number) =>
    page >= visiblePage && page <= lastVisiblePage
  const needsFirst =
    !prioritizeVisible || totalCount === undefined || isVisible(1)
  const first = useQuery(options(1, enabled && needsFirst))
  // Cached overscan stays renderable. Fetch missing overscan only after the
  // viewport has data, and refresh a cached page when it becomes visible.
  const visibleReady = window.pages.every(
    (page) =>
      !isVisible(page) ||
      client.getQueryData([...queryKey, page]) !== undefined,
  )
  const queries = useQueries({
    queries: pageNumbers.map((page) =>
      options(
        page,
        enabled &&
          (!prioritizeVisible ||
            isVisible(page) ||
            (visibleReady &&
              client.getQueryData([...queryKey, page]) === undefined)),
      ),
    ),
  })
  const pages = new Map([[1, first]])
  pageNumbers.forEach((page, index) => {
    const query = queries[index]
    if (query) pages.set(page, query)
  })
  const conflictingPage = outgrewCount
    ? lastPage
    : total === undefined
      ? undefined
      : pageNumbers.find((page) => {
          const result = pages.get(page)?.data
          if (result?.hasMore === undefined) return false
          const expectedItems = Math.min(
            pageSize,
            total - (page - 1) * pageSize,
          )
          return (
            result.items.length !== expectedItems ||
            result.hasMore !== page * pageSize < total
          )
        })
  const slots: Array<{
    index: number
    item: Page['items'][number] | undefined
  }> = Array.from({ length: window.end - window.start }, (_, offset) => {
    const index = window.start + offset
    const page = pages.get(Math.floor(index / pageSize) + 1)
    const items: Page['items'] | undefined = page?.data?.items
    return { index, item: items?.[index % pageSize] }
  })
  const visible = pages.get(visiblePage)
  const visiblePagesSettled = (
    window.pages.length ? window.pages : [visiblePage]
  ).every((page) => {
    if (!isVisible(page)) return true
    const state = client.getQueryState([...queryKey, page])
    return state?.data !== undefined || state?.status === 'error'
  })
  const visibleSlot = slots[window.firstVisibleIndex - window.start]
  useBrowsePerformance(performanceScreen, {
    identity: performanceScreen ? hashKey(queryKey) : '',
    enabled,
    page: visiblePage,
    scrollTop,
    pageTiming:
      visibleSlot?.item === undefined ? undefined : visible?.data?.pageTiming,
    outcome:
      visibleSlot?.item !== undefined
        ? 'rows'
        : (needsFirst && first.isError) || visible?.isError
          ? 'error'
          : first.data && first.data.items.length === 0 && total === 0
            ? 'empty'
            : undefined,
  })
  const failures = [...pages.entries()]
    .filter(
      ([page, query]) =>
        query.isError &&
        (!prioritizeVisible || isVisible(page) || (page === 1 && needsFirst)),
    )
    .map(([, query]) => query)
  return {
    ...window,
    slots,
    windowPageItems: window.pages.flatMap((page) => {
      const items: Page['items'] | undefined = pages.get(page)?.data?.items
      return items ? [items] : []
    }),
    total: total ?? loadedEnd,
    firstPage: first.data,
    visiblePagesSettled,
    hasTotal: total !== undefined,
    conflictingPage,
    isPending:
      prioritizeVisible && visible ? visible.isPending : first.isPending,
    isError: failures.length > 0,
    isFetching: [...pages.values()].some((query) => query.isFetching),
    retry: () => Promise.all(failures.map((query) => query.refetch())),
  }
}

/** Album and film results unless another item schema is given. */
export function useVirtualBrowse(
  options: VirtualBrowseOptions,
): ReturnType<typeof useBrowsePages<typeof DefaultItemSchema>>
export function useVirtualBrowse<Item extends z.ZodTypeAny>(
  options: VirtualBrowseOptions & { itemSchema: Item },
): ReturnType<typeof useBrowsePages<Item>>
export function useVirtualBrowse(
  options: VirtualBrowseOptions & { itemSchema?: z.ZodTypeAny },
) {
  return useBrowsePages(options.itemSchema ?? DefaultItemSchema, options)
}
