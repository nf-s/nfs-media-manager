'use client'

import { useDeferredValue, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  trackBrowseFields,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import type {
  MatchDiagnosticsPage,
  MatchDiagnosticsRow,
} from '@repo/schemas/match-diagnostics'
import { getTrackBrowseValues, TrackDetailSchema } from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
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
import { formatItemCount } from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import {
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
  loadMatchDiagnosticsPage,
  loadTrackMatchDiagnosticsPage,
  matchDiagnosticsKey,
  matchDiagnosticsPageSize,
  matchDiagnosticsSort,
  playableMatchTrack,
  trackMatchDiagnosticsQuery,
} from '@/utils/match-diagnostics'
import { libraryMatchesHref, type LibraryView } from '@/utils/media-scope'
import { withTrackFilter } from '@/utils/track-browse'
import { BrowseItemsHead, ItemThumb, useColumnWidths } from './browse-items'
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
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
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
import { useTrackBrowseFields } from './track-browse-controls'
import { TrackBrowseValue } from './track-browse-cells'

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
    { key: 'name', label: labels.name, sortKey: 'name', required: true },
    ...(labels.creator
      ? [{ key: 'creator', label: labels.creator, sortKey: 'creator' }]
      : []),
    ...providers.map((provider) => ({
      key: `provider:${provider.key}`,
      label: provider.label,
      sortKey: provider.key,
      provider,
    })),
    { key: 'actions', label: 'Actions' },
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
}: {
  item: MatchDiagnosticsRow
  library: LibraryView
  provider: Provider
  onCorrect: (correction: TrackScrobbleCorrection) => void
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
  const sourceProvider =
    provider.key === 'lastfm-listening' ? 'lastfm' : provider.key
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
        details.length === 1 ? (
          details[0]?.text
        ) : (
          <ul>
            {details.map(({ text, correction, discogsAlbum }, index) => (
              <li key={index}>
                {discogsAlbum ? (
                  <DetailLink
                    kind="album"
                    id={discogsAlbum}
                    tab="sources"
                    view={{ sourceProvider }}
                  >
                    {text}
                  </DetailLink>
                ) : (
                  text
                )}
                {correction && correctionButton(correction)}
              </li>
            ))}
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
  return onlyCorrection ? (
    <div className="ds-cell-id">
      {cell}
      {correctionButton(onlyCorrection)}
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
    (target.data && target.data.spotifyMatch !== 'spotify-import')
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

export default function MatchDiagnosticsWorkspace({
  library,
}: {
  library: LibraryView
}) {
  const { apiBaseUrl } = useConfig()
  const inspector = useDetailInspector()
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
  const matchFields = useTrackBrowseFields(true, tracks)
  const [knownProviders, setKnownProviders] = useState<Provider[]>([])
  const [merge, setMerge] = useState<MergeSelection | null>(null)
  const query = useVirtualTable({
    queryKey: tracks
      ? [...matchDiagnosticsKey(library), trackQuery]
      : [...matchDiagnosticsKey(library), q, sortBy, direction],
    pageSize: matchDiagnosticsPageSize,
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
  const widths = useColumnWidths('tracks-matches', (field) =>
    field.key === 'title' ? 280 : field.type === 'text' ? 180 : 110,
  )
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
          data-layout={tracks ? 'fixed' : undefined}
          aria-label={title}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          style={
            tracks
              ? {
                  minWidth: shown.reduce(
                    (sum, column) =>
                      sum +
                      (column.browseField
                        ? widths.widthFor(column.browseField)
                        : 0),
                    0,
                  ),
                }
              : undefined
          }
        >
          {tracks && (
            <colgroup>
              {shown.map(
                ({ key, browseField }) =>
                  browseField && (
                    <col
                      key={key}
                      style={{ width: widths.widthFor(browseField) }}
                    />
                  ),
              )}
            </colgroup>
          )}
          <TableHeader>
            <TableRow>
              {shown.map((column) =>
                column.browseField ? (
                  <BrowseItemsHead
                    key={column.key}
                    field={column.browseField}
                    identity={column.key === 'title'}
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
              <TableState colSpan={shown.length}>
                {q || (tracks && hasTrackFilters)
                  ? 'No matching items.'
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
            <SecondaryVirtualRows
              window={query}
              colSpan={shown.length}
              renderRow={(item, index) => (
                <TableRow
                  key={item.id}
                  aria-rowindex={index + 2}
                  selected={
                    inspector?.root?.kind === library &&
                    inspector.root.id === item.id
                  }
                >
                  {shown.map((column) => (
                    <TableCell
                      key={column.key}
                      sticky={
                        column.key === 'name' || column.key === 'title'
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
      {tracks && <DetailInspector track={{ onFilter: addTrackFilter }} />}
    </section>
  )
}
