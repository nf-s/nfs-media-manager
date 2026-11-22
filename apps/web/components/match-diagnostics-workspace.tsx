'use client'

import { useDeferredValue, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  trackBrowseFields,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import type {
  AlbumMatchRejectionInput,
  MatchDiagnosticsPage,
  MatchDiagnosticsRow,
} from '@repo/schemas/match-diagnostics'
import {
  getTrackBrowseValues,
  isImportedSpotifyMatch,
  TrackDetailSchema,
} from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { tableHeaderHeight, useVirtualTable } from '@/hooks/useVirtualTable'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import { fetchApiData } from '@/utils/api'
import { defaultColumnWidth } from '@/utils/column-widths'
import {
  browseFilterHref,
  browseSearchHref,
  columnOrderParam,
  formatFieldValue,
  hasCustomColumnOrder,
  nextSortDirection,
  orderColumns,
  parseColumnOrder,
} from '@/utils/browse-items'
import {
  withoutDetailEntries,
  type DetailEntry,
  type DetailTarget,
} from '@/utils/detail-inspector'
import {
  albumMatchHistoryKey,
  loadMatchDiagnosticsPage,
  loadTrackMatchDiagnosticsPage,
  matchDiagnosticsKey,
  matchDiagnosticsPageSize,
  matchDiagnosticsSort,
  playableMatchTrack,
  rejectAlbumMatch,
  trackMatchDiagnosticsQuery,
} from '@/utils/match-diagnostics'
import { libraryMatchesHref, type LibraryView } from '@/utils/media-scope'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  orderedTrackMatchBrowseFields,
  withTrackFilter,
} from '@/utils/track-browse'
import {
  loadTrackDuplicateLayout,
  trackDuplicateLayoutKey,
  trackDuplicateRows,
} from '@/utils/track-duplicates'
import { AlbumMatchHistory } from './album-match-history'
import { BrowseItemsHead, ItemThumb } from './browse-items'
import { ConfirmAction } from './confirm-action'
import { DetailInspector } from './detail-inspector'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { LibraryTrackPlayButton } from './play-controls'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryCellDetails,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  fixedTableLayout,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import {
  canMergeLastfmTrack,
  TrackMergePanel,
  type TrackScrobbleCorrection,
} from './track-merge'
import TrackMatchesToolbar, {
  clearTrackMatchesFilters,
} from './track-matches-toolbar'
import { TrackBrowseValue } from './track-browse-cells'
import {
  TrackDuplicateGroupRow,
  TrackDuplicateResultBar,
  useTrackDuplicateActions,
  type TrackDuplicateActions,
} from './track-duplicate-group'
import {
  RowSelectAll,
  RowSelectRow,
  rowSelectionWidth,
  useRowSelection,
  type RowSelection,
} from './merge-bar'
import { TrackMergeBar } from './track-merge-bar'

const libraryLabels = {
  album: { name: 'Album', creator: 'Library artist', plural: 'albums' },
  artist: { name: 'Artist', creator: undefined, plural: 'artists' },
  film: { name: 'Film', creator: 'Director', plural: 'films' },
  subscription: {
    name: 'Subscription',
    creator: 'Channel or podcast',
    plural: 'subscriptions',
  },
  track: { name: 'Track', creator: 'Library artist', plural: 'tracks' },
}

/** A group row of the Possible duplicates view is as tall as the header (--ds-head). */
const groupRowHeight = tableHeaderHeight

type Provider = MatchDiagnosticsPage['providers'][number]
type Column = TableColumn & {
  sortKey?: string
  provider?: Provider
  browseField?: BrowseField
}
type MergeSelection = {
  sourceId: string
  targetId?: string
  correction?: TrackScrobbleCorrection
}

