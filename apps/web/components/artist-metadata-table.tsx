'use client'

import { ResultSection } from './result-feedback'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ArtistEnrichmentResultSchema,
  ArtistProfileProviderSchema,
  QueueArtistSelectionSchema,
  type QueueArtistSelection,
} from '@repo/schemas/artist-profiles'
import {
  ArtistSelectionSnapshotSchema,
  ArtistSelectionSnapshotPageSchema,
  type ArtistSelectionSnapshot,
} from '@repo/schemas/artist-selection'
import {
  ArtistMetadataItemSchema,
  type ArtistProviderMetadata,
} from '@repo/schemas/creators'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import { BrowseCountSchema, BrowsePageSliceSchema } from '@repo/schemas/browse'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import {
  queueReceipt,
  submissionFeedback,
  useJobBatchFeedback,
} from './job-button-feedback'
import {
  TableCell,
  TableHead,
  TableRow,
  TableSelectionBar,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { fetchApiData } from '@/utils/api'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { withArtistFilter } from '@/utils/artist-browse'
import { browseFilterHref, browseSearchHref } from '@/utils/browse-items'
import { embeddedBrowseHref } from '@/utils/embedded-browse'
import {
  artistProviderLabel,
  supportsArtistEnrichment,
} from '@/utils/artist-providers'
import {
  artistMetadataQuery,
  dispatchArtistSelection,
  dispatchArtistSnapshot,
} from '@/utils/artist-selection'
import { updateJobSelection } from '@/utils/job-selection'
import {
  listeningScrobblesField,
  listeningScrobblesKey,
} from '@/utils/listening-filters'
import { useArtistPlaylistFilter } from './artist-playlist-filter'
import {
  CreatorLibraryDate,
  CreatorLibraryTitle,
} from './creator-library-table'
import type { ReactNode } from 'react'
import { useDetailView } from './detail-inspector-context'
import {
  FreshnessState,
  freshnessColumnWidth,
  updateProviderFreshness,
  providerFreshnessLabel,
  providerFreshnessOptions,
  providerFreshnessValue,
} from './film-selection-table'
import { ListeningControls } from './listening-controls'
import { useConfig } from './providers'
import { useSourceAvailability, useSourceCatalog } from './provider-sources'
import AiSearch from './ai-search'
import MetadataSelectionToolbar from './metadata-selection-toolbar'
import {
  clearLibraryScope,
  libraryScopeQuery,
  libraryScopeUpdates,
  readLibraryScope,
} from '@/utils/library-scope'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'

type ArtistColumn = {
  key: string
  label: string
  width: number
  required?: boolean
  defaultVisible?: boolean
  align?: 'end'
  fill?: boolean
}
const artistColumns: ArtistColumn[] = [
  { key: 'name', label: 'Artist', width: 260, required: true, fill: true },
  {
    key: 'albumCount',
    label: 'Albums',
    width: 90,
    defaultVisible: false,
    align: 'end',
  },
  {
    key: 'trackCount',
    label: 'Tracks',
    width: 90,
    defaultVisible: false,
    align: 'end',
  },
  { key: 'playlistCount', label: 'Playlists', width: 100, align: 'end' },
  { key: 'createdAt', label: 'Added', width: 110, defaultVisible: false },
]
/** Width of the selection column, which the name is pinned after. */
const selectionWidth = 36
const queueKey = ['metadata-selection-queue', 'artist']
const snapshotKey = ['artist-selection-snapshot']
type QueueSelection = {
  catalog: CatalogScopeQuery
  batchId: string
  total: number
  selectionKey: string
  snapshot: ArtistSelectionSnapshot | null
  selected: string[]
  omitted: string[]
  providers: QueueArtistSelection['providers']
  freshness: QueueArtistSelection['freshness']
  confirmBroadRun: boolean
}
const ArtistMetadataSliceSchema = BrowsePageSliceSchema(
  ArtistMetadataItemSchema,
)

export function ArtistScrapeState({
  state,
  label,
}: {
  state: ArtistProviderMetadata | undefined
  label: string
}) {
  return (
    <FreshnessState
      label={label}
      lastSuccess={state?.lastScrapedAt}
      attempt={state?.lastJobStatus}
      attempted={Boolean(state?.lastAttemptAt)}
    />
  )
}

export default function ArtistMetadataTable({
  filters,
}: {
  /** Controls placed after the search, such as the library. */
  filters?: ReactNode
} = {}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const view = useDetailView()
  const queuePending = useIsMutating({ mutationKey: queueKey }) > 0
  const snapshotPending = useIsMutating({ mutationKey: snapshotKey }) > 0
  const pending = queuePending || snapshotPending
  const playlist = useArtistPlaylistFilter(pending)
  const query = artistMetadataQuery(view.params)
  const libraryScope = readLibraryScope(view.params)
  const scopeQuery = libraryScopeQuery(libraryScope)
  const q = query.q ?? ''
  const catalog = useSourceCatalog()
  const available = catalog.data?.filter(supportsArtistEnrichment) ?? []
  const providers = catalog.data
    ? available.map(({ id }) => id)
    : ArtistProfileProviderSchema.options
  const providerLabel = (provider: string) =>
    artistProviderLabel(provider, catalog.data)
  const unavailable = useSourceAvailability(available)
  const [draft, setDraft] = useState('')
  const facets = useBrowseFacets(
    apiBaseUrl,
    'artists',
    draft,
    !pending,
    false,
    undefined,
    false,
    scopeQuery,
  )
  const libraryColumns: ArtistColumn[] = [
    ...artistColumns,
    {
      key: listeningScrobblesKey,
      label: listeningScrobblesField(query.listeningSort).label,
      width: 110,
      defaultVisible: false,
      align: 'end',
    },
  ]
  const columns = useTableColumns('artist-metadata-selection', [
    ...libraryColumns,
    ...providers.map((provider) => ({
      key: `provider-${provider}`,
      label: `${providerLabel(provider)} · Last scraped`,
      width: freshnessColumnWidth,
    })),
  ])
  // The period is read only for its column or sort.
  const listeningSort =
    query.sortBy === listeningScrobblesKey ||
    columns.visible(listeningScrobblesKey)
      ? (query.listeningSort ?? defaultListeningPeriod)
      : undefined
  // The histogram counts the library under the browse filters alone.
  const listeningParams = new URLSearchParams({
    q,
    filters: JSON.stringify(query.filters),
    ranges: JSON.stringify(query.ranges),
    ...playlist.filters,
    ...scopeQuery,
  })
  const params = new URLSearchParams({
    q,
    sortBy: query.sortBy,
    direction: query.direction,
    freshness: JSON.stringify(query.freshness),
    filters: JSON.stringify(query.filters),
    ranges: JSON.stringify(query.ranges),
    ...(query.limitResults === undefined
      ? {}
      : { limitResults: String(query.limitResults) }),
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.listening ? { listening: JSON.stringify(query.listening) } : {}),
    ...(listeningSort ? { listeningSort: JSON.stringify(listeningSort) } : {}),
    ...playlist.filters,
    ...scopeQuery,
  })
  const identity = params.toString()
  const currentIdentity = useRef(identity)
  const generation = useRef(0)
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity
    generation.current += 1
  }
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction', 'provider', 'listeningSort'])
    countParams.delete(key)
  const countIdentity = countParams.toString()
  const [selected, setSelected] = useState<string[]>([])
  const [snapshot, setSnapshot] = useState<ArtistSelectionSnapshot | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [processed, setProcessed] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [review, setReview] = useState('')
  const [progress, setProgress] = useState(0)
  const selectAll = useRef<HTMLInputElement>(null)
  const counted = useCountedVirtualTable({
    queryKey: ['artist-selection', identity],
    countKey: ['artist-selection', 'count', countIdentity],
    loadCount: (signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/metadata/browse-count?${countIdentity}`,
        BrowseCountSchema,
        { signal },
      ),
    pageSize: 50,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/metadata/browse-page?${identity}&page=${page}&size=${size}`,
        ArtistMetadataSliceSchema,
        { signal },
      ),
    refetchInterval: (page) =>
      !pending &&
      page?.items.some((artist) =>
        artist.providers.some(
          (state) =>
            state.lastJobStatus === 'queued' ||
            state.lastJobStatus === 'running',
        ),
      )
        ? 3000
        : false,
  })
  const artists = counted.window
  const visible = libraryColumns.filter((column) => columns.visible(column.key))
  const visibleProviders = providers.filter((provider) =>
    columns.visible(`provider-${provider}`),
  )
  const layout = columns.layout([
    selectionWidth,
    ...visible.map((column) => column.key),
    ...visibleProviders.map((provider) => `provider-${provider}`),
  ])
  const ids = [...new Set(artists.loadedSlots.map(({ item }) => item.id))]
  const visibleIds = artists.slots.flatMap(({ item }) =>
    item ? [item.id] : [],
  )
  const members = useQuery({
    queryKey: ['artist-selection-members', snapshot?.id, visibleIds],
    enabled: snapshot !== null && visibleIds.length > 0,
    queryFn: async ({ signal }) => {
      if (!snapshot) return []
      const matches: string[] = []
      for (let offset = 0; offset < visibleIds.length; offset += 100) {
        const search = new URLSearchParams({
          ids: JSON.stringify(visibleIds.slice(offset, offset + 100)),
        })
        const page = await fetchApiData(
          apiBaseUrl,
          `/api/v1/artists/metadata/selections/${encodeURIComponent(snapshot.id)}?${search}`,
          ArtistSelectionSnapshotPageSchema,
          { signal },
        )
        matches.push(...page.ids)
      }
      return matches
    },
    retry: false,
  })
  const snapshotMembers = members.data ?? []
  const omitted = [...new Set([...excluded, ...processed])]
  const isSelected = (id: string) =>
    snapshot
      ? snapshotMembers.includes(id) && !omitted.includes(id)
      : selected.includes(id)
  const selectionCount = snapshot
    ? Math.max(0, snapshot.totalCount - omitted.length)
    : selected.length
  const allChecked = snapshot
    ? snapshot.totalCount > 0 && excluded.length === 0
    : ids.length > 0 && ids.every((id) => selected.includes(id))
  const partiallyChecked =
    !allChecked &&
    (snapshot ? selectionCount > 0 : ids.some((id) => selected.includes(id)))
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partiallyChecked
  }, [partiallyChecked])
  useEffect(() => {
    setSelected([])
    setSnapshot(null)
    setExcluded([])
    setProcessed([])
    setAnchor(null)
    setReview('')
  }, [identity])
  const launchProviders = providers.filter(
    (id) =>
      selectedProviders.includes(id) &&
      !unavailable(available.find((provider) => provider.id === id)),
  )
  const createSnapshot = useMutation({
    mutationKey: snapshotKey,
    retry: false,
    mutationFn: (input: {
      identity: string
      generation: number
      query: ReturnType<typeof artistMetadataQuery>
    }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/artists/metadata/selections',
        ArtistSelectionSnapshotSchema,
        {
          method: 'POST',
          body: JSON.stringify({ query: input.query }),
        },
      ),
    onSuccess: (result, input) => {
      if (
        currentIdentity.current !== input.identity ||
        generation.current !== input.generation
      )
        return
      setSnapshot(result)
      setExcluded([])
      setProcessed([])
      setSelected([])
      setAnchor(null)
      setReview('')
    },
  })
  const operations = selectionCount * launchProviders.length
  const selectionKey = JSON.stringify([
    identity,
    generation.current,
    selected,
    snapshot?.id,
    excluded,
    processed,
  ])
  const confirmationKey = JSON.stringify([selectionKey, launchProviders])
  const currentSelectionKey = useRef(selectionKey)
  currentSelectionKey.current = selectionKey
  const reviewed = review === confirmationKey
  const queue = useMutation({
    mutationKey: queueKey,
    mutationFn: (input: QueueSelection) => {
      const send = (artistIds: string[]) =>
        fetchApiData(
          apiBaseUrl,
          '/api/v1/artists/enrichment',
          ArtistEnrichmentResultSchema,
          {
            method: 'POST',
            body: JSON.stringify(
              QueueArtistSelectionSchema.parse({
                artistIds,
                batchId: input.batchId,
                providers: input.providers,
                freshness: input.freshness,
                confirmBroadRun: input.confirmBroadRun,
                ...input.catalog,
              }),
            ),
          },
        )
      const selection = input.snapshot
      return selection
        ? dispatchArtistSnapshot(
            input.omitted,
            (after) => {
              const search = new URLSearchParams({
                size: '100',
                ...(after ? { after } : {}),
              })
              return fetchApiData(
                apiBaseUrl,
                `/api/v1/artists/metadata/selections/${encodeURIComponent(selection.id)}?${search}`,
                ArtistSelectionSnapshotPageSchema,
              )
            },
            send,
            setProgress,
          )
        : dispatchArtistSelection(input.selected, send, setProgress)
    },
    onMutate: () => setProgress(0),
    onSuccess: (result, input) => {
      if (currentSelectionKey.current !== input.selectionKey) return
      setSelected((current) =>
        current.filter((id) => !result.completed.includes(id)),
      )
      if (input.snapshot) {
        const next = [...new Set([...processed, ...result.completed])]
        if (new Set([...excluded, ...next]).size >= input.snapshot.totalCount) {
          setSnapshot(null)
          setExcluded([])
          setProcessed([])
        } else setProcessed(next)
      }
      setReview('')
    },
    onSettled: () => {
      void Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
        client.invalidateQueries({ queryKey: ['artist-selection'] }),
      ])
    },
  })
  const acceptedBatch = queue.data?.queued
    ? queue.variables?.batchId
    : undefined
  const batchFeedback = useJobBatchFeedback(apiBaseUrl, acceptedBatch)
  const queueFeedback =
    batchFeedback ??
    (queue.data
      ? queueReceipt(queue.data.queued, queue.data.skipped)
      : undefined)

  function setParams(updates: Record<string, string | null>) {
    if (pending) return
    const next = new URLSearchParams(view.params)
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    view.replace(next)
  }
  function sort(sortBy: string, provider = '') {
    setParams({
      sortBy,
      provider,
      direction:
        query.sortBy === sortBy &&
        (query.provider ?? '') === provider &&
        query.direction === 'asc'
          ? 'desc'
          : 'asc',
    })
  }
  const sortKey =
    query.sortBy === 'lastScrapedAt'
      ? `provider-${query.provider}`
      : query.sortBy
  const browseHref = embeddedBrowseHref('artists', {}, view.params)
  return (
    <ResultSection
      as="div"
      className="ops-fill"
      identity={identity}
      result={{
        isFetching:
          artists.isFetching ||
          (counted.isCounting && !counted.countError && !artists.isError),
        isError: artists.isError || counted.countError,
      }}
    >
      <MetadataSelectionToolbar
        libraryScope={{
          value: libraryScope,
          onChange: (next) => setParams(libraryScopeUpdates(next)),
        }}
        disabled={pending}
        fields={artistBrowseFields}
        filterHref={(filter) => browseFilterHref(browseHref, [filter])}
        value={{
          q,
          filters: query.filters,
          ranges: query.ranges,
          limitResults: query.limitResults,
          listening: query.listening,
        }}
        otherFiltersActive={
          query.playlistIds.length > 0 || query.freshness.length > 0
        }
        providerFilters={query.freshness.map((filter) => ({
          key: `${filter.provider}:${providerFreshnessValue(filter)}`,
          label: `${providerLabel(filter.provider)} · ${providerFreshnessLabel(filter)}`,
          remove: () =>
            setParams({
              freshness: JSON.stringify(
                query.freshness.filter((item) => item !== filter),
              ),
            }),
        }))}
        onChange={(next) =>
          setParams({
            q: next.q || null,
            filters: JSON.stringify(next.filters),
            ranges: JSON.stringify(next.ranges),
            limitResults:
              next.limitResults === undefined
                ? null
                : String(next.limitResults),
            listening: next.listening ? JSON.stringify(next.listening) : null,
          })
        }
        onClear={() =>
          setParams({
            q: null,
            filters: null,
            ranges: null,
            playlistIds: null,
            freshness: null,
            limitResults: null,
            listening: null,
            ...clearLibraryScope,
          })
        }
        search={
          <AiSearch
            target={mediaAiSearchTarget('artist', artistBrowseFields)}
            queryIdentity={identity}
            autocomplete={{
              onFocus: facets.activate,
              options: facets.data ?? [],
              items: [],
              titlesLoading: facets.isDebouncing || facets.isPending,
              titlesError: facets.isError,
              placeholder: 'Search artists, playlists, tags, countries...',
              value: draft,
              disabled: pending,
              onValueChange: setDraft,
              filterHref: (filter) =>
                browseFilterHref(
                  browseHref,
                  withArtistFilter(query.filters, filter),
                ),
              searchHref: (value) => browseSearchHref(browseHref, { q: value }),
              onAddFilter: (filter) => {
                setParams({
                  filters: JSON.stringify(
                    withArtistFilter(query.filters, filter),
                  ),
                })
                setDraft('')
              },
              onApplyText: (value) => {
                setParams({ q: value || null })
                setDraft('')
              },
              onOpenItem: () => {},
            }}
            onApply={(plan) => {
              setParams({
                ...aiSearchParams(plan),
                playlistIds: null,
                provider: null,
              })
              setDraft('')
            }}
          />
        }
        filters={filters}
        actions={
          snapshot ? (
            <span className="ds-actions">
              <span
                className="ds-muted"
                role="status"
                title={`Selection expires ${formatDateTime(snapshot.expiresAt)}`}
              >
                {formatCount(selectionCount)} matching artists selected
                {excluded.length
                  ? ` · ${formatCount(excluded.length)} excluded`
                  : ''}
                {processed.length
                  ? ` · ${formatCount(processed.length)} processed`
                  : ''}
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setSnapshot(null)
                  setExcluded([])
                  setProcessed([])
                  setReview('')
                }}
              >
                Clear selection
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={pending || (artists.hasTotal && artists.total === 0)}
              feedback={mutationFeedback(createSnapshot, {
                pending: 'Selecting…',
                success: `${formatCount(selectionCount)} selected`,
                error: 'Could not select artists',
              })}
              onClick={() =>
                createSnapshot.mutate({
                  identity,
                  generation: generation.current,
                  query,
                })
              }
            >
              Select all
              {artists.hasTotal ? ` ${formatCount(artists.total)}` : ''}{' '}
              matching artists
            </Button>
          )
        }
        count={
          counted.countError ? (
            <ReadButton variant="link" size="xs" read={counted.retryCount}>
              Retry count
            </ReadButton>
          ) : !counted.isCounting ? (
            `${formatCount(artists.total)} ${artists.total === 1 ? 'artist' : 'artists'}`
          ) : (
            'Counting...'
          )
        }
        columns={columns.controls}
      >
        <ListeningControls
          apiBaseUrl={apiBaseUrl}
          library="artist"
          params={listeningParams}
          filter={query.listening}
          sortPeriod={query.listeningSort}
          total={artists.hasTotal ? artists.total : undefined}
          examples={artists.loadedSlots.slice(0, 3).map(({ item }) => ({
            id: item.id,
            title: item.name,
            artworkUrl: item.artworkUrl,
            by: formatItemCount(item.albumCount, {
              one: 'album',
              other: 'albums',
            }),
          }))}
          onFilterChange={(listening) =>
            setParams({
              listening: listening ? JSON.stringify(listening) : null,
            })
          }
          onSortPeriodChange={(period) =>
            setParams({ listeningSort: JSON.stringify(period) })
          }
        />
      </MetadataSelectionToolbar>
      {(artists.isError ||
        catalog.isError ||
        createSnapshot.isError ||
        (snapshot && (members.isFetching || members.isError))) && (
        <div className="ops-notice">
          {artists.isError && (
            <Notice
              tone="danger"
              action={
                <ReadButton size="xs" read={artists.retry}>
                  Retry
                </ReadButton>
              }
            >
              Could not load artists.
            </Notice>
          )}
          {catalog.isError && (
            <Notice
              tone="danger"
              action={
                <ReadButton size="xs" read={() => catalog.refetch()}>
                  Retry
                </ReadButton>
              }
            >
              Could not load providers.
            </Notice>
          )}
          {createSnapshot.isError && (
            <Notice tone="danger">
              Could not select matching artists. Try Select all matching again.
            </Notice>
          )}
          {snapshot && members.isFetching && (
            <p className="ds-help" role="status">
              Checking selection for visible rows...
            </p>
          )}
          {snapshot && members.isError && (
            <Notice
              tone="danger"
              action={
                <ReadButton size="xs" read={() => members.refetch()}>
                  Retry
                </ReadButton>
              }
            >
              Could not check the selected rows. If the selection expired, clear
              it and select matching artists again.
            </Notice>
          )}
        </div>
      )}
      <SecondaryTableScroll
        ref={artists.scroller}
        onScroll={artists.onScroll}
        role="region"
        aria-label="Artist metadata"
        aria-busy={artists.isFetching}
      >
        <table
          className="ds-table"
          aria-label="Artist metadata"
          aria-rowcount={artists.hasTotal ? artists.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <thead>
            <tr>
              <TableHead sticky={0}>
                <input
                  type="checkbox"
                  className="ds-check"
                  ref={selectAll}
                  aria-label={
                    snapshot
                      ? 'Select all matching artists'
                      : 'Select all loaded artists'
                  }
                  checked={allChecked}
                  disabled={!ids.length || pending}
                  onChange={() => {
                    if (snapshot) {
                      if (allChecked) {
                        setSnapshot(null)
                        setProcessed([])
                      }
                      setExcluded([])
                    } else
                      setSelected(
                        allChecked ? [] : [...new Set([...selected, ...ids])],
                      )
                    setReview('')
                  }}
                />
              </TableHead>
              {visible.map((column) => (
                <SecondaryTableHead
                  key={column.key}
                  sortKey={column.key}
                  label={column.label}
                  sortBy={sortKey}
                  direction={query.direction}
                  onSort={(key) => sort(key)}
                  disabled={pending}
                  align={column.align}
                  sticky={column.key === 'name' ? selectionWidth : undefined}
                  stickyEdge={column.key === 'name'}
                  resizer={columns.resizer(column.key)}
                  filter={
                    column.key === 'playlistCount'
                      ? playlist.control
                      : undefined
                  }
                />
              ))}
              {visibleProviders.map((provider) => (
                <SecondaryTableHead
                  key={provider}
                  sortKey={`provider-${provider}`}
                  label={`${providerLabel(provider)} · Last scraped`}
                  sortBy={sortKey}
                  direction={query.direction}
                  onSort={() => sort('lastScrapedAt', provider)}
                  disabled={pending}
                  resizer={columns.resizer(`provider-${provider}`)}
                  filter={
                    <SecondaryColumnFilter
                      label={`${providerLabel(provider)} freshness`}
                      disabled={pending}
                      options={providerFreshnessOptions}
                      value={query.freshness
                        .filter((filter) => filter.provider === provider)
                        .map(providerFreshnessValue)}
                      onChange={(next) =>
                        setParams({
                          freshness: JSON.stringify(
                            updateProviderFreshness(
                              query.freshness,
                              provider,
                              next,
                            ),
                          ),
                        })
                      }
                    />
                  }
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {artists.hasTotal && artists.total === 0 && (
              <TableState colSpan={columns.count + 1}>
                No matching artists.
              </TableState>
            )}
            <SecondaryVirtualRows
              window={artists}
              colSpan={columns.count + 1}
              renderRow={(artist, index) => (
                <TableRow
                  key={artist.id}
                  aria-rowindex={index + 2}
                  selected={isSelected(artist.id)}
                >
                  <TableCell sticky={0}>
                    <input
                      type="checkbox"
                      className="ds-check"
                      aria-label={`Select ${artist.name}`}
                      checked={isSelected(artist.id)}
                      aria-busy={snapshot ? members.isFetching : undefined}
                      disabled={
                        pending ||
                        Boolean(
                          snapshot &&
                          (!snapshotMembers.includes(artist.id) ||
                            processed.includes(artist.id)),
                        )
                      }
                      onChange={(event) => {
                        const shift =
                          'shiftKey' in event.nativeEvent &&
                          event.nativeEvent.shiftKey === true
                        if (snapshot)
                          setExcluded(
                            updateJobSelection(
                              excluded,
                              ids.filter(
                                (id) =>
                                  snapshotMembers.includes(id) &&
                                  !processed.includes(id),
                              ),
                              artist.id,
                              anchor,
                              shift,
                              !event.target.checked,
                            ),
                          )
                        else
                          setSelected(
                            updateJobSelection(
                              selected,
                              ids,
                              artist.id,
                              anchor,
                              shift,
                              event.target.checked,
                            ),
                          )
                        setAnchor(artist.id)
                        setReview('')
                      }}
                    />
                  </TableCell>
                  {visible.map((column) => (
                    <TableCell
                      key={column.key}
                      align={column.align}
                      sticky={
                        column.key === 'name' ? selectionWidth : undefined
                      }
                      stickyEdge={column.key === 'name'}
                    >
                      {column.key === 'name' ? (
                        <span className="ds-cell-id">
                          <CreatorLibraryTitle
                            kind="artist"
                            id={artist.id}
                            title={artist.name}
                          />
                          {artist.inLibrary === false && (
                            <span className="ds-muted">Outside library</span>
                          )}
                        </span>
                      ) : column.key === 'createdAt' ? (
                        <CreatorLibraryDate value={artist.createdAt} />
                      ) : (
                        formatCount(
                          column.key === 'albumCount'
                            ? artist.albumCount
                            : column.key === 'trackCount'
                              ? artist.trackCount
                              : column.key === listeningScrobblesKey
                                ? (artist.listeningScrobbles ?? 0)
                                : artist.playlistCount,
                        )
                      )}
                    </TableCell>
                  ))}
                  {visibleProviders.map((provider) => (
                    <TableCell key={provider}>
                      <ArtistScrapeState
                        state={artist.providers.find(
                          (state) => state.provider === provider,
                        )}
                        label={providerLabel(provider)}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              )}
            />
          </tbody>
        </table>
      </SecondaryTableScroll>
      {(selectionCount > 0 || pending || queue.isError || queue.data) && (
        <TableSelectionBar className="ops-selectbar">
          <span role="status">
            <b>{formatCount(selectionCount)} selected</b>
          </span>
          {(selectionCount > 0 || pending) && (
            <fieldset className="ops-providers" disabled={pending}>
              <legend className="ds-label">Fetch metadata from</legend>
              {!providers.length && (
                <span>No artist enrichment providers available.</span>
              )}
              {providers.map((provider) => {
                const reason = catalog.isPending
                  ? 'Loading providers...'
                  : unavailable(available.find((item) => item.id === provider))
                return (
                  <label className="ds-checkrow" key={provider} title={reason}>
                    <input
                      type="checkbox"
                      className="ds-check"
                      checked={launchProviders.includes(provider)}
                      disabled={Boolean(reason)}
                      onChange={(event) => {
                        setSelectedProviders((current) =>
                          event.target.checked
                            ? [...current, provider]
                            : current.filter((id) => id !== provider),
                        )
                        setReview('')
                      }}
                    />
                    {providerLabel(provider)}
                    {reason ? ` (${reason})` : ''}
                  </label>
                )
              })}
            </fieldset>
          )}
          <span className="ds-actions ds-toolbar-end">
            {!reviewed ? (
              selectionCount > 0 ? (
                <Button
                  variant="primary"
                  type="button"
                  disabled={pending || !operations}
                  onClick={() => setReview(confirmationKey)}
                >
                  Review {formatCount(operations)} metadata jobs
                </Button>
              ) : null
            ) : (
              <span
                className="ops-review"
                role="region"
                aria-label="Review artist metadata jobs"
              >
                <span>
                  <b>Queue up to {formatCount(operations)} metadata jobs</b> ·{' '}
                  {formatCount(selectionCount)} artists ×{' '}
                  {launchProviders.length}{' '}
                  {launchProviders.length === 1 ? 'provider' : 'providers'}.
                  Only selected artists are queued. Active jobs are skipped;
                  provider limits and cooldowns apply.
                </span>
                <span className="ds-actions">
                  <Button
                    variant="primary"
                    type="button"
                    disabled={pending || !operations}
                    feedback={
                      queue.isPending
                        ? {
                            phase: 'pending',
                            label: `Submitting ${formatCount(progress)}/${formatCount(queue.variables?.total ?? selectionCount)}…`,
                          }
                        : undefined
                    }
                    onClick={() =>
                      queue.mutate({
                        selectionKey,
                        batchId: crypto.randomUUID(),
                        total: selectionCount,
                        catalog: scopeQuery,
                        snapshot,
                        selected: [...selected],
                        omitted,
                        providers: [...launchProviders],
                        freshness: query.freshness.filter((filter) =>
                          launchProviders.some(
                            (provider) => provider === filter.provider,
                          ),
                        ),
                        confirmBroadRun: operations > 5 && reviewed,
                      })
                    }
                  >
                    Confirm {formatCount(operations)} metadata jobs
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setReview('')}
                  >
                    Back
                  </Button>
                </span>
              </span>
            )}
            {!queue.isPending &&
              (queue.isError || queue.data?.interrupted || queueFeedback) && (
                <Button
                  disabled
                  feedback={
                    queue.isError || queue.data?.interrupted
                      ? submissionFeedback(
                          queue.data?.queued ? queueFeedback : undefined,
                        )
                      : queueFeedback
                  }
                >
                  Artist metadata jobs
                </Button>
              )}
          </span>
        </TableSelectionBar>
      )}
      {(queue.isError || queue.data) && (
        <div className="ops-notice">
          {queue.isError && (
            <Notice tone="danger">
              Could not queue selection. Check artist jobs before retrying.
            </Notice>
          )}
          {queue.data && (
            <Notice
              action={
                <Button asChild size="xs">
                  <Link
                    href={
                      queue.variables
                        ? `/jobs?batchId=${encodeURIComponent(queue.variables.batchId)}&mediaType=artist`
                        : '/jobs?mediaType=artist'
                    }
                  >
                    View artist jobs
                  </Link>
                </Button>
              }
            >
              {formatCount(queue.data.queued)} jobs queued ·{' '}
              {formatCount(queue.data.skipped)} skipped.
              {queue.data.warnings.map((warning) => (
                <span className="block" key={warning}>
                  {warning}
                </span>
              ))}
            </Notice>
          )}
        </div>
      )}
    </ResultSection>
  )
}
