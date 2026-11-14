'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { BrowseFilter } from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  TrackListItemSchema,
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type TrackListItem,
} from '@repo/schemas/tracks'
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
import { fetchApiData } from '@/utils/api'
import { tracksHref } from '@/utils/track-browse'
import { trackServiceLinks } from '@/utils/track-links'
import {
  errorMessage,
  refreshScrobbleLinks,
  useLastfmSyncStatus,
} from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { canMergeLastfmTrack, TrackMergePanel } from './track-merge'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

const source: BrowseFilter = {
  field: 'source',
  value: trackSourceLabels.lastfm,
  mode: 'required',
}
const unmatched: BrowseFilter = {
  field: 'spotifyMatch',
  value: trackSpotifyMatchLabels.unmatched,
  mode: 'required',
}
const TrackPageSchema = PaginatedDataSchema(TrackListItemSchema)
type MatchStatus = 'needs-match' | 'matched'
type MatchSort = 'title' | 'artist' | 'album' | 'scrobbles' | 'spotifyMatch'
type MatchDirection = 'asc' | 'desc'
const matchColumns: readonly (TableColumn & { key: MatchSort })[] = [
  { key: 'title', label: 'Track', required: true },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'scrobbles', label: 'Scrobbles' },
  { key: 'spotifyMatch', label: 'Spotify match' },
]
const matchStatuses: Array<{ value: MatchStatus; label: string }> = [
  { value: 'needs-match', label: 'Needs match' },
  { value: 'matched', label: 'Matched' },
]

/** Album-derived playback IDs still need a stored Spotify recording to merge into. */
export function lastfmTrackMatchFilters(
  statuses: readonly MatchStatus[],
): BrowseFilter[] {
  if (statuses.length !== 1) return [source]
  return [
    source,
    {
      field: 'spotifyMatch',
      value: trackSpotifyMatchLabels['spotify-import'],
      mode: statuses[0] === 'matched' ? 'required' : 'exclude',
    },
  ]
}

export function loadLastfmTracksToMatch(
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
  const params = new URLSearchParams({
    q,
    page: String(page),
    size: '100',
    sortBy,
    direction,
    filters: JSON.stringify(lastfmTrackMatchFilters(statuses)),
  })
  return fetchApiData(apiBaseUrl, `/api/v1/tracks?${params}`, TrackPageSchema, {
    signal,
  })
}

export function LastfmTrackMatchList() {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<MatchStatus[]>(['needs-match'])
  const [sortBy, setSortBy] = useState<MatchSort>('scrobbles')
  const [direction, setDirection] = useState<MatchDirection>('desc')
  const [selected, setSelected] = useState<TrackListItem | null>(null)
  const [matchedId, setMatchedId] = useState<string | null>(null)
  const columns = useTableColumns('lastfm-track-matches', [
    ...matchColumns,
    { key: 'actions', label: 'Actions', required: true },
  ])
  const statusesKey = JSON.stringify(statuses)
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  const tracks = useInfiniteQuery({
    queryKey: [
      'tracks',
      'lastfm-matching',
      query,
      statusesKey,
      sortBy,
      direction,
    ],
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) =>
      loadLastfmTracksToMatch(
        apiBaseUrl,
        { q: query, statuses, sortBy, direction, page: pageParam },
        signal,
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: tracks.hasNextPage && !tracks.isFetching && !tracks.isError,
    fetchNextPage: tracks.fetchNextPage,
    resetKey: JSON.stringify([query, statusesKey, sortBy, direction]),
  })
  const items = tracks.data?.pages.flatMap((page) => page.items) ?? []
  const total = tracks.data?.pages[0]?.totalCount ?? 0
  const changing = tracks.isPlaceholderData || draft.trim() !== query
  function sort(key: MatchSort) {
    setDirection(sortBy === key && direction === 'desc' ? 'asc' : 'desc')
    setSortBy(key)
  }
  return (
    <>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search Last.fm tracks"
            placeholder="Search tracks, artists or albums"
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        }
        count={
          <>
            {total.toLocaleString()} {total === 1 ? 'track' : 'tracks'}
            {changing && <span role="status"> · Loading...</span>}
          </>
        }
        columns={columns.controls}
      />
      {matchedId && (
        <p role="status" className="muted">
          Track matched.{' '}
          <Link href={`/tracks/${encodeURIComponent(matchedId)}`}>
            Open track
          </Link>
        </p>
      )}
      {tracks.isError && items.length > 0 && !tracks.isFetchNextPageError && (
        <p role="alert">
          Could not load Last.fm tracks.{' '}
          <button type="button" onClick={() => tracks.refetch()}>
            Retry
          </button>
        </p>
      )}
      {selected && (
        <TrackMergePanel
          track={selected}
          onClose={() => setSelected(null)}
          onMerged={setMatchedId}
        />
      )}
      <SecondaryTableScroll
        ref={scroller}
        className="table-scroll-bounded"
        role="region"
        aria-label="Last.fm tracks to match"
        aria-busy={tracks.isFetching}
      >
        <table className="compact-table" aria-label="Last.fm tracks to match">
          <TableHeader>
            <TableRow>
              {matchColumns
                .filter((column) => columns.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    filter={
                      column.key === 'spotifyMatch' ? (
                        <SecondaryColumnFilter
                          label="Match status"
                          options={matchStatuses}
                          value={statuses}
                          onChange={setStatuses}
                        />
                      ) : undefined
                    }
                  />
                ))}
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!items.length && (
              <TableState colSpan={columns.count} error={tracks.isError}>
                {tracks.isPending
                  ? 'Loading Last.fm tracks...'
                  : tracks.isError
                    ? 'Could not load Last.fm tracks.'
                    : 'No matching Last.fm tracks.'}
                {tracks.isError && (
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => tracks.refetch()}
                  >
                    Retry
                  </button>
                )}
              </TableState>
            )}
            {items.map((track) => (
              <TableRow
                key={track.id}
                data-selected={selected?.id === track.id || undefined}
              >
                <TableCell>
                  <div className="secondary-cell-actions">
                    <SecondaryCell text={track.title}>
                      <Link href={`/tracks/${encodeURIComponent(track.id)}`}>
                        {track.title}
                      </Link>
                    </SecondaryCell>
                    <ServiceIconLinks links={trackServiceLinks(track)} />
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
                  <TableCell className="tabular-nums">
                    {track.scrobbles.toLocaleString()}
                  </TableCell>
                )}
                {columns.visible('spotifyMatch') && (
                  <TableCell>
                    <SecondaryCell
                      text={trackSpotifyMatchLabels[track.spotifyMatch]}
                    >
                      {trackSpotifyMatchLabels[track.spotifyMatch]}
                    </SecondaryCell>
                  </TableCell>
                )}
                <TableCell>
                  {canMergeLastfmTrack(track) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="secondary-cell-action"
                      aria-label={`Match ${track.title}`}
                      title={`Match ${track.title}`}
                      aria-haspopup="dialog"
                      disabled={changing || tracks.isError}
                      onClick={() => {
                        setMatchedId(null)
                        setSelected(track)
                      }}
                    >
                      <Link2 size={14} aria-hidden="true" />
                    </Button>
                  ) : (
                    <Link href={`/tracks/${encodeURIComponent(track.id)}`}>
                      Open track
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {tracks.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more tracks...
            </p>
          )}
          {tracks.isFetchNextPageError && (
            <p role="alert">Could not load more tracks.</p>
          )}
          {tracks.hasNextPage && !tracks.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={tracks.isFetching}
              onClick={() => tracks.fetchNextPage({ cancelRefetch: false })}
            >
              {tracks.isFetchNextPageError
                ? 'Retry loading tracks'
                : 'Load more tracks'}
            </Button>
          )}
        </div>
      </SecondaryTableScroll>
    </>
  )
}