function matchColumns(
  library: LibraryView,
  providers: Provider[],
  matchFields: BrowseField[],
): Column[] {
  const labels = libraryLabels[library]
  if (library === 'track') {
    const trackFields = matchFields.filter((field) =>
      trackBrowseFields.some(({ key }) => field.key === key),
    )
    return [
      ...trackFields.map((field) => ({
        key: field.key,
        label: field.key === 'title' ? 'Track' : field.label,
        sortKey: field.key,
        browseField: {
          ...field,
          label: field.key === 'title' ? 'Track' : field.label,
        },
      })),
      ...providers.map<Column>((provider) => ({
        key: provider.key,
        label: provider.label,
        sortKey: provider.key,
        provider,
        browseField: { ...provider, type: 'text', filterable: false },
      })),
      {
        key: 'actions',
        label: 'Actions',
        browseField: {
          key: 'actions',
          label: 'Actions',
          type: 'text',
          filterable: false,
        },
      },
    ]
  }
  return [
    {
      key: 'name',
      label: labels.name,
      width: 280,
      fill: true,
      sortKey: 'name',
      required: true,
    },
    ...(labels.creator
      ? [
          {
            key: 'creator',
            label: labels.creator,
            width: 200,
            sortKey: 'creator',
          },
        ]
      : []),
    ...providers.map((provider) => ({
      key: `provider:${provider.key}`,
      label: provider.label,
      width: 180,
      sortKey: provider.key,
      provider,
    })),
    { key: 'actions', label: 'Actions', width: 84, resizable: false },
  ]
}

function providerIdentity(match: MatchDiagnosticsRow['matches'][number]) {
  return (
    [match.name, match.creator].filter(Boolean).join(' · ') || match.identifier
  )
}

