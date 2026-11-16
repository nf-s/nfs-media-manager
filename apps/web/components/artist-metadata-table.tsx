'use client'

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
import { BrowseCountSchema, BrowsePageSliceSchema } from '@repo/schemas/browse'
import { Button } from '@repo/ui/components/ui/button'
import { TableState } from '@repo/ui/components/ui/table'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { fetchApiData } from '@/utils/api'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { withArtistFilter } from '@/utils/artist-browse'
import {
  artistMetadataQuery,
  dispatchArtistSelection,
  dispatchArtistSnapshot,
} from '@/utils/artist-selection'
import { updateJobSelection } from '@/utils/job-selection'
import { artistProviderLabels } from './artist-identifier-sources'
import { useArtistPlaylistFilter } from './artist-playlist-filter'
import {
  CreatorLibraryDate,
  CreatorLibraryTitle,
} from './creator-library-table'
import { useDetailView } from './detail-inspector-context'
import {
  updateProviderFreshness,
  providerFreshnessLabel,
  providerFreshnessOptions,
  providerFreshnessValue,
} from './film-selection-table'
import { useConfig } from './providers'
import { useSourceAvailability, useSourceCatalog } from './provider-sources'
import AiSearch from './ai-search'
import MetadataSelectionToolbar from './metadata-selection-toolbar'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableFooter,
  SecondaryTableFrame,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'

