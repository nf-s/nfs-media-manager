'use client'

import Link from 'next/link'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  FilmCollectionDetailSchema,
  type FilmCollectionItem,
  type FilmCollectionSort,
  type FilmCollectionQuery,
} from '@repo/schemas/film-collections'
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
import { collectionFilmsHref } from '@/utils/playlist-links'
import ServiceIconLinks from './service-icon-links'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import { MediaInspector } from './media-inspector'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
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
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const [watchedStates, setWatchedStates] = useState<
    NonNullable<FilmCollectionQuery['watchedStates']>
  >([])
  const table = useTableColumns('film-collection-items', columns)
  const query = useInfiniteQuery({
    queryKey: ['film-collection', id, sortBy, direction, q, watchedStates],
    staleTime: 0,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/collections/${encodeURIComponent(id)}?${new URLSearchParams({ page: String(pageParam), size: '100', sortBy, direction, ...(q ? { q } : {}), ...(watchedStates.length ? { watchedStates: JSON.stringify(watchedStates) } : {}) })}`,
        FilmCollectionDetailSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.items.page < last.items.pageCount ? last.items.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: query.hasNextPage && !query.isFetching && !query.isError,
    fetchNextPage: query.fetchNextPage,
    resetKey: `${id}:${sortBy}:${direction}:${q}:${watchedStates.join(',')}`,
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
      </header>
      <p className="quiet text-xs">
        Stored positions are preserved, including gaps. Older imports may not
        contain the source's film order.
      </p>
      {summary && (
        <div className="form-actions">
          <Button asChild size="sm" variant="outline">
            <Link href={collectionFilmsHref(summary.name)}>Filter films</Link>
          </Button>
          <ServiceIconLinks
            links={summary.sourceLinks.map((link) => ({
              provider: link.provider,
              label: link.providerLabel,
              url: link.url,
            }))}
          />
        </div>
      )}
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search collection films"
            placeholder="Search films"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        count={
          summary
            ? q || watchedStates.length
              ? `${summary.items.totalCount.toLocaleString()} of ${summary.filmCount.toLocaleString()} films`
              : `${summary.filmCount.toLocaleString()} films`
            : undefined
        }
        columns={table.controls}
      />
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
                    filter={
                      column.key === 'watched' ? (
                        <SecondaryColumnFilter
                          label="Watched"
                          options={[
                            { value: 'unwatched', label: 'Unwatched' },
                            { value: 'watched', label: 'Watched' },
                          ]}
                          value={watchedStates}
                          onChange={setWatchedStates}
                        />
                      ) : undefined
                    }
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
                ) : q || watchedStates.length ? (
                  'No matching films.'
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
                      containerClassName="h-7 w-5 rounded"
                      imageClassName="h-7 w-5 object-cover"
                      fallbackClassName="h-7 w-5"
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
                    <SecondaryCell text={row.title}>
                      <Link
                        className="table-title"
                        href={`/films?item=${encodeURIComponent(row.id)}`}
                      >
                        {row.title}
                      </Link>
                    </SecondaryCell>
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
                  <TableCell>
                    <SecondaryCell text={row.source ?? undefined}>
                      {row.source ?? '-'}
                    </SecondaryCell>
                  </TableCell>
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
              {summary?.items.totalCount.toLocaleString()} loaded.
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
      <MediaInspector
        ref={inspector}
        tabIndex={-1}
        aria-label="Collection details"
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
      </MediaInspector>
    </>
  )
}