function ProviderMatchCell({
  item,
  library,
  provider,
  onCorrect,
  onReject,
  rejecting,
}: {
  item: MatchDiagnosticsRow
  library: LibraryView
  provider: Provider
  onCorrect: (correction: TrackScrobbleCorrection) => void
  onReject: (target: AlbumMatchRejectionInput) => void
  rejecting: boolean
}) {
  const matches = item.matches.filter(
    (match) => match.provider === provider.key,
  )
  const first = matches[0]
  const identity = first ? providerIdentity(first) : null
  if (
    library === 'track' &&
    provider.key === 'spotify' &&
    item.spotifyAlternate
  ) {
    const alternate = item.spotifyAlternate
    const label = alternate.albumName
      ? `Other version · ${alternate.albumName}`
      : 'Other Spotify version'
    const alternateIdentity = [
      alternate.name,
      alternate.albumName,
      alternate.identifier,
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <SecondaryCell
        text={label}
        label={`Spotify version of ${item.name}`}
        details={
          first ? (
            <ul>
              <li>{alternateIdentity}</li>
              <li>
                <DetailLink kind="track" id={item.id} tab="sources">
                  Stored Spotify ID on this entry · {first.identifier}
                </DetailLink>
              </li>
            </ul>
          ) : (
            alternateIdentity
          )
        }
      >
        <DetailLink kind="track" id={alternate.trackId} tab="sources">
          {label}
        </DetailLink>
      </SecondaryCell>
    )
  }
  if (!first || !identity) return <EmptyValue />
  const display =
    matches.length === 1 ? identity : `${identity} (+${matches.length - 1})`
  const defaultSourceProvider =
    provider.key === 'lastfm-listening' ? 'lastfm' : provider.key
  const sourceProvider = first.sourceProvider ?? defaultSourceProvider
  const discogsPosition = library === 'track' && provider.key === 'discogs'
  const discogsAlbum = discogsPosition ? first.albumId : undefined
  const providerView =
    discogsAlbum ||
    library === 'album' ||
    library === 'film' ||
    library === 'artist'
      ? { sourceProvider }
      : undefined
  const review: DetailTarget = discogsAlbum
    ? { kind: 'album', id: discogsAlbum }
    : {
        kind: library,
        id:
          library === 'track' && provider.key === 'lastfm'
            ? (item.mergeSourceId ?? item.id)
            : item.id,
      }
  const details = matches.map((match) => {
    const text = providerIdentity(match)
    return {
      discogsAlbum: discogsPosition ? match.albumId : undefined,
      sourceProvider: match.sourceProvider ?? defaultSourceProvider,
      rejectionTarget: library === 'album' ? match.rejectionTarget : undefined,
      rejectedAt: library === 'album' ? match.rejectedAt : undefined,
      text: [text, match.identifier === text ? null : match.identifier]
        .filter(Boolean)
        .join(' · '),
      correction:
        library === 'track' &&
        provider.key === 'lastfm' &&
        match.artistKey &&
        match.trackKey
          ? {
              artistKey: match.artistKey,
              trackKey: match.trackKey,
              artistName: match.creator,
              trackName: match.name,
            }
          : undefined,
    }
  })
  const hasMixedSources =
    providerView &&
    details.some((detail) => detail.sourceProvider !== sourceProvider)
  const hasRejectionDetails = details.some(
    ({ rejectionTarget, rejectedAt }) => rejectionTarget || rejectedAt,
  )
  const correctionButton = (correction: TrackScrobbleCorrection) => (
    <Button
      size="xs"
      variant="ghost"
      aria-label={`Change match for ${correction.trackName ?? item.name}${correction.artistName ? ` by ${correction.artistName}` : ''}`}
      aria-haspopup="dialog"
      onClick={() => onCorrect(correction)}
    >
      Change match
    </Button>
  )
  const cell = (
    <SecondaryCell
      text={display}
      label={`${provider.label} identities for ${item.name}`}
      details={
        details.length === 1 && !hasRejectionDetails ? (
          details[0]?.text
        ) : (
          <ul>
            {details.map(
              (
                {
                  text,
                  correction,
                  discogsAlbum,
                  sourceProvider,
                  rejectedAt,
                  rejectionTarget,
                },
                index,
              ) => (
                <li key={index}>
                  {discogsAlbum || hasMixedSources ? (
                    <DetailLink
                      {...(discogsAlbum
                        ? { kind: 'album', id: discogsAlbum }
                        : review)}
                      tab="sources"
                      view={{ sourceProvider }}
                    >
                      {text}
                    </DetailLink>
                  ) : (
                    text
                  )}
                  {correction && correctionButton(correction)}
                  {rejectedAt && (
                    <div>
                      <Status state="attention">Incorrect</Status>{' '}
                      <time dateTime={rejectedAt}>
                        {formatDateTime(rejectedAt)}
                      </time>
                    </div>
                  )}
                  {rejectionTarget && !rejectedAt && (
                    <ConfirmAction
                      size="xs"
                      variant="ghost"
                      question="Mark this match as incorrect?"
                      ariaLabel={`Mark ${text} as incorrect`}
                      details={
                        <>{text}. Future scrapes will skip this match.</>
                      }
                      confirmLabel="Mark incorrect"
                      onConfirm={() => onReject(rejectionTarget)}
                      disabled={rejecting}
                    >
                      Mark incorrect
                    </ConfirmAction>
                  )}
                </li>
              ),
            )}
          </ul>
        )
      }
    >
      <DetailLink
        {...review}
        tab={library === 'subscription' ? undefined : 'sources'}
        view={providerView}
      >
        {display}
      </DetailLink>
    </SecondaryCell>
  )
  const onlyCorrection =
    details.length === 1 ? details[0]?.correction : undefined
  const rejectedCount = details.filter(({ rejectedAt }) => rejectedAt).length
  return onlyCorrection || rejectedCount ? (
    <div className="ds-cell-id">
      {cell}
      {onlyCorrection && correctionButton(onlyCorrection)}
      {rejectedCount > 0 && (
        <Status state="attention">
          {details.length === 1
            ? 'Incorrect'
            : `${formatCount(rejectedCount)} incorrect`}
        </Status>
      )}
    </div>
  ) : (
    cell
  )
}