export async function loadLastfmTrackMatchCounts(apiBaseUrl: string) {
  async function count(filters: BrowseFilter[]) {
    const params = new URLSearchParams({
      size: '1',
      filters: JSON.stringify(filters),
    })
    const result = await fetchApiData(
      apiBaseUrl,
      `/api/v1/tracks?${params}`,
      PaginatedDataSchema(TrackListItemSchema),
    )
    return result.totalCount
  }
  const [total, withoutSpotify] = await Promise.all([
    count([source]),
    count([source, unmatched]),
  ])
  return { total, withoutSpotify }
}

export default function LastfmTrackMatches() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const status = useLastfmSyncStatus()
  const counts = useQuery({
    queryKey: ['tracks', 'lastfm-match-counts'],
    queryFn: () => loadLastfmTrackMatchCounts(apiBaseUrl),
  })
  const refresh = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  return (
    <section
      className="film-import-workflow"
      aria-label="Last.fm track matches"
    >
      <h2>Track matches</h2>
      {counts.isPending ? (
        <p role="status">Loading track matches...</p>
      ) : !counts.data ? (
        <p role="alert">
          Could not load track matches.{' '}
          <Button variant="ghost" size="sm" onClick={() => counts.refetch()}>
            Retry
          </Button>
        </p>
      ) : (
        <dl className="detail-metrics">
          <div>
            <dt>Last.fm tracks in library</dt>
            <dd>
              <Link href={tracksHref([source])}>
                {counts.data.total.toLocaleString()}
              </Link>
            </dd>
          </div>
          <div>
            <dt>No Spotify match</dt>
            <dd>
              <Link href={tracksHref([source, unmatched])}>
                {counts.data.withoutSpotify.toLocaleString()}
              </Link>
            </dd>
          </div>
        </dl>
      )}
      <p className="muted">
        Spotify links come from existing Spotify imports or a unique title in
        the linked album’s stored track list. Open a track to see which applies
        and the names recorded by Last.fm. Spotify has not been searched for
        unmatched tracks.
      </p>
      <div className="form-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={
            !status.data?.configured ||
            !status.data.storedScrobbles ||
            refresh.isPending ||
            status.data.state === 'running'
          }
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Refreshing...' : 'Refresh matches'}
        </Button>
      </div>
      <p className="muted">
        Use stored history to update matches after library metadata changes.
        This makes no Last.fm or Spotify requests.
      </p>
      {refresh.isSuccess && <p role="status">Track matches refreshed.</p>}
      {refresh.isError && (
        <p role="alert">
          {errorMessage(refresh.error, 'Could not refresh track matches.')}
        </p>
      )}
      <LastfmTrackMatchList />
    </section>
  )
}
