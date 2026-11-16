'use client'

import Link from 'next/link'
import { DetailLink } from './detail-link'
import { useDeferredValue } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { parseBrowseView } from '@/utils/media-grid'
import { clientQueryDefaults } from '@/utils/query-cache'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import BrowseToolbar, {
  BrowseColumnFilterSection,
  BrowseColumnsSection,
} from './browse-toolbar'
import { useDetailView } from './detail-inspector-context'
import { DetailSourceTabs } from './detail-source-tabs'
import {
  NestedMediaCard,
  NestedMediaCards,
  useNestedMediaView,
} from './nested-media-view'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
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
  const showSources = detail.params.get('tab') === 'sources'
  const [savedPresentation, setPresentation] =
    useNestedMediaView('collection-films')
  const presentation = parseBrowseView(
    detail.params.get('view'),
    savedPresentation,
  )
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
  const path = `/api/v1/collections/${encodeURIComponent(id)}`
  const sources = useQuery({
    queryKey: ['film-collection', id, 'sources'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${path}?size=1&includeSources=true`,
        FilmCollectionDetailSchema,
        { signal },
      ),
    enabled: showSources,
    ...clientQueryDefaults,
    retry: false,
  })
  const query = useVirtualTable({
    queryKey: ['film-collection', id, sortBy, direction, q, watchedStates],
    rowHeight: 36,
    presentation: { view: presentation, mediaType: 'film' },
    enabled: !showSources,
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        `${path}?${new URLSearchParams({ page: String(page), size: String(size), sortBy, direction, includeSources: 'false', ...(q ? { q } : {}), ...(watchedStates.length ? { watchedStates: JSON.stringify(watchedStates) } : {}) })}`,
        FilmCollectionDetailSchema,
        { signal },
      )
      return { ...result.items, summary: result }
    },
  })
  const summary = query.firstPage?.summary ?? sources.data
  function onSort(key: FilmCollectionSort) {
    changeView({
      sortBy: key,
      direction: sortBy === key && direction === 'asc' ? 'desc' : 'asc',
    })
  }
  const watchedFilter = {
    label: 'Watched',
    options: [
      { value: 'unwatched', label: 'Unwatched' },
      { value: 'watched', label: 'Watched' },
    ] satisfies {
      value: (typeof watchedStates)[number]
      label: string
    }[],
    value: watchedStates,
    onChange: (watchedStates: FilmCollectionQuery['watchedStates']) =>
      changeView({ watchedStates }),
  }
  const empty =
    query.hasTotal && query.total === 0
      ? q || watchedStates.length
        ? 'No matching films.'
        : 'No films in this collection.'
      : undefined
  const films = (
    <>
      <p className="quiet text-xs">
        Stored positions are preserved, including gaps. Older imports may not
        contain the source's film order.
      </p>
      <BrowseToolbar
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
        sort={{
          key: sortBy,
          direction,
          options: dataColumns,
          onChange: (sortBy) => changeView({ sortBy, direction: 'asc' }),
          onDirectionChange: (direction) => changeView({ direction }),
        }}
        view={presentation}
        onViewChange={(next) => {
          setPresentation(next)
          const params = new URLSearchParams(detail.params)
          params.set('view', next)
          detail.replace(params)
        }}
        filterCount={watchedStates.length}
        filters={
          <>
            <BrowseColumnFilterSection {...watchedFilter} />
            {presentation === 'table' && (
              <BrowseColumnsSection>{table.options}</BrowseColumnsSection>
            )}
          </>
        }
        count={
          query.firstPage
            ? q || watchedStates.length
              ? `${query.total.toLocaleString()} of ${query.firstPage.summary.filmCount.toLocaleString()} films`
              : `${query.total.toLocaleString()} films`
            : undefined
        }
      />
      {query.isError && (
        <p role="alert" className="quiet">
          Could not load collection films.{' '}
          <button type="button" className="underline" onClick={query.retry}>
            Retry
          </button>
        </p>
      )}
      {presentation === 'table' ? (
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
                          <SecondaryColumnFilter {...watchedFilter} />
                        ) : undefined
                      }
                      className={column.className}
                    />
                  ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {empty && <TableState colSpan={table.count}>{empty}</TableState>}
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
      ) : (
        <NestedMediaCards
          window={query}
          view={presentation}
          mediaType="film"
          label="Collection films"
          empty={empty}
          busy={query.isFetching}
          renderItem={(row) => (
            <NestedMediaCard
              view={presentation}
              kind="film"
              id={row.id}
              title={row.title}
              artworkUrl={row.artworkUrl}
              subtitle={[
                `Position ${row.position.toLocaleString()}`,
                row.releaseDate?.slice(0, 4),
              ]
                .filter(Boolean)
                .join(' · ')}
              metadata={[
                row.runtimeMinutes === null
                  ? undefined
                  : `${row.runtimeMinutes.toLocaleString()} min`,
                row.watched ? 'Watched' : 'Unwatched',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          )}
        />
      )}
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
        </div>
      )}
      <DetailSourceTabs
        label="Collection details"
        overviewLabel="Films"
        overviewClassName="flex flex-1 flex-col gap-3"
        sources={{
          rows:
            sources.data?.sourceLinks.map((link) => ({
              id: `${link.provider}:${link.url}`,
              label: link.providerLabel,
              links: [
                { provider: link.provider, label: link.name, url: link.url },
              ],
            })) ?? [],
          pending: sources.isPending,
          unavailable:
            sources.isError && !sources.data
              ? 'Could not load collection sources.'
              : undefined,
          onRetry:
            sources.isError && !sources.data
              ? () => sources.refetch()
              : undefined,
        }}
      >
        {films}
      </DetailSourceTabs>
    </>
  )
}
