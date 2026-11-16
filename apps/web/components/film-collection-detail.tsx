'use client'

import { DetailLink } from './detail-link'
import { useDeferredValue } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Library } from 'lucide-react'
import {
  FilmCollectionDetailSchema,
  FilmCollectionQuerySchema,
  type FilmCollectionSort,
  type FilmCollectionQuery,
} from '@repo/schemas/film-collections'
import { Thumb } from '@repo/ui/components/ds/artwork'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatRuntime,
} from '@repo/ui/lib/format'
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
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { DetailArt, DetailTabs, useDetailTab } from './detail-frame'
import { ProviderSources } from './provider-sources'
import BrowseToolbar, {
  BrowseColumnFilterSection,
  BrowseColumnsSection,
} from './browse-toolbar'
import { useDetailView } from './detail-inspector-context'
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
  align?: 'end'
}> = [
  { key: 'position', label: 'Stored position', align: 'end' },
  { key: 'title', label: 'Film', required: true },
  { key: 'releaseDate', label: 'Released' },
  { key: 'runtimeMinutes', label: 'Runtime', align: 'end' },
  { key: 'watched', label: 'Watched' },
  { key: 'source', label: 'Source', defaultVisible: false },
  { key: 'dateAdded', label: 'Added', defaultVisible: false },
]
const columns = [
  { key: 'artwork', label: 'Artwork', defaultVisible: false },
  ...dataColumns,
]

type CollectionTab = 'overview' | 'sources'
const collectionTabs: readonly [CollectionTab, ...CollectionTab[]] = [
  'overview',
  'sources',
]

function DateValue({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatDate(value)}</time> : EMPTY_VALUE
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
  const { tab, setTab } = useDetailTab(collectionTabs, {
    aliases: { films: 'overview' },
  })
  const showSources = tab === 'sources'
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
      <p className="ds-help">
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
              ? `${formatCount(query.total)} of ${formatCount(query.firstPage.summary.filmCount)} films`
              : `${formatCount(query.total)} films`
            : undefined
        }
      />
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load collection films.
        </Notice>
      )}
      {presentation === 'table' ? (
        <SecondaryTableScroll
          ref={query.scroller}
          onScroll={query.onScroll}
          className="dtl-entries"
          role="region"
          aria-label="Collection films"
          data-inspector-scroll=""
          aria-busy={query.isFetching}
        >
          <table
            className="ds-table"
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
                      align={column.align}
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
                      <TableCell>
                        <Thumb ratio="poster">
                          {row.artworkUrl && (
                            <img
                              className="ds-artimg"
                              src={row.artworkUrl}
                              alt=""
                              loading="lazy"
                            />
                          )}
                        </Thumb>
                      </TableCell>
                    )}
                    {table.visible('position') && (
                      <TableCell align="end" className="ds-muted">
                        {formatCount(row.position)}
                      </TableCell>
                    )}
                    {table.visible('title') && (
                      <TableCell>
                        <SecondaryCell text={row.title}>
                          <DetailLink
                            className="ds-cell-title"
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
                      <TableCell align="end">
                        {formatRuntime(row.runtimeMinutes)}
                      </TableCell>
                    )}
                    {table.visible('watched') && (
                      <TableCell>{row.watched ? 'Yes' : 'No'}</TableCell>
                    )}
                    {table.visible('source') && (
                      <TableCell>
                        <SecondaryCell text={row.source ?? undefined}>
                          {row.source ?? EMPTY_VALUE}
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
                `Position ${formatCount(row.position)}`,
                row.releaseDate?.slice(0, 4),
              ]
                .filter(Boolean)
                .join(' · ')}
              metadata={[
                row.runtimeMinutes === null
                  ? undefined
                  : formatRuntime(row.runtimeMinutes),
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
  if (!summary && (query.isError || sources.isError) && !query.firstPage)
    return (
      <CreatorDetailState
        retry={() => {
          query.retry()
          void sources.refetch()
        }}
        subject="collection"
      />
    )
  return (
    <article className="dtl-detail">
      <DetailHeader
        art={
          <DetailArt
            src={null}
            ratio="poster"
            fallback={<Library className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Collection"
        title={summary?.name ?? 'Collection'}
        facts={[
          summary
            ? `${formatCount(summary.filmCount)} ${summary.filmCount === 1 ? 'film' : 'films'}`
            : null,
        ]}
        actions={
          summary && (
            <>
              <DetailActionsSpacer />
              <DetailMore
                crumb={{ title: summary.name }}
                items={[
                  {
                    label: 'Filter films',
                    href: collectionFilmsHref(summary.name),
                  },
                ]}
              />
            </>
          )
        }
      />
      <DetailTabs
        label="Collection details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <Section title="Films" flush>
            {films}
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={
              sources.data?.sourceLinks.map((link) => ({
                id: `${link.provider}:${link.url}`,
                label: link.providerLabel,
                links: [
                  { provider: link.provider, label: link.name, url: link.url },
                ],
              })) ?? []
            }
            pending={sources.isPending}
            unavailable={
              sources.isError && !sources.data
                ? 'Could not load collection sources.'
                : undefined
            }
            onRetry={
              sources.isError && !sources.data
                ? () => sources.refetch()
                : undefined
            }
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}