function MatchTrackMerge({
  selection,
  onClose,
  onMerged,
}: {
  selection: MergeSelection
  onClose: () => void
  onMerged: (id: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const { sourceId, targetId, correction } = selection
  const source = useQuery({
    queryKey: ['track', sourceId],
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(sourceId)}`,
        TrackDetailSchema,
        { signal },
      ),
  })
  const target = useQuery({
    queryKey: ['track', targetId],
    enabled: targetId !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(targetId ?? '')}`,
        TrackDetailSchema,
        { signal },
      ),
  })
  const unavailable =
    source.isError ||
    target.isError ||
    (!correction && source.data && !canMergeLastfmTrack(source.data)) ||
    (target.data && !isImportedSpotifyMatch(target.data.spotifyMatch))
  if (
    unavailable ||
    source.isFetching ||
    !source.data ||
    (targetId && (target.isFetching || !target.data))
  )
    return (
      <Notice
        tone={unavailable ? 'danger' : undefined}
        action={
          <Button size="xs" variant="ghost" onClick={onClose}>
            {unavailable ? 'Dismiss' : 'Cancel'}
          </Button>
        }
      >
        {unavailable
          ? 'Could not load tracks for this merge.'
          : 'Loading tracks for merge…'}
      </Notice>
    )
  return (
    <TrackMergePanel
      track={source.data}
      initialTarget={target.data}
      correction={correction}
      onClose={onClose}
      onMerged={onMerged}
    />
  )
}

/**
 * The bar under Tracks Matches: the selection with Merge or, while nothing is
 * selected, the result of the last Merge or Keep separate from a group row.
 * Selecting a row hides that result.
 */
export function TrackMatchesBar({
  actions,
  selection,
  total,
}: {
  actions: Pick<
    TrackDuplicateActions,
    'change' | 'error' | 'progress' | 'setChange' | 'setError' | 'dismiss'
  >
  selection: RowSelection
  /** How many tracks the table lists. */
  total?: number
}) {
  const { change, error, progress, dismiss } = actions
  const selecting = selection.count > 0
  const finished = change !== null || error !== null
  useEffect(() => {
    if (selecting && finished) dismiss()
  }, [selecting, finished, dismiss])
  // Groups still being merged are reported too, before the first one finishes.
  if (selecting || (!finished && progress === null))
    return <TrackMergeBar selection={selection} total={total} />
  return <TrackDuplicateResultBar actions={actions} />
}

