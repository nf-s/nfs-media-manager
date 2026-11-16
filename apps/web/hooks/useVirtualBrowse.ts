'use client'

import {
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

const DefaultItemSchema = z.union([AlbumListItemSchema, FilmListItemSchema])

type VirtualBrowseOptions = {
  apiBaseUrl: string
  collection: string
  identity: string
  params: URLSearchParams
  enabled: boolean
  columns: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  headerHeight: number
}

function useBrowsePages<Item extends z.ZodTypeAny>(
  itemSchema: Item,
  {
    apiBaseUrl,
    collection,
    identity,
    params,
    enabled,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
  }: VirtualBrowseOptions,
) {
  const PageSchema = BrowsePageSliceSchema(itemSchema)
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction', 'listeningSort', 'page', 'size'])
    countParams.delete(key)
  countParams.sort()
  const countIdentity = countParams.toString()
  const client = useQueryClient()
  const countOptions = queryOptions({
    queryKey: [collection, 'browse-count', countIdentity],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/browse-count?${countParams}`,
        BrowseCountSchema,
        { signal },
      ),
    ...clientQueryDefaults,
    retry: false,
  })
  const count = useQuery({ ...countOptions, enabled })
  async function loadPage(page: number, size: number, signal: AbortSignal) {
    const query = new URLSearchParams(params)
    query.set('page', String(page))
    query.set('size', String(size))
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/${collection}/browse-page?${query}`,
      PageSchema,
      { signal },
    )
    return {
      ...result,
      totalCount:
        page === 1 && !result.hasMore ? result.items.length : undefined,
    }
  }
  const rows = useVirtualPages({
    queryKey: [collection, 'browse', identity],
    pageSize: browsePageSize,
    loadPage,
    enabled,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    totalCount: count.data?.totalCount,
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
      !conflict ||
      count.isFetching ||
      lastConflict.current === conflict
    )
      return
    lastConflict.current = conflict
    void refetchCount({ cancelRefetch: false })
  }, [enabled, conflict, count.isFetching, refetchCount])
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
    retryCount: () => void count.refetch({ cancelRefetch: false }),
    resolveTotal: async (index: number) => {
      if (rows.hasTotal && !conflict) return rows.total
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
    },
  }
}

export type VirtualPageData = {
  items: readonly unknown[]
  totalCount?: number
  hasMore?: boolean
}

export type VirtualPageOptions<Page extends VirtualPageData> = {
  queryKey: readonly unknown[]
  pageSize: number
  loadPage: (page: number, size: number, signal: AbortSignal) => Promise<Page>
  enabled?: boolean
  viewportEnabled?: boolean
  totalCount?: number
  refetchInterval?: number | ((page: Page | undefined) => number | false)
}

/** Mount page one for its count and just the pages intersecting the viewport. */
export function useVirtualPages<Page extends VirtualPageData>({
  queryKey,
  pageSize,
  loadPage,
  enabled = true,
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
  function options(page: number) {
    return {
      ...virtualPageOptions(queryKey, page, (number, signal) =>
        loadPage(number, pageSize, signal),
      ),
      enabled,
      refetchInterval:
        typeof refetchInterval === 'function'
          ? (query: { state: { data?: Page } }) =>
              refetchInterval(query.state.data)
          : refetchInterval,
    }
  }
  const first = useQuery({
    ...options(1),
  })
  const loadedCount = first.data?.items.length ?? 0
  const firstConflict =
    first.data?.hasMore === true &&
    totalCount !== undefined &&
    totalCount <= loadedCount
  const total =
    first.data?.totalCount ?? (firstConflict ? undefined : totalCount)
  const reserved = Math.max(1, Math.ceil(viewportHeight / rowHeight)) * columns
  const window = browseWindow({
    total: total ?? Math.max(loadedCount, reserved),
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    pageSize,
    extraRowHeights: total === undefined ? undefined : extraRowHeights,
  })
  const pageNumbers =
    total === undefined || !viewportEnabled
      ? []
      : window.pages.filter((page) => page !== 1)
  const queries = useQueries({
    queries: pageNumbers.map(options),
  })
  const pages = new Map([[1, first]])
  pageNumbers.forEach((page, index) => {
    const query = queries[index]
    if (query) pages.set(page, query)
  })
  const conflictingPage = firstConflict
    ? 1
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
  const failures = [...pages.values()].filter((query) => query.isError)
  return {
    ...window,
    slots,
    total: total ?? loadedCount,
    firstPage: first.data,
    hasTotal: total !== undefined,
    conflictingPage,
    isPending: first.isPending,
    isError: failures.length > 0,
    isFetching: [...pages.values()].some((query) => query.isFetching),
    retry: () => {
      for (const query of failures) void query.refetch()
    },
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
