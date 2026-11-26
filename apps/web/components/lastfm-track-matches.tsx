'use client'

import { ResultFeedbackScope } from './result-feedback'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { DetailLink } from './detail-link'
import { LibraryTrackInlinePlayButtons } from './play-controls'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BrowseFilter } from '@repo/schemas/browse'
import type { TrackPlayability } from '@repo/schemas/match-diagnostics'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { Stats } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { formatCount } from '@repo/ui/lib/format'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
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
import { spotifyTrackUri } from '@/utils/album-links'
import { updateJobSelection } from '@/utils/job-selection'
import {
  loadTrackMatchDiagnosticsPage,
  playableMatchTrack,
} from '@/utils/match-diagnostics'
import { libraryMatchesHref } from '@/utils/media-scope'
import { spotifyWebUrl } from '@/utils/playback'
import { tracksHref } from '@/utils/track-browse'
import { trackServiceLinks } from '@/utils/track-links'
import {
  errorMessage,
  refreshScrobbleLinks,
  useLastfmSyncStatus,
} from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { TrackMergePanel } from './track-merge'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import {
  isActiveSpotifyTrackSearch,
  SpotifyTrackSearchJobCell,
  SpotifyTrackSearchReview,
  SpotifyTrackSearchSelectionBar,
  useSpotifyTrackSearchStatus,
} from './spotify-track-search'

const source: BrowseFilter = {
  field: 'source',
  value: trackSourceLabels.lastfm,
  mode: 'required',
}
type MatchStatus = 'needs-match' | 'matched'
type MatchSort = 'title' | 'artist' | 'album' | 'scrobbles' | 'spotifyMatch'
type MatchDirection = 'asc' | 'desc'
const defaultSortBy = 'scrobbles'
const defaultDirection = 'desc'
const matchPageSize = 100
const CHECK_WIDTH = 36
/** Room for Scrobbled names, Merge names and a Spotify search status with Review. */
const ACTIONS_WIDTH = 350
const missingSpotifyHref = `${libraryMatchesHref('track')}?${new URLSearchParams(
  {
    filters: JSON.stringify([source]),
    playability: 'unavailable',
    sortBy: defaultSortBy,
    direction: defaultDirection,
  },
)}`
const matchColumns: readonly (TableColumn & { key: MatchSort })[] = [
  { key: 'title', label: 'Track', width: 250, required: true },
  { key: 'artist', label: 'Artist', width: 160 },
  { key: 'album', label: 'Album', width: 160 },
  { key: 'scrobbles', label: 'Scrobbles', width: 90 },
  { key: 'spotifyMatch', label: 'Spotify match', width: 140 },
]
const matchStatuses: Array<{ value: MatchStatus; label: string }> = [
  { value: 'needs-match', label: 'Needs match' },
  { value: 'matched', label: 'Matched' },
]

function lastfmTrackMatchPlayability(
  statuses: readonly MatchStatus[],
): TrackPlayability {
  if (statuses.length !== 1) return 'all'
  return statuses[0] === 'matched' ? 'playable' : 'unavailable'
}

export async function loadLastfmTracksToMatch(
  apiBaseUrl: string,
  {
    q,
    statuses,
    sortBy,
    direction,
    page,
  }: {
    q: string
    statuses: readonly MatchStatus[]
    sortBy: MatchSort
    direction: MatchDirection
    page: number
  },
  signal?: AbortSignal,
) {
  const result = await loadTrackMatchDiagnosticsPage(
    apiBaseUrl,
    {
      q,
      page,
      size: matchPageSize,
      sortBy: sortBy === 'spotifyMatch' ? 'spotifyCoverage' : sortBy,
      direction,
      filters: [source],
      ranges: [],
      playability: lastfmTrackMatchPlayability(statuses),
      view: 'spotify-coverage',
    },
    signal,
  )
  const items = result.items.map(({ track, spotifyAlternate }) => {
    if (!track) throw new Error('Last.fm match result is missing a track.')
    return { track, spotifyAlternate }
  })
  return { ...result, items }
}