export default function MatchDiagnosticsWorkspace({
  library,
}: {
  library: LibraryView
}) {
  const { apiBaseUrl } = useConfig()
  const inspector = useDetailInspector()
  const client = useQueryClient()
  const rejection = useMutation({
    mutationFn: ({
      id,
      target,
    }: {
      id: string
      target: AlbumMatchRejectionInput
    }) => rejectAlbumMatch(apiBaseUrl, id, target),
    onSettled: (_, __, { id }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: matchDiagnosticsKey('album') }),
        client.invalidateQueries({ queryKey: albumMatchHistoryKey(id) }),
      ]),
  })
  const tracks = library === 'track'
  const path = libraryMatchesHref(library)
  const params = new URLSearchParams(useSearchParams())
  const urlSearch = (params.get('q') ?? '').slice(0, 200)
  const [search, setSearch] = useState(() => urlSearch)
  useEffect(() => {
    if (!tracks) setSearch(urlSearch)
  }, [tracks, urlSearch])
  const deferredSearch = useDeferredValue(search.trim())
  const trackQuery = trackMatchDiagnosticsQuery(params)
  const q = tracks ? (trackQuery.q ?? '') : deferredSearch
  const { sortBy, direction } = tracks
    ? trackQuery
    : matchDiagnosticsSort(params)
  const matchFields = orderedTrackMatchBrowseFields
  const [knownProviders, setKnownProviders] = useState<Provider[]>([])
  const [merge, setMerge] = useState<MergeSelection | null>(null)
  // Possible duplicates lists only grouped tracks, under a row for each group.
  const duplicates = tracks && trackQuery.duplicates === true
  // The group rows, read with the same request as the rows they stand above.
  const duplicateLayout = useQuery({
    queryKey: trackDuplicateLayoutKey(trackQuery),
    queryFn: ({ signal }) =>
      loadTrackDuplicateLayout(apiBaseUrl, trackQuery, signal),
    enabled: duplicates,
    ...clientQueryDefaults,
    retry: false,
  })
  const groupRows = trackDuplicateRows(
    duplicates ? (duplicateLayout.data?.groups ?? []) : [],
    groupRowHeight,
  )
  const duplicateActions = useTrackDuplicateActions()
  const query = useVirtualTable({
    queryKey: tracks
      ? [...matchDiagnosticsKey(library), trackQuery]
      : [...matchDiagnosticsKey(library), q, sortBy, direction],
    pageSize: matchDiagnosticsPageSize,
    headerHeight: tableHeaderHeight + groupRows.leadingHeight,
    extraRowHeights: groupRows.heights,
    loadPage: (page, size, signal) =>
      tracks
        ? loadTrackMatchDiagnosticsPage(
            apiBaseUrl,
            { ...trackQuery, page, size },
            signal,
          )
        : loadMatchDiagnosticsPage(
            apiBaseUrl,
            library,
            { q, page, size, sortBy, direction },
            signal,
          ),
  })
  const loadedProviders = query.firstPage?.providers
  useEffect(() => {
    if (loadedProviders) setKnownProviders(loadedProviders)
  }, [loadedProviders])
  const providers = loadedProviders ?? knownProviders
  // The loaded rows in order; a selection outlives rows scrolled out.
  const loadedIds = tracks
    ? [...new Set(query.slots.flatMap(({ item }) => (item ? [item.id] : [])))]
    : []
  const selection = useRowSelection(loadedIds)
  // Another search, filter, sort or Possible duplicates lists other tracks.
  const selectionKey = JSON.stringify(trackQuery)
  const [selectionIdentity, setSelectionIdentity] = useState(selectionKey)
  if (selectionIdentity !== selectionKey) {
    setSelectionIdentity(selectionKey)
    selection.clear()
  }
  const columns = matchColumns(library, providers, matchFields)
  const table = useTableColumns(`${library}-match-diagnostics`, columns)
  const trackColumnOrder = parseColumnOrder(params.get('columnOrder'))
  const ordered = tracks
    ? orderColumns(columns, trackColumnOrder, 'title')
    : columns
  const selected = [
    'title',
    ...(params.get('columns')?.split(',') ?? [
      'artist',
      'album',
      ...providers.map(({ key }) => key),
      'actions',
    ]),
  ]
  const shown = ordered.filter((column) =>
    tracks ? selected.includes(column.key) : table.visible(column.key),
  )
  const trackColumnFields = ordered.flatMap(({ browseField }) =>
    browseField ? [browseField] : [],
  )
  const trackSortFields = trackColumnFields.filter(
    ({ key }) => key !== 'actions',
  )
  // The Last.fm match shares its cell with Change match.
  const widths = useColumnWidths('tracks-matches', (field: BrowseField) =>
    field.key === 'title'
      ? 280
      : field.key === 'lastfm'
        ? 260
        : field.type === 'text'
          ? 180
          : 110,
  )
  const shownKeys = shown.map((column) => column.key)
  // Tracks keeps the widths saved under its Browse fields, Actions included.
  const layout = tracks
    ? fixedTableLayout(
        [rowSelectionWidth, ...shownKeys],
        (key) => {
          const field = shown.find((column) => column.key === key)?.browseField
          return field ? widths.widthFor(field) : defaultColumnWidth
        },
        'title',
      )
    : table.layout(shownKeys)
  // Tracks has the selection column before its columns.
  const colSpan = shown.length + (tracks ? 1 : 0)
  const labels = libraryLabels[library]
  const title = `${labels.name} matches`
  const count = query.hasTotal
    ? formatItemCount(query.total, {
        one: labels.name.toLowerCase(),
        other: labels.plural,
      })
    : undefined
  const hasTrackFilters = Boolean(
    q ||
    (trackQuery.playability && trackQuery.playability !== 'all') ||
    trackQuery.filters.length ||
    trackQuery.ranges.length ||
    trackQuery.creatorId ||
    trackQuery.limitResults,
  )

  /** The aria-rowindex of the row at `index`, after the header and the group rows above it. */
  function rowIndex(index: number) {
    return index + 2 + groupRows.through(index)
  }

  /** The group row above the row at `index`, when a group starts there. */
  function renderGroupRow(index: number) {
    const group = groupRows.above(index)
    return group ? (
      <TrackDuplicateGroupRow
        key={`group-${group.id}`}
        group={group}
        colSpan={colSpan}
        rowIndex={rowIndex(index) - 1}
        actions={duplicateActions}
      />
    ) : null
  }

  function replaceParam(update: (params: URLSearchParams) => void) {
    const current = new URLSearchParams(window.location.search)
    update(current)
    replaceWorkspaceUrl(
      `${path}${current.size ? `?${current}` : ''}${window.location.hash}`,
      Boolean(inspector?.active),
    )
  }

  function changeSearch(value: string) {
    setSearch(value)
    replaceParam((current) => {
      if (value.trim()) current.set('q', value.trim())
      else current.delete('q')
    })
  }

  function setTrackParams(
    updates: Record<string, string | null>,
    close = false,
  ) {
    const current = new URLSearchParams(window.location.search)
    const next = close
      ? withoutDetailEntries(path, current)
      : new URLSearchParams(current)
    if ('filters' in updates && !('playability' in updates))
      next.set('playability', trackQuery.playability ?? 'all')
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    next.delete('page')
    if (next.toString() === current.toString()) return
    const url = `${path}${next.size ? `?${next}` : ''}${window.location.hash}`
    if (inspector?.active) replaceWorkspaceUrl(url, !close)
    else window.history.pushState(null, '', url)
  }

  function addTrackFilter(filter: BrowseFilter, keepOpen = false) {
    const next = withTrackFilter(trackQuery.filters, filter)
    setTrackParams({ filters: JSON.stringify(next) }, !keepOpen)
  }
  const browseHref = `${path}?${params}`
  const filteredBrowseHref = browseSearchHref(browseHref, {
    playability: trackQuery.playability ?? 'all',
  })
  function trackFilterHref(filter: BrowseFilter) {
    return browseFilterHref(
      filteredBrowseHref,
      withTrackFilter(trackQuery.filters, filter),
    )
  }

  function sort(key: string) {
    if (tracks) {
      setTrackParams({
        sortBy: key,
        direction: nextSortDirection(trackSortFields, key, {
          sortBy,
          direction,
        }),
      })
      return
    }
    replaceParam((current) => {
      current.set('sortBy', key)
      current.set(
        'direction',
        key === sortBy && direction === 'asc' ? 'desc' : 'asc',
      )
    })
  }

  function renderCell(column: Column, item: MatchDiagnosticsRow) {
    if (column.provider)
      return (
        <ProviderMatchCell
          item={item}
          library={library}
          provider={column.provider}
          onCorrect={(correction) =>
            setMerge({ sourceId: item.id, correction })
          }
          onReject={(target) => rejection.mutate({ id: item.id, target })}
          rejecting={rejection.isPending}
        />
      )
    if (column.key === 'name' || column.key === 'title') {
      const playable = item.track
        ? playableMatchTrack(item.track, item.spotifyAlternate)
        : undefined
      return (
        <SecondaryCell text={item.name}>
          <span className="ds-cell-id">
            {item.track && (
              <ItemThumb
                kind="track"
                src={item.track.artworkUrl}
                title={item.name}
                target={{ kind: 'track', id: item.id }}
              />
            )}
            <DetailLink kind={library} id={item.id} className="ds-cell-title">
              {item.name}
            </DetailLink>
            {playable && (
              <LibraryTrackPlayButton track={playable} place="row" />
            )}
          </span>
        </SecondaryCell>
      )
    }
    if (column.key !== 'actions' && column.browseField && item.track)
      return (
        <TrackBrowseValue
          track={item.track}
          field={column.browseField}
          onFilter={addTrackFilter}
          filterHref={trackFilterHref}
        />
      )
    if (column.key === 'creator' || column.key === 'artist')
      return (
        <SecondaryCell text={item.creator ?? undefined}>
          {library === 'subscription' && item.sourceId ? (
            <DetailLink kind="channel" id={item.sourceId}>
              {item.creator ?? 'Source'}
            </DetailLink>
          ) : (
            (item.creator ?? <EmptyValue />)
          )}
        </SecondaryCell>
      )
    if (column.key === 'album')
      return <SecondaryCell>{item.albumName ?? <EmptyValue />}</SecondaryCell>
    if (column.key !== 'actions') return <EmptyValue />
    return (
      <span className="ds-cell-actions">
        <Button size="xs" variant="ghost" asChild>
          <DetailLink
            kind={library}
            id={item.id}
            tab={library === 'subscription' ? undefined : 'sources'}
            aria-label={`Review ${item.name}`}
          >
            Review
          </DetailLink>
        </Button>
        {library === 'album' && (
          <SecondaryCellDetails
            label={`Match history for ${item.name}`}
            buttonText="Match history"
          >
            {() => (
              <AlbumMatchHistory
                id={item.id}
                name={item.name}
                providers={providers}
              />
            )}
          </SecondaryCellDetails>
        )}
        {library === 'track' &&
          item.mergeSourceId &&
          item.mergeSourceId !== item.id &&
          !item.matches.some(
            (match) => match.provider === 'lastfm' && providerIdentity(match),
          ) && (
            <DetailLink kind="track" id={item.mergeSourceId} tab="sources">
              Last.fm record
            </DetailLink>
          )}
        {item.mergeSourceId && library === 'track' && (
          <Button
            size="xs"
            aria-label={`Merge ${item.name}`}
            aria-haspopup="dialog"
            onClick={() => {
              const sourceId = item.mergeSourceId
              if (sourceId)
                setMerge({
                  sourceId,
                  targetId: item.id === sourceId ? undefined : item.id,
                })
            }}
          >
            Merge
          </Button>
        )}
      </span>
    )
  }

  return (
    <section className="browse-workspace" aria-label={title}>
      <PageHead title={title} />
      {tracks ? (
        <TrackMatchesToolbar
          query={trackQuery}
          fields={matchFields}
          sortFields={trackSortFields}
          columnFields={trackColumnFields}
          visibleColumns={selected}
          count={count}
          onSort={sort}
          onOpenItem={(id, trigger) =>
            inspector?.open({ kind: 'track', id }, trigger)
          }
          onAddFilter={addTrackFilter}
          filterHref={trackFilterHref}
          activeFilterHref={(filter) =>
            browseFilterHref(filteredBrowseHref, [filter])
          }
          searchHref={(value) => browseSearchHref(browseHref, { q: value })}
          setParams={setTrackParams}
          onColumnOrder={(keys) =>
            setTrackParams({ columnOrder: columnOrderParam(keys, columns) })
          }
          onResetOrder={
            hasCustomColumnOrder(ordered, columns, 'title')
              ? () => setTrackParams({ columnOrder: null })
              : undefined
          }
        />
      ) : (
        <SecondaryTableToolbar
          search={
            <SecondaryTableSearch
              label="Search matches"
              value={search}
              maxLength={200}
              onChange={changeSearch}
            />
          }
          count={count}
          columns={table.controls}
        />
      )}
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load matches.
        </Notice>
      )}
      {merge && (
        <MatchTrackMerge
          key={JSON.stringify(merge)}
          selection={merge}
          onClose={() => setMerge(null)}
          onMerged={(id) => {
            const entry: DetailEntry = {
              kind: 'track',
              id,
              view: 'tab=sources',
            }
            if (inspector?.active?.kind === 'track') inspector.replace(entry)
            else inspector?.open(entry)
          }}
        />
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label={title}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          aria-label={title}
          aria-rowcount={
            query.hasTotal ? query.total + 1 + groupRows.count : undefined
          }
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {tracks && (
                <TableHead sticky={0}>
                  <RowSelectAll
                    selection={selection}
                    label="Select loaded tracks"
                    disabled={!loadedIds.length}
                  />
                </TableHead>
              )}
              {shown.map((column) =>
                column.browseField ? (
                  <BrowseItemsHead
                    key={column.key}
                    field={column.browseField}
                    identity={column.key === 'title'}
                    sticky={tracks ? rowSelectionWidth : 0}
                    sortable={column.sortKey !== undefined}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    resizer={widths.resizer(column.browseField)}
                  />
                ) : column.sortKey ? (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.sortKey}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    sticky={column.key === 'name' ? 0 : undefined}
                    stickyEdge={column.key === 'name'}
                    resizer={table.resizer(column.key)}
                  />
                ) : (
                  <TableHead key={column.key} align="end">
                    {column.label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={colSpan}>
                {q || (tracks && hasTrackFilters)
                  ? 'No matching items.'
                  : duplicates
                    ? 'No possible duplicates.'
                    : 'No library items.'}
                {tracks && hasTrackFilters && (
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() => clearTrackMatchesFilters(setTrackParams)}
                  >
                    Clear filters
                  </Button>
                )}
              </TableState>
            )}
            {groupRows.leading && renderGroupRow(0)}
            <SecondaryVirtualRows
              window={query}
              colSpan={colSpan}
              // The group row of the next group follows this row.
              renderAfter={(index) => renderGroupRow(index + 1)}
              renderRow={(item, index) => (
                <TableRow
                  key={item.id}
                  aria-rowindex={rowIndex(index)}
                  selected={
                    (inspector?.root?.kind === library &&
                      inspector.root.id === item.id) ||
                    selection.has(item.id)
                  }
                >
                  {tracks && (
                    <TableCell sticky={0}>
                      <RowSelectRow
                        selection={selection}
                        id={item.id}
                        title={item.name}
                      />
                    </TableCell>
                  )}
                  {shown.map((column) => (
                    <TableCell
                      key={column.key}
                      sticky={
                        column.key === 'title'
                          ? rowSelectionWidth
                          : column.key === 'name'
                            ? 0
                            : undefined
                      }
                      stickyEdge={
                        column.key === 'name' || column.key === 'title'
                      }
                      align={
                        column.key === 'actions' ||
                        column.browseField?.type === 'number'
                          ? 'end'
                          : undefined
                      }
                      title={
                        column.browseField && !column.provider && item.track
                          ? formatFieldValue(
                              column.browseField,
                              getTrackBrowseValues(item.track)[column.key],
                            )
                          : undefined
                      }
                    >
                      {renderCell(column, item)}
                    </TableCell>
                  ))}
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
      {tracks && (
        <TrackMatchesBar
          actions={duplicateActions}
          selection={selection}
          total={query.hasTotal ? query.total : undefined}
        />
      )}
      {duplicateActions.dialog}
      {tracks && <DetailInspector track={{ onFilter: addTrackFilter }} />}
    </section>
  )
}
