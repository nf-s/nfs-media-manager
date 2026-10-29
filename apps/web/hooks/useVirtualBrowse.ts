'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import { fetchApiData } from '@/utils/api'
import {
  browsePageOptions,
  browsePageSize,
  browseWindow,
} from '@/utils/virtual-browse'

const PageSchema = PaginatedDataSchema(
  z.union([AlbumListItemSchema, FilmListItemSchema]),
)

export function useVirtualBrowse({
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
}: {
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
}) {
  function load(page: number, signal: AbortSignal) {
    const query = new URLSearchParams(params)
    query.set('page', String(page))
    query.set('size', String(browsePageSize))
    return fetchApiData(
      apiBaseUrl,
      `/api/v1/${collection}?${query}`,
      PageSchema,
      { signal },
    )
  }
  // Keep the first page mounted for the total, even when browsing distant pages.
  const first = useQuery({
    ...browsePageOptions(collection, identity, 1, load),
    enabled,
  })
  const total = first.data?.totalCount ?? 0
  const window = browseWindow({
    total,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
  })
  const pageNumbers = window.pages.filter((page) => page !== 1)
  const queries = useQueries({
    queries: pageNumbers.map((page) => ({
      ...browsePageOptions(collection, identity, page, load),
      enabled,
    })),
  })
  const pages = new Map([[1, first]])
  pageNumbers.forEach((page, index) => {
    const query = queries[index]
    if (query) pages.set(page, query)
  })
  const slots = Array.from(
    { length: window.end - window.start },
    (_, offset) => {
      const index = window.start + offset
      const page = pages.get(Math.floor(index / browsePageSize) + 1)
      return { index, item: page?.data?.items[index % browsePageSize] }
    },
  )
  const failures = [...pages.values()].filter((query) => query.isError)
  return {
    ...window,
    slots,
    total,
    isPending: first.isPending,
    isError: failures.length > 0,
    isFetching: [...pages.values()].some((query) => query.isFetching),
    retry: () => {
      for (const query of failures) void query.refetch()
    },
  }
}