export function LastfmTrackMatchList() {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<MatchStatus[]>(['needs-match'])
  const [sortBy, setSortBy] = useState<MatchSort>(defaultSortBy)
  const [direction, setDirection] = useState<MatchDirection>(defaultDirection)
  const [selected, setSelected] = useState<TrackListItem | null>(null)
  const [review, setReview] = useState<TrackListItem | null>(null)
  const [matched, setMatched] = useState<{
    id: string
    kind: 'names' | 'spotify'
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [queuePending, setQueuePending] = useState(false)
  const selectAll = useRef<HTMLInputElement>(null)
  const columns = useTableColumns('lastfm-track-matches', [
    ...matchColumns,
    { key: 'actions', label: 'Actions', width: ACTIONS_WIDTH, required: true },
  ])
  const shownColumns = matchColumns.filter((column) =>
    columns.visible(column.key),
  )
  const layout = columns.layout([
    CHECK_WIDTH,
    ...shownColumns.map((column) => column.key),
    'actions',
  ])
  const playability = lastfmTrackMatchPlayability(statuses)
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  const listKey = [
    'tracks',
    'lastfm-matching',
    query,
    playability,
    sortBy,
    direction,
  ]
  const tracks = useVirtualTable({
    queryKey: listKey,
    enabled: !queuePending,
    pageSize: matchPageSize,
    loadPage: (page, _size, signal) =>
      loadLastfmTracksToMatch(
        apiBaseUrl,
        { q: query, statuses, sortBy, direction, page },
        signal,
      ),
  })
  const total = tracks.total
  const changing = tracks.isPending || draft.trim() !== query
  const unmatchedIds = tracks.loadedSlots
    .filter(
      ({ item }) =>
        !item.spotifyAlternate &&
        !spotifyTrackUri(item.track.spotifyTrackId) &&
        item.track.sources.includes('lastfm'),
    )
    .map(({ item }) => item.track.id)
  const searchStatuses = useSpotifyTrackSearchStatus(
    tracks.loadedSlots.map(({ item }) => item.track.id),
  )
  const eligibleIds = unmatchedIds.filter(
    (id) => !isActiveSpotifyTrackSearch(searchStatuses.byId.get(id)?.job),
  )
  const eligible = new Set(eligibleIds)
  const selectedForSearch = selectedIds.filter((id) => eligible.has(id))
  const checked = new Set(selectedForSearch)
  const allChecked =
    eligibleIds.length > 0 && eligibleIds.every((id) => checked.has(id))
  const selectionDisabled = changing || tracks.isError || queuePending
  const partiallyChecked = selectedForSearch.length > 0 && !allChecked
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partiallyChecked
  }, [partiallyChecked])
  function selectTracks(ids: string[]) {
    setSelectedIds(ids)
    setAnchor(null)
  }
  function sort(key: MatchSort) {
    selectTracks([])
    setDirection(sortBy === key && direction === 'desc' ? 'asc' : 'desc')
    setSortBy(key)
  }
  return (
    <ResultFeedbackScope identity={JSON.stringify(listKey)} result={tracks}>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search Last.fm tracks"
            placeholder="Search tracks, artists or albums"
            maxLength={200}
            value={draft}
            disabled={queuePending}
            onChange={(event) => {
              setDraft(event.target.value)
              selectTracks([])
            }}
          />
        }
        count={
          <>
            {total.toLocaleString()} {total === 1 ? 'track' : 'tracks'}
            <span role="status" className="sr-only">
              {changing ? 'Loading tracks…' : ''}
            </span>
          </>
        }
        columns={columns.controls}
      />
      {tracks.isError && tracks.total > 0 && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={tracks.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not load Last.fm tracks.
        </Notice>
      )}
      {searchStatuses.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={searchStatuses.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not load Spotify search status.
        </Notice>
      )}
      {selected && (
        <TrackMergePanel
          track={selected}
          namesOnly
          onClose={() => setSelected(null)}
          onMerged={(id) => setMatched({ id, kind: 'names' })}
        />
      )}
      {review && (
        <SpotifyTrackSearchReview
          track={review}
          onClose={() => setReview(null)}
          onMatched={(id) => setMatched({ id, kind: 'spotify' })}
        />
      )}
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={tracks.scroller}
          onScroll={tracks.onScroll}
          className="table-scroll-bounded"
          role="region"
          aria-label="Last.fm tracks to match"
          aria-busy={tracks.isFetching}
        >
          <table
            className="ds-table"
            aria-label="Last.fm tracks to match"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead sticky={0}>
                  <input
                    ref={selectAll}
                    type="checkbox"
                    className="ds-check"
                    aria-label="Select all loaded tracks needing a Spotify match"
                    checked={allChecked}
                    disabled={selectionDisabled || !eligibleIds.length}
                    onChange={(event) =>
                      selectTracks(event.target.checked ? eligibleIds : [])
                    }
                  />
                </TableHead>
                {shownColumns.map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    align={column.key === 'scrobbles' ? 'end' : undefined}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    disabled={queuePending}
                    sticky={column.key === 'title' ? CHECK_WIDTH : undefined}
                    stickyEdge={column.key === 'title'}
                    filter={
                      column.key === 'spotifyMatch' ? (
                        <SecondaryColumnFilter
                          label="Match status"
                          options={matchStatuses}
                          value={statuses}
                          disabled={queuePending}
                          onChange={(next) => {
                            selectTracks([])
                            setStatuses(next)
                          }}
                        />
                      ) : undefined
                    }
                    resizer={columns.resizer(column.key)}
                  />
                ))}
                <TableHead resizer={columns.resizer('actions')}>
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!tracks.total && (
                <TableState colSpan={columns.count + 1} error={tracks.isError}>
                  {tracks.isPending
                    ? 'Loading Last.fm tracks...'
                    : tracks.isError
                      ? 'Could not load Last.fm tracks.'
                      : 'No matching Last.fm tracks.'}
                  {tracks.isError && (
                    <ReadButton size="xs" variant="link" read={tracks.retry}>
                      Retry
                    </ReadButton>
                  )}
                </TableState>
              )}
              {(!tracks.isError || tracks.hasTotal) && (
                <SecondaryVirtualRows
                  window={tracks}
                  colSpan={columns.count + 1}
                  renderRow={({ track, spotifyAlternate }) => {
                    const playable = playableMatchTrack(track, spotifyAlternate)
                    const spotifyUri = spotifyTrackUri(playable.spotifyTrackId)
                    const spotifyUrl = spotifyWebUrl(spotifyUri ?? null)
                    const matchLabel = spotifyAlternate
                      ? 'Other Spotify version'
                      : trackSpotifyMatchLabels[
                          spotifyUri ? track.spotifyMatch : 'unmatched'
                        ]
                    const search = searchStatuses.byId.get(track.id)
                    return (
                      <TableRow
                        key={track.id}
                        data-selected={
                          checked.has(track.id) ||
                          selected?.id === track.id ||
                          review?.id === track.id ||
                          undefined
                        }
                      >
                        <TableCell sticky={0}>
                          <input
                            type="checkbox"
                            className="ds-check"
                            aria-label={`Select ${track.title} for Spotify search`}
                            checked={checked.has(track.id)}
                            disabled={
                              selectionDisabled || !eligible.has(track.id)
                            }
                            onChange={(event) => {
                              setSelectedIds(
                                updateJobSelection(
                                  selectedForSearch,
                                  eligibleIds,
                                  track.id,
                                  anchor,
                                  'shiftKey' in event.nativeEvent &&
                                    event.nativeEvent.shiftKey === true,
                                  event.target.checked,
                                ),
                              )
                              setAnchor(track.id)
                            }}
                          />
                        </TableCell>
                        <TableCell sticky={CHECK_WIDTH} stickyEdge>
                          <div className="secondary-cell-actions">
                            <LibraryTrackInlinePlayButtons track={playable} />
                            <SecondaryCell text={track.title}>
                              <DetailLink kind="track" id={track.id}>
                                {track.title}
                              </DetailLink>
                            </SecondaryCell>
                            <ServiceIconLinks
                              links={trackServiceLinks({
                                ...track,
                                spotifyUrl,
                              })}
                            />
                          </div>
                        </TableCell>
                        {columns.visible('artist') && (
                          <TableCell>
                            <SecondaryCell text={track.artists.join(', ')}>
                              {track.artists.join(', ') || '-'}
                            </SecondaryCell>
                          </TableCell>
                        )}
                        {columns.visible('album') && (
                          <TableCell>
                            <SecondaryCell text={track.albumName ?? '-'}>
                              {track.albumName ?? '-'}
                            </SecondaryCell>
                          </TableCell>
                        )}
                        {columns.visible('scrobbles') && (
                          <TableCell align="end" className="ds-num">
                            {formatCount(track.scrobbles)}
                          </TableCell>
                        )}
                        {columns.visible('spotifyMatch') && (
                          <TableCell>
                            <SecondaryCell text={matchLabel}>
                              {spotifyAlternate ? (
                                <DetailLink
                                  kind="track"
                                  id={spotifyAlternate.trackId}
                                  tab="sources"
                                >
                                  {matchLabel}
                                </DetailLink>
                              ) : (
                                matchLabel
                              )}
                            </SecondaryCell>
                          </TableCell>
                        )}
                        <TableCell>
                          <div className="secondary-cell-actions">
                            <Button size="xs" variant="ghost" asChild>
                              <DetailLink
                                kind="track"
                                id={track.id}
                                tab="sources"
                              >
                                Scrobbled names
                              </DetailLink>
                            </Button>
                            {track.sources.includes('lastfm') && (
                              <Button
                                size="xs"
                                aria-label={`Merge Last.fm names for ${track.title}`}
                                aria-haspopup="dialog"
                                disabled={selectionDisabled}
                                onClick={() => {
                                  setMatched(null)
                                  setSelected(track)
                                }}
                              >
                                Merge names
                              </Button>
                            )}
                            {(search?.job || search?.interactive) && (
                              <SpotifyTrackSearchJobCell
                                job={search.job}
                                interactive={search.interactive}
                                disabled={selectionDisabled}
                                onReview={() => {
                                  setMatched(null)
                                  setReview(track)
                                }}
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  }}
                />
              )}
            </TableBody>
          </table>
        </SecondaryTableScroll>
        <SpotifyTrackSearchSelectionBar
          selectedIds={selectedForSearch}
          onSelect={selectTracks}
          onPendingChange={setQueuePending}
          disabled={selectionDisabled}
        />
      </SecondaryTableFrame>
      {matched && (
        <p role="status" className="ds-muted">
          {matched.kind === 'spotify'
            ? 'Spotify track linked.'
            : 'Last.fm names merged.'}{' '}
          <DetailLink kind="track" id={matched.id} tab="sources">
            Open track
          </DetailLink>
        </p>
      )}
    </ResultFeedbackScope>
  )
}

export async function loadLastfmTrackMatchCounts(
  apiBaseUrl: string,
  signal?: AbortSignal,
) {
  async function count(playability: TrackPlayability) {
    const result = await loadTrackMatchDiagnosticsPage(
      apiBaseUrl,
      {
        page: 1,
        size: 1,
        sortBy: defaultSortBy,
        direction: defaultDirection,
        filters: [source],
        ranges: [],
        playability,
        view: 'spotify-coverage',
      },
      signal,
    )
    return result.totalCount
  }
  const [total, withoutSpotify] = await Promise.all([
    count('all'),
    count('unavailable'),
  ])
  return { total, withoutSpotify }
}

export default function LastfmTrackMatches() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const status = useLastfmSyncStatus()
  const counts = useQuery({
    queryKey: ['tracks', 'lastfm-match-counts'],
    queryFn: ({ signal }) => loadLastfmTrackMatchCounts(apiBaseUrl, signal),
  })
  const refresh = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  return (
    <section className="data-stack" aria-label="Last.fm track matches">
      <h2>Track matches</h2>
      {counts.isPending ? (
        <Skeleton height={40} width="50%" />
      ) : !counts.data ? (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => counts.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Could not load track matches.
        </Notice>
      ) : (
        <Stats
          items={[
            {
              label: 'Last.fm tracks in library',
              value: (
                <Link href={tracksHref([source])}>
                  {formatCount(counts.data.total)}
                </Link>
              ),
            },
            {
              label: 'No Spotify match',
              value: (
                <Link href={missingSpotifyHref}>
                  {formatCount(counts.data.withoutSpotify)}
                </Link>
              ),
            },
          ]}
        />
      )}
      <p className="ds-muted">
        Needs match shows tracks without a usable Spotify ID or a verified
        Spotify version in your library. Spotify matches can reuse recordings
        from stored album track lists, playlists or Liked Songs. Open Scrobbled
        names to add, move or remove a name. Merge names moves all recorded
        names to another track.
      </p>
      <span className="ds-actions">
        <Button
          disabled={
            !status.data?.configured ||
            !status.data.storedScrobbles ||
            refresh.isPending ||
            status.data.state === 'running'
          }
          onClick={() => refresh.mutate()}
          feedback={mutationFeedback(refresh, {
            pending: 'Refreshing matches…',
            success: 'Matches updated',
            error: 'Could not refresh matches',
          })}
        >
          Refresh matches
        </Button>
      </span>
      <p className="ds-muted">
        Use stored history to update matches after library metadata changes.
        This makes no Last.fm or Spotify requests.
      </p>
      {refresh.isError && (
        <Notice tone="danger">
          {errorMessage(refresh.error, 'Could not refresh track matches.')}
        </Notice>
      )}
      <LastfmTrackMatchList />
    </section>
  )
}
