'use client'

import { useQueryClient, hashKey } from '@tanstack/react-query'
import { useLayoutEffect, useState, type UIEvent } from 'react'
import { browsePageSize, browseWindow } from '@/utils/virtual-browse'
import {
  useVirtualPages,
  type VirtualPageData,
  type VirtualPageOptions,
} from './useVirtualBrowse'

type TableGeometry = {
  rowHeight?: number
  headerHeight?: number
  extraRowHeights?: ReadonlyMap<number, number>
}

function useTableViewport(identity: string) {
  const [element, scroller] = useState<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(420)
  const [position, setPosition] = useState({ identity, top: 0 })
  useLayoutEffect(() => {
    if (!element) return
    function measure() {
      if (element?.clientHeight) setViewportHeight(element.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  useLayoutEffect(() => {
    element?.scrollTo({ top: 0 })
    setPosition((previous) =>
      previous.identity === identity && previous.top === 0
        ? previous
        : { identity, top: 0 },
    )
  }, [element, identity])

  return {
    scroller,
    viewportHeight,
    scrollTop: position.identity === identity ? position.top : 0,
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
  ...request
}: Omit<VirtualPageOptions<Page>, 'pageSize'> &
  TableGeometry & { pageSize?: number }) {
  const client = useQueryClient()
  const identity = hashKey(request.queryKey)
  const viewport = useTableViewport(identity)
  const window = useVirtualPages({
    ...request,
    ...viewport,
    pageSize,
    columns: 1,
    rowHeight,
    headerHeight,
    extraRowHeights,
  })
  return {
    ...viewport,
    ...window,
    rowHeight,
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

/** Render just the visible rows of a complete, already filtered local dataset. */
export function useVirtualRows<Item>({
  rows,
  identity,
  rowHeight = 32,
  headerHeight = 24,
  extraRowHeights,
}: TableGeometry & { rows: readonly Item[]; identity: string }) {
  const viewport = useTableViewport(identity)
  const total = rows.length
  const window = browseWindow({
    ...viewport,
    columns: 1,
    total,
    rowHeight,
    headerHeight,
    extraRowHeights,
  })
  return {
    ...viewport,
    ...window,
    total,
    rowHeight,
    slots: rows
      .slice(window.start, window.end)
      .map((item, offset) => ({ index: window.start + offset, item })),
  }
}
