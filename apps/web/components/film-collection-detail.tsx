'use client'

import Link from 'next/link'
import { DetailLink } from './detail-link'
import { useDeferredValue } from 'react'
import {
  FilmCollectionDetailSchema,
  FilmCollectionQuerySchema,
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
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { collectionFilmsHref } from '@/utils/playlist-links'
import ServiceIconLinks from './service-icon-links'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import { useDetailView } from './detail-inspector-context'
import { DetailSourceTabs } from './detail-source-tabs'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
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
  const detail = useDetailView()
  const parsed = FilmCollectionQuerySchema.safeParse(
    Object.fromEntries(detail.params),
  )
  const view = parsed.success
    ? parsed.data
    : FilmCollectionQuerySchema.parse({})
  const { sortBy, direction } = view
  const search = view.q ?? ''
  const q = useDeferredValue(search.trim())
  const watchedStates = view.watchedStates ?? []
  function changeView(patch: Partial<FilmCollectionQuery>) {
    const next = { ...view, ...patch }
    const params = new URLSearchParams(detail.params)
    for (const [key, value] of Object.entries({
      q: next.q ?? '',
      sortBy: next.sortBy,
      direction: next.direction,
      watchedStates: JSON.stringify(next.watchedStates ?? []),
    }))
      params.set(key, value)
    detail.replace(params)
  }
  const table = useTableColumns('film-collection-items', columns)
  const query = useVirtualTable({
    queryKey: ['film-collection', id, sortBy, direction, q, watchedStates],
    rowHeight: 36,
    viewportEnabled: detail.params.get('tab') !== 'sources',
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/collections/${encodeURIComponent(id)}?${new URLSearchParams({ page: String(page), size: String(size), sortBy, direction, ...(q ? { q } : {}), ...(watchedStates.length ? { watchedStates: JSON.stringify(watchedStates) } : {}) })}`,
        FilmCollectionDetailSchema,
        { signal },
      )
      return { ...result.items, summary: result }
    },
  })
  const summary = query.firstPage?.summary
  function onSort(key: FilmCollectionSort) {
    changeView({
      sortBy: key,
      direction: sortBy === key && direction === 'asc' ? 'desc' : 'asc',
    })
  }
  const films = (
    <>
      <p className="quiet text-xs">
        Stored positions are preserved, including gaps. Older imports may not
        contain the source's film order.
      </p>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search collection films"
            placeholder="Search films"
            value={search}
            maxLength={200}
            onChange={(event) => changeView({ q: event.target.value })}
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
      {query.isError && (
        <p role="alert" className="quiet">
          Could not load collection films.{' '}
          <button type="button" className="underline" onClick={query.retry}>
            Retry
          </button>
        </p>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        className="min-h-0 flex-1"
        role="region"
        aria-label="Collection films"
        data-inspector-scroll=""
        aria-busy={query.isFetching}
      >
        <table
          className="compact-table"
          aria-label="Collection films"
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
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
                          onChange={(watchedStates) =>
                            changeView({ watchedStates })
                          }
                        />
                      ) : undefined
                    }
                    className={column.className}
                  />
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={table.count}>
                {q || watchedStates.length
                  ? 'No matching films.'
                  : 'No films in this collection.'}
              </TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={table.count}
              renderRow={(row, index) => (
                <TableRow
                  key={row.id}
                  aria-rowindex={index + 2}
                  style={{ height: query.rowHeight }}
                >
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
                        <DetailLink
                          className="table-title"
                          kind="film"
                          id={row.id}
                        >
                          {row.title}
                        </DetailLink>
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
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </>
  )
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">
          {summary?.name ?? 'Collection'}
        </h1>
      </header>
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
      <DetailSourceTabs
        label="Collection details"
        overviewLabel="Films"
        overviewClassName="flex flex-1 flex-col gap-3"
        sources={{
          rows:
            summary?.sourceLinks.map((link) => ({
              id: `${link.provider}:${link.url}`,
              label: link.providerLabel,
              links: [
                { provider: link.provider, label: link.name, url: link.url },
              ],
            })) ?? [],
          pending: query.isPending,
          unavailable:
            query.isError && !summary
              ? 'Could not load collection sources.'
              : undefined,
          onRetry: query.isError && !summary ? query.retry : undefined,
        }}
      >
        {films}
      </DetailSourceTabs>
    </>
  )
}
