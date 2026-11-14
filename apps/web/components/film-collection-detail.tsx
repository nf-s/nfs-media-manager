'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  FilmCollectionDetailSchema,
  type FilmCollectionItem,
  type FilmCollectionSort,
} from '@repo/schemas/film-collections'
import { Button } from '@repo/ui/components/ui/button'
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
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  useTableColumns,
} from './secondary-table'

const dataColumns: Array<{
  key: FilmCollectionSort
  label: string
  defaultVisible?: boolean
  required?: boolean
  className?: string
}> = [
  { key: 'position', label: 'Stored position', className: 'numeric' },
  { key: 'title', label: 'Film', required: true },
  { key: 'releaseDate', label: 'Released' },
  { key: 'runtimeMinutes', label: 'Runtime', className: 'numeric' },
  { key: 'watched', label: 'Watched' },
  { key: 'source', label: 'Source', defaultVisible: false },
  { key: 'dateAdded', label: 'Added', defaultVisible: false },
]
const columns = [
  { key: 'artwork', label: 'Artwork', defaultVisible: false },
  ...dataColumns,
]

function DateValue({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleDateString()}</time>
  ) : (
    <>-</>
  )
}

export function FilmCollectionEntries({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const [sortBy, setSortBy] = useState<FilmCollectionSort>('position')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const table = useTableColumns('film-collection-items', columns)
  const query = useInfiniteQuery({
    queryKey: ['film-collection', id, sortBy, direction],
    staleTime: 0,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/collections/${encodeURIComponent(id)}?${new URLSearchParams({ page: String(pageParam), size: '100', sortBy, direction })}`,
        FilmCollectionDetailSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.items.page < last.items.pageCount ? last.items.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: query.hasNextPage && !query.isFetching && !query.isError,
    fetchNextPage: query.fetchNextPage,
    resetKey: `${id}:${sortBy}:${direction}`,
  })
  const byId = new Map<string, FilmCollectionItem>()
  for (const page of query.data?.pages ?? [])
    for (const row of page.items.items)
      if (!byId.has(row.id)) byId.set(row.id, row)
  const rows = [...byId.values()]
  const summary = query.data?.pages[0]
  function onSort(key: FilmCollectionSort) {
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
    setSortBy(key)
  }
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">
          {summary?.name ?? 'Collection'}
        </h1>
        {summary && (
          <span className="quiet text-xs">
            {summary.filmCount.toLocaleString()} films in library
          </span>
        )}
        {table.controls}
      </header>
      <p className="quiet text-xs">
        Stored positions are preserved, including gaps. Older imports may not
        contain the source's film order.
      </p>
      <SecondaryTableScroll
        ref={scroller}
        className="min-h-0 flex-1"
        role="region"
        aria-label="Collection films"
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label="Collection films">
          <TableHeader>
            <TableRow>
              {table.visible('artwork') && (
                <TableHead>
                  <span className="sr-only">Artwork</span>
                </TableHead>
              )}
              {dataColumns
                .filter((column) => table.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={onSort}
                    className={column.className}
                  />
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.length && (
              <TableState colSpan={table.count} error={query.isError}>
                {query.isPending ? (
                  'Loading collection...'
                ) : query.isError ? (
                  <>
                    Could not load this collection.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => query.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  'No films in this collection.'
                )}
              </TableState>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                {table.visible('artwork') && (
                  <TableCell className="w-10">
                    <MediaArtwork
                      src={row.artworkUrl}
                      alt=""
                      fallbackLabel=""
                      containerClassName="h-9 w-6 rounded"
                      imageClassName="h-9 w-6 object-cover"
                      fallbackClassName="h-9 w-6"
                    />
                  </TableCell>
                )}
                {table.visible('position') && (
                  <TableCell className="numeric">
                    {row.position.toLocaleString()}
                  </TableCell>
                )}
                {table.visible('title') && (
                  <TableCell>
                    <Link
                      className="table-title"
                      href={`/films?item=${encodeURIComponent(row.id)}`}
                    >
                      {row.title}
                    </Link>
                  </TableCell>
                )}
                {table.visible('releaseDate') && (
                  <TableCell className="whitespace-nowrap">
                    <DateValue value={row.releaseDate} />
                  </TableCell>
                )}
                {table.visible('runtimeMinutes') && (
                  <TableCell className="numeric">
                    {row.runtimeMinutes === null
                      ? '-'
                      : `${row.runtimeMinutes.toLocaleString()} min`}
                  </TableCell>
                )}
                {table.visible('watched') && (
                  <TableCell>{row.watched ? 'Yes' : 'No'}</TableCell>
                )}
                {table.visible('source') && (
                  <TableCell>{row.source ?? '-'}</TableCell>
                )}
                {table.visible('dateAdded') && (
                  <TableCell className="whitespace-nowrap">
                    <DateValue value={row.dateAdded} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {query.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more films...
            </p>
          )}
          {query.isFetchNextPageError && (
            <p role="alert">Could not load more films.</p>
          )}
          {query.hasNextPage && !query.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={query.isFetching}
              onClick={() => query.fetchNextPage({ cancelRefetch: false })}
            >
              {query.isFetchNextPageError
                ? 'Retry loading films'
                : 'Load more films'}
            </Button>
          )}
          {!query.hasNextPage && rows.length > 0 && (
            <p className="muted">
              {rows.length.toLocaleString()} of{' '}
              {summary?.filmCount.toLocaleString()} loaded.
            </p>
          )}
        </div>
      </SecondaryTableScroll>
    </>
  )
}

export default function FilmCollectionDrawer({
  id,
  onClose,
}: {
  id: string
  onClose: () => void
}) {
  const inspector = useRef<HTMLElement>(null)
  useEffect(() => {
    inspector.current?.focus({ preventScroll: true })
  }, [id])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  return (
    <>
      <div className="inspector-backdrop" onClick={onClose} />
      <aside
        ref={inspector}
        tabIndex={-1}
        aria-label="Collection details"
        className="media-inspector"
      >
        <div className="detail-topbar">
          <span>Collection</span>
          <button type="button" aria-label="Close details" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3.5 pb-3.5 pt-3">
          <FilmCollectionEntries key={id} id={id} />
        </div>
      </aside>
    </>
  )
}
