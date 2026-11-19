'use client'

import { DetailLink } from './detail-link'
import { useDeferredValue } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Library } from 'lucide-react'
import {
  AlbumCollectionDetailSchema,
  AlbumCollectionQuerySchema,
  type AlbumCollectionDetail,
  type AlbumCollectionSort,
} from '@repo/schemas/album-collections'
import {
  FilmCollectionDetailSchema,
  FilmCollectionQuerySchema,
  type FilmCollectionDetail,
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
  formatItemCount,
  formatRuntime,
  formatTrackLength,
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
import { useNestedGridDensity } from '@/hooks/useGridDensity'
import { collectionItemsHref } from '@/utils/playlist-links'
import type { MediaScope } from '@/utils/media-scope'
import { defaultBrowseView, parseBrowseView } from '@/utils/media-grid'
import { clientQueryDefaults } from '@/utils/query-cache'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import {
  DetailArt,
  DetailTabs,
  OpenAtProvider,
  useDetailTab,
} from './detail-frame'
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

type CollectionDetail = AlbumCollectionDetail | FilmCollectionDetail
type CollectionSort = AlbumCollectionSort | FilmCollectionSort
type CollectionView = {
  q?: string
  sortBy: CollectionSort
  direction: 'asc' | 'desc'
  watchedStates?: FilmCollectionQuery['watchedStates']
}

type CollectionColumn = {
  key: CollectionSort
  label: string
  width: number
  defaultVisible?: boolean
  required?: boolean
  align?: 'end'
  fill?: boolean
}

/** Room for the artwork thumbnail. */
const ARTWORK_WIDTH = 48

const sharedColumns: CollectionColumn[] = [
  { key: 'source', label: 'Source', width: 140, defaultVisible: false },
  { key: 'dateAdded', label: 'Added', width: 100, defaultVisible: false },
]
const filmColumns: CollectionColumn[] = [
  { key: 'position', label: 'Stored position', width: 60, align: 'end' },
  { key: 'title', label: 'Film', width: 210, required: true, fill: true },
  { key: 'releaseDate', label: 'Released', width: 100 },
  { key: 'runtimeMinutes', label: 'Runtime', width: 80, align: 'end' },
  { key: 'watched', label: 'Watched', width: 100 },
  ...sharedColumns,
]
const albumColumns: CollectionColumn[] = [
  { key: 'position', label: 'Stored position', width: 60, align: 'end' },
  { key: 'title', label: 'Album', width: 180, required: true, fill: true },
  { key: 'artists', label: 'Artists', width: 140 },
  { key: 'releaseDate', label: 'Released', width: 100 },
  { key: 'durationSec', label: 'Duration', width: 80, align: 'end' },
  ...sharedColumns,
]

type CollectionTab = 'overview' | 'sources'
const collectionTabs: readonly [CollectionTab, ...CollectionTab[]] = [
  'overview',
  'sources',
]

function DateValue({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatDate(value)}</time> : EMPTY_VALUE
}

function collectionCount(collection: CollectionDetail) {
  return 'albumCount' in collection
    ? collection.albumCount
    : collection.filmCount
}

function albumDuration(durationSec: number | null) {
  return formatTrackLength(durationSec === null ? null : durationSec * 1000)
}

export function CollectionEntries({
  id,
  mediaType,
}: {
  id: string
  mediaType: MediaScope
}) {
  const { apiBaseUrl } = useConfig()
  const detail = useDetailView()
  const album = mediaType === 'album'
  const members = `${mediaType}s`
  const label = album ? 'Albums' : 'Films'
  const countNoun = { one: mediaType, other: members }
  const ratio = album ? undefined : 'poster'
  const dataColumns = album ? albumColumns : filmColumns
  const columns = [
    { key: 'artwork', label: 'Artwork', defaultVisible: false },
    ...dataColumns,
  ]
  const querySchema = album
    ? AlbumCollectionQuerySchema
    : FilmCollectionQuerySchema
  const parsed = querySchema.safeParse(Object.fromEntries(detail.params))
  const view: CollectionView = parsed.success
    ? parsed.data
    : querySchema.parse({})
  const { sortBy, direction } = view
  const search = view.q ?? ''
  const q = useDeferredValue(search.trim())
  const watchedStates = view.watchedStates ?? []
  const { tab, setTab } = useDetailTab(collectionTabs, {
    aliases: { albums: 'overview', films: 'overview' },
  })
  const showSources = tab === 'sources'
  const [savedPresentation, setPresentation] = useNestedMediaView(
    `collection-${members}`,
    defaultBrowseView(mediaType),
  )
  const presentation = parseBrowseView(
    detail.params.get('view'),
    savedPresentation,
  )
  const [density, setDensity] = useNestedGridDensity(
    mediaType,
    detail.params.get('density'),
  )
  function changeView(patch: Partial<CollectionView>) {
    const next = { ...view, ...patch }
    const params = new URLSearchParams(detail.params)
    for (const [key, value] of Object.entries({
      q: next.q ?? '',
      sortBy: next.sortBy,
      direction: next.direction,
      ...(!album
        ? { watchedStates: JSON.stringify(next.watchedStates ?? []) }
        : {}),
    }))
      params.set(key, value)
    detail.replace(params)
  }
  const table = useTableColumns(`${mediaType}-collection-items`, columns)
  const shownColumns = dataColumns.filter((column) => table.visible(column.key))
  const layout = table.layout([
    ...(table.visible('artwork') ? [ARTWORK_WIDTH] : []),
    ...shownColumns.map((column) => column.key),
  ])
  const path = `/api/v1/${album ? 'album-collections' : 'collections'}/${encodeURIComponent(id)}`
  const schema = album
    ? AlbumCollectionDetailSchema
    : FilmCollectionDetailSchema
  const queryKey = [`${mediaType}-collection`, id]
  const sources = useQuery({
    queryKey: [...queryKey, 'sources'],
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, `${path}?size=1&includeSources=true`, schema, {
        signal,
      }),
    ...clientQueryDefaults,
    retry: false,
  })
  const query = useVirtualTable({
    queryKey: [...queryKey, sortBy, direction, q, watchedStates],
    rowHeight: 36,
    presentation: { view: presentation, mediaType, density },
    enabled: !showSources,
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        `${path}?${new URLSearchParams({ page: String(page), size: String(size), sortBy, direction, includeSources: 'false', ...(q ? { q } : {}), ...(watchedStates.length ? { watchedStates: JSON.stringify(watchedStates) } : {}) })}`,
        schema,
        { signal },
      )
      return { ...result.items, summary: result }
    },
  })
  const summary = query.firstPage?.summary ?? sources.data
  const sourceLinks = sources.data?.sourceLinks ?? []
  const sourceLabels = new Map<string, number>()
  for (const { providerLabel } of sourceLinks)
    sourceLabels.set(providerLabel, (sourceLabels.get(providerLabel) ?? 0) + 1)
  const seenLabels = new Map<string, number>()
  const destinations = sourceLinks.map((link) => {
    const { providerLabel } = link
    const position = (seenLabels.get(providerLabel) ?? 0) + 1
    seenLabels.set(providerLabel, position)
    const label =
      (sourceLabels.get(providerLabel) ?? 0) > 1
        ? `${providerLabel} (${position})`
        : providerLabel
    return { ...link, label }
  })
  function onSort(key: CollectionSort) {
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
        ? `No matching ${members}.`
        : `No ${members} in this collection.`
      : undefined
  const collectionItems = (
    <>
      {!album && (
        <p className="ds-help">
          Stored positions are preserved, including gaps. Older imports may not
          contain the source's film order.
        </p>
      )}
      <BrowseToolbar
        search={
          <Input
            type="search"
            aria-label={`Search collection ${members}`}
            placeholder={`Search ${members}`}
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
        density={{
          value: density,
          onChange: (next) => {
            setDensity(next)
            const params = new URLSearchParams(detail.params)
            params.set('density', next)
            detail.replace(params)
          },
        }}
        filterCount={watchedStates.length}
        filters={
          !album || presentation === 'table' ? (
            <>
              {!album && <BrowseColumnFilterSection {...watchedFilter} />}
              {presentation === 'table' && (
                <BrowseColumnsSection>{table.options}</BrowseColumnsSection>
              )}
            </>
          ) : undefined
        }
        count={
          query.firstPage
            ? formatItemCount(
                query.total,
                countNoun,
                q || watchedStates.length
                  ? collectionCount(query.firstPage.summary)
                  : undefined,
              )
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
          Could not load collection {members}.
        </Notice>
      )}
      {presentation === 'table' ? (
        <SecondaryTableScroll
          ref={query.scroller}
          onScroll={query.onScroll}
          className="dtl-entries"
          role="region"
          aria-label={`Collection ${members}`}
          data-inspector-scroll=""
          aria-busy={query.isFetching}
        >
          <table
            className="ds-table"
            aria-label={`Collection ${members}`}
            aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                {table.visible('artwork') && (
                  <TableHead>
                    <span className="sr-only">Artwork</span>
                  </TableHead>
                )}
                {shownColumns.map((column) => (
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
                    resizer={table.resizer(column.key)}
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
                        <Thumb ratio={ratio}>
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
                            kind={mediaType}
                            id={row.id}
                          >
                            {row.title}
                          </DetailLink>
                        </SecondaryCell>
                      </TableCell>
                    )}
                    {'artists' in row && table.visible('artists') && (
                      <TableCell>
                        <SecondaryCell text={row.artists.join(', ')}>
                          {row.artists.join(', ') || EMPTY_VALUE}
                        </SecondaryCell>
                      </TableCell>
                    )}
                    {table.visible('releaseDate') && (
                      <TableCell className="whitespace-nowrap">
                        <DateValue value={row.releaseDate} />
                      </TableCell>
                    )}
                    {'durationSec' in row && table.visible('durationSec') && (
                      <TableCell align="end">
                        {albumDuration(row.durationSec)}
                      </TableCell>
                    )}
                    {'runtimeMinutes' in row &&
                      table.visible('runtimeMinutes') && (
                        <TableCell align="end">
                          {formatRuntime(row.runtimeMinutes)}
                        </TableCell>
                      )}
                    {'watched' in row && table.visible('watched') && (
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
          mediaType={mediaType}
          label={`Collection ${members}`}
          empty={empty}
          busy={query.isFetching}
          renderItem={(row) => (
            <NestedMediaCard
              view={presentation}
              kind={mediaType}
              id={row.id}
              title={row.title}
              artworkUrl={row.artworkUrl}
              subtitle={[
                'artists' in row ? row.artists.join(', ') : undefined,
                `Position ${formatCount(row.position)}`,
                row.releaseDate?.slice(0, 4),
              ]
                .filter(Boolean)
                .join(' · ')}
              metadata={
                'artists' in row
                  ? row.durationSec === null
                    ? undefined
                    : albumDuration(row.durationSec)
                  : [
                      row.runtimeMinutes === null
                        ? undefined
                        : formatRuntime(row.runtimeMinutes),
                      row.watched ? 'Watched' : 'Unwatched',
                    ]
                      .filter(Boolean)
                      .join(' · ')
              }
            />
          )}
        />
      )}
    </>
  )
  if (!summary && (showSources ? sources.isError : query.isError))
    return (
      <CreatorDetailState
        retry={() => {
          if (showSources) void sources.refetch()
          else query.retry()
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
            ratio={ratio}
            fallback={<Library className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Collection"
        title={summary?.name ?? 'Collection'}
        facts={[
          summary ? formatItemCount(collectionCount(summary), countNoun) : null,
        ]}
        actions={
          summary && (
            <>
              <DetailActionsSpacer />
              {destinations.map(({ provider, url, label }) => (
                <OpenAtProvider
                  key={`${provider}:${url}`}
                  label={label}
                  actionLabel={`Open on ${label}`}
                  url={url}
                />
              ))}
              <DetailMore
                crumb={{ title: summary.name }}
                items={[
                  {
                    label: `Filter ${members}`,
                    href: collectionItemsHref(mediaType, summary.name),
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
          {sources.isError && !sources.data && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => sources.refetch()}>
                  Retry
                </Button>
              }
            >
              Could not load collection sources.
            </Notice>
          )}
          <Section title={label} flush>
            {collectionItems}
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={destinations.map((link) => ({
              id: `${link.provider}:${link.url}`,
              label: link.label,
              links: [
                { provider: link.provider, label: link.name, url: link.url },
              ],
            }))}
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
