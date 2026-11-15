'use client'

import { useDeferredValue, useEffect, useState, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import type { DetailTarget } from '@/utils/detail-inspector'
import { useDetailInspector, useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

export type CreatorLibraryColumn<Row> = TableColumn & {
  render: (row: Row) => ReactNode
  className?: string
  sortable?: false
  filter?: ReactNode
}

type CreatorLibraryPage<Row> = {
  items: Row[]
  totalCount: number
  page: number
  pageCount: number
}

export function CreatorLibraryTable<Row extends { id: string }>({
  kind,
  queryKey,
  path,
  schema,
  columns,
  label,
  defaultSort,
  workspace = false,
  filters,
}: {
  kind: DetailTarget['kind']
  queryKey: string[]
  path: string
  schema: z.ZodType<CreatorLibraryPage<Row>>
  columns: CreatorLibraryColumn<Row>[]
  label: string
  defaultSort: { key: string; direction: 'asc' | 'desc' }
  workspace?: boolean
  filters?: Record<string, string>
}) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const table = useTableColumns(`creator-library-${kind}`, columns)
  const q = view.params.get('q')?.slice(0, 200) ?? ''
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  const search = useDeferredValue(q.trim())
  const activeSort = view.params.get('sortBy')
  const sortBy =
    columns.find(
      (column) => column.key === activeSort && column.sortable !== false,
    )?.key ?? defaultSort.key
  const paramDirection = view.params.get('direction')
  const direction =
    paramDirection === 'asc' || paramDirection === 'desc'
      ? paramDirection
      : defaultSort.direction
  const params = new URLSearchParams({
    size: '50',
    sortBy,
    direction,
    ...(search ? { q: search } : {}),
    ...filters,
  })
  const query = useInfiniteQuery({
    queryKey: [...queryKey, params.toString()],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      const page = new URLSearchParams(params)
      page.set('page', String(pageParam))
      return fetchApiData(apiBaseUrl, `${path}?${page}`, schema, { signal })
    },
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: query.hasNextPage && !query.isFetching && !query.isError,
    fetchNextPage: query.fetchNextPage,
    resetKey: `${path}?${params}`,
  })
  const inspector = useDetailInspector()
  const selectedId =
    workspace && inspector?.root?.kind === kind ? inspector.root.id : undefined
  const rows = new Map<string, Row>()
  for (const page of query.data?.pages ?? [])
    for (const row of page.items) if (!rows.has(row.id)) rows.set(row.id, row)
  const total = query.data?.pages[0]?.totalCount
  const visible = columns.filter((column) => table.visible(column.key))
  const narrowed = Boolean(search || (filters && Object.keys(filters).length))

  function onSort(key: string) {
    view.params.set('sortBy', key)
    view.params.set(
      'direction',
      sortBy === key && direction === 'asc' ? 'desc' : 'asc',
    )
    view.replace(view.params)
  }

  return (
    <>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label={`Search ${label}`}
            placeholder={`Search ${label}`}
            value={draft}
            maxLength={200}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              if (next) view.params.set('q', next)
              else view.params.delete('q')
              view.replace(view.params)
            }}
          />
        }
        count={
          total === undefined
            ? undefined
            : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`
        }
        columns={table.controls}
      />
      {query.isRefetchError && !query.isFetchNextPageError && rows.size > 0 && (
        <p className="quiet" role="alert">
          Could not refresh {label}. Showing stored results.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      <SecondaryTableScroll
        ref={scroller}
        data-inspector-scroll={!workspace || undefined}
        className={workspace ? 'min-h-0 flex-1' : 'max-h-[min(420px,50dvh)]'}
        role="region"
        aria-label={label}
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label={label}>
          <TableHeader>
            <TableRow>
              {visible.map((column) =>
                column.sortable === false ? (
                  <TableHead key={column.key} className={column.className}>
                    <span className="sr-only">{column.label}</span>
                  </TableHead>
                ) : (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={onSort}
                    className={column.className}
                    filter={column.filter}
                  />
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.size && (
              <TableState colSpan={visible.length} error={query.isError}>
                {query.isPending ? (
                  `Loading ${label}...`
                ) : query.isError ? (
                  <>
                    Could not load {label}.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => query.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : narrowed ? (
                  `No matching ${label}.`
                ) : (
                  `No ${label} stored.`
                )}
              </TableState>
            )}
            {[...rows.values()].map((row) => (
              <TableRow
                key={row.id}
                data-selected={row.id === selectedId || undefined}
              >
                {visible.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </table>
        {(query.hasNextPage || query.isFetchNextPageError) && (
          <div ref={sentinel} className="py-2 text-center">
            {query.isFetchingNextPage ? (
              <p role="status" className="quiet">
                Loading more {label}...
              </p>
            ) : (
              <>
                {query.isFetchNextPageError && (
                  <p role="alert">Could not load more {label}.</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={query.isFetching}
                  onClick={() => query.fetchNextPage({ cancelRefetch: false })}
                >
                  {query.isFetchNextPageError
                    ? `Retry loading ${label}`
                    : `Load more ${label}`}
                </Button>
              </>
            )}
          </div>
        )}
      </SecondaryTableScroll>
    </>
  )
}

export function CreatorLibraryTitle({
  kind,
  id,
  title,
  context,
  action,
}: DetailTarget & { title: string; context?: string; action?: ReactNode }) {
  const text = (
    <SecondaryCell text={context ? `${title} · ${context}` : title}>
      <DetailLink className="table-title hover:underline" kind={kind} id={id}>
        {title}
      </DetailLink>
      {context && <span className="quiet"> · {context}</span>}
    </SecondaryCell>
  )
  return action ? (
    <div className="secondary-cell-actions">
      {action}
      {text}
    </div>
  ) : (
    text
  )
}

export function CreatorLibraryDate({
  value,
  withTime = false,
}: {
  value?: string | null
  withTime?: boolean
}) {
  if (!value) return <>-</>
  return (
    <time dateTime={value}>
      {withTime
        ? new Date(value).toLocaleString()
        : new Date(value).toLocaleDateString(
            undefined,
            value.length === 10 ? { timeZone: 'UTC' } : undefined,
          )}
    </time>
  )
}