const artistColumns = [
  { key: 'name', label: 'Artist', required: true },
  { key: 'albumCount', label: 'Albums', defaultVisible: false },
  { key: 'trackCount', label: 'Tracks', defaultVisible: false },
  { key: 'playlistCount', label: 'Playlists' },
  { key: 'createdAt', label: 'Added', defaultVisible: false },
]
const providers = ArtistProfileProviderSchema.options
const queueKey = ['metadata-selection-queue', 'artist']
const snapshotKey = ['artist-selection-snapshot']
type QueueSelection = {
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
  const date = state?.lastScrapedAt
  const status = state?.lastJobStatus
  const pending = status === 'queued' || status === 'running'
  const statusLabel = status ? status[0]?.toUpperCase() + status.slice(1) : ''
  const text = date
    ? new Date(date).toLocaleString()
    : pending
      ? statusLabel
      : state?.lastAttemptAt
        ? 'Not scraped'
        : 'Never'
  return (
    <SecondaryCell
      text={text}
      label={`${label} scrape details`}
      tone={status === 'failed' ? 'warning' : 'info'}
      details={
        state && (date || status || state.lastAttemptAt) ? (
          <div className="space-y-1">
            <p>
              Last successful scrape:{' '}
              {date ? <CreatorLibraryDate value={date} withTime /> : 'Never'}
            </p>
            {status && <p>Latest job: {statusLabel}</p>}
            {state.lastAttemptAt && (
              <p>
                Last attempted:{' '}
                <CreatorLibraryDate value={state.lastAttemptAt} withTime />
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      {date ? <CreatorLibraryDate value={date} /> : text}
    </SecondaryCell>
  )
}

export default function ArtistMetadataTable() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const view = useDetailView()
  const queuePending = useIsMutating({ mutationKey: queueKey }) > 0
  const snapshotPending = useIsMutating({ mutationKey: snapshotKey }) > 0
  const pending = queuePending || snapshotPending
  const playlist = useArtistPlaylistFilter(pending)
  const query = artistMetadataQuery(view.params)
  const q = query.q ?? ''
  const [draft, setDraft] = useState('')
  const facets = useBrowseFacets(apiBaseUrl, 'artists', draft, !pending)
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
    ...playlist.filters,
  })
  const identity = params.toString()
  const currentIdentity = useRef(identity)
  const generation = useRef(0)
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity
    generation.current += 1
  }
  const countParams = new URLSearchParams(params)
  for (const key of ['sortBy', 'direction', 'provider']) countParams.delete(key)
  const countIdentity = countParams.toString()
  const catalog = useSourceCatalog()
  const available = (catalog.data ?? []).filter(
    (provider) => ArtistProfileProviderSchema.safeParse(provider.id).success,
  )
  const unavailable = useSourceAvailability(available)
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
  const columns = useTableColumns('artist-metadata-selection', [
    ...artistColumns,
    ...providers.map((provider) => ({
      key: `provider-${provider}`,
      label: `${artistProviderLabels[provider]} · Last scraped`,
    })),
  ])
  const visible = artistColumns.filter((column) => columns.visible(column.key))
  const visibleProviders = providers.filter((provider) =>
    columns.visible(`provider-${provider}`),
  )
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
                providers: input.providers,
                freshness: input.freshness,
                confirmBroadRun: input.confirmBroadRun,
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
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
        client.invalidateQueries({ queryKey: ['artist-selection'] }),
      ]),
  })

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
  return (
    <>
      <MetadataSelectionToolbar
        disabled={pending}
        fields={artistBrowseFields}
        value={{
          q,
          filters: query.filters,
          ranges: query.ranges,
          limitResults: query.limitResults,
        }}
        otherFiltersActive={
          query.playlistIds.length > 0 || query.freshness.length > 0
        }
        providerFilters={query.freshness.map((filter) => ({
          key: `${filter.provider}:${providerFreshnessValue(filter)}`,
          label: `${artistProviderLabels[ArtistProfileProviderSchema.parse(filter.provider)]} · ${providerFreshnessLabel(filter)}`,
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
        count={
          counted.countError ? (
            <button
              type="button"
              className="underline"
              onClick={counted.retryCount}
            >
              Retry count
            </button>
          ) : !counted.isCounting ? (
            `${artists.total.toLocaleString()} ${artists.total === 1 ? 'artist' : 'artists'}`
          ) : (
            'Counting...'
          )
        }
        columns={columns.controls}
      />
      {artists.isError && (
        <p role="alert">
          Could not load artists.{' '}
          <button type="button" className="underline" onClick={artists.retry}>
            Retry
          </button>
        </p>
      )}
      {catalog.isError && (
        <p role="alert">
          Could not load providers.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => catalog.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={artists.scroller}
          onScroll={artists.onScroll}
          role="region"
          aria-label="Artist metadata"
          aria-busy={artists.isFetching}
        >
          <table
            className="compact-table"
            aria-label="Artist metadata"
            aria-rowcount={artists.hasTotal ? artists.total + 1 : undefined}
          >
            <thead>
              <tr>
                <th className="table-selection-cell">
                  <input
                    type="checkbox"
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
                </th>
                {visible.map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortKey}
                    direction={query.direction}
                    onSort={(key) => sort(key)}
                    disabled={pending}
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
                    label={`${artistProviderLabels[provider]} · Last scraped`}
                    sortBy={sortKey}
                    direction={query.direction}
                    onSort={() => sort('lastScrapedAt', provider)}
                    disabled={pending}
                    filter={
                      <SecondaryColumnFilter
                        label={`${artistProviderLabels[provider]} freshness`}
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
                  <tr
                    key={artist.id}
                    aria-rowindex={index + 2}
                    data-selected={isSelected(artist.id) || undefined}
                  >
                    <td className="table-selection-cell">
                      <input
                        type="checkbox"
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
                    </td>
                    {visible.map((column) => (
                      <td key={column.key}>
                        {column.key === 'name' ? (
                          <CreatorLibraryTitle
                            kind="artist"
                            id={artist.id}
                            title={artist.name}
                          />
                        ) : column.key === 'createdAt' ? (
                          <CreatorLibraryDate value={artist.createdAt} />
                        ) : (
                          <SecondaryCell>
                            {(column.key === 'albumCount'
                              ? artist.albumCount
                              : column.key === 'trackCount'
                                ? artist.trackCount
                                : artist.playlistCount
                            ).toLocaleString()}
                          </SecondaryCell>
                        )}
                      </td>
                    ))}
                    {visibleProviders.map((provider) => (
                      <td key={provider}>
                        <ArtistScrapeState
                          state={artist.providers.find(
                            (state) => state.provider === provider,
                          )}
                          label={artistProviderLabels[provider]}
                        />
                      </td>
                    ))}
                  </tr>
                )}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
        <SecondaryTableFooter selectedCount={selectionCount}>
          <div className="film-selection-footer">
            <div className="job-selection-toolbar">
              {snapshot ? (
                <>
                  <span
                    title={`Selection expires ${new Date(snapshot.expiresAt).toLocaleString()}`}
                  >
                    Matching artists selected
                    {excluded.length
                      ? ` · ${excluded.length.toLocaleString()} excluded`
                      : ''}
                    {processed.length
                      ? ` · ${processed.length.toLocaleString()} processed`
                      : ''}
                  </span>
                  <Button
                    type="button"
                    size="sm"
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
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={
                    pending || (artists.hasTotal && artists.total === 0)
                  }
                  onClick={() =>
                    createSnapshot.mutate({
                      identity,
                      generation: generation.current,
                      query,
                    })
                  }
                >
                  {snapshotPending
                    ? 'Selecting matching artists...'
                    : `Select all${artists.hasTotal ? ` ${artists.total.toLocaleString()}` : ''} matching artists`}
                </Button>
              )}
            </div>
            <fieldset className="enrichment-providers" disabled={pending}>
              <legend>Fetch metadata from</legend>
              {providers.map((provider) => {
                const reason = catalog.isPending
                  ? 'Loading providers...'
                  : unavailable(available.find((item) => item.id === provider))
                return (
                  <label className="check-label" key={provider} title={reason}>
                    <input
                      type="checkbox"
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
                    {artistProviderLabels[provider]}
                    {reason ? ` (${reason})` : ''}
                  </label>
                )
              })}
            </fieldset>
            <div className="job-selection-toolbar">
              {!reviewed ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || !operations}
                  onClick={() => setReview(confirmationKey)}
                >
                  Review {operations} metadata jobs
                </Button>
              ) : (
                <div
                  className="job-action-review"
                  role="region"
                  aria-label="Review artist metadata jobs"
                >
                  <p>
                    <strong>Queue up to {operations} metadata jobs</strong> ·{' '}
                    {selectionCount} artists × {launchProviders.length}{' '}
                    {launchProviders.length === 1 ? 'provider' : 'providers'}
                  </p>
                  <p>
                    Only selected artists are queued. Active jobs are skipped;
                    provider limits and cooldowns apply.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending || !operations}
                      onClick={() =>
                        queue.mutate({
                          selectionKey,
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
                      {pending
                        ? `Queueing ${progress}/${selectionCount} artists...`
                        : `Confirm ${operations} metadata jobs`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setReview('')}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </SecondaryTableFooter>
      </SecondaryTableFrame>
      {createSnapshot.isError && (
        <p role="alert">
          Could not select matching artists. Try Select all matching again.
        </p>
      )}
      {snapshot && members.isFetching && (
        <p role="status">Checking selection for visible rows...</p>
      )}
      {snapshot && members.isError && (
        <p role="alert">
          Could not check the selected rows. If the selection expired, clear it
          and select matching artists again.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => members.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {queue.isError && (
        <p role="alert">
          Could not queue selection. Check artist jobs before retrying.
        </p>
      )}
      {queue.data && (
        <div role="status">
          {queue.data.queued} jobs queued · {queue.data.skipped} skipped.{' '}
          <Link href="/jobs?mediaType=artist" className="underline">
            View artist jobs
          </Link>
          {queue.data.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </>
  )
}
