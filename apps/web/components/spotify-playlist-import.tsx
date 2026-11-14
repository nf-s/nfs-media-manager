'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  PlaylistSummarySchema,
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
  type PlaylistSummary,
  type SpotifyPlaylist,
  type SpotifyPlaylistImportInput,
  type SpotifyPlaylistJob,
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
import { useConfig } from './providers'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { sortTableRows } from '@/utils/secondary-table'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import AllowPlaylistChanges from './spotify-playlist-changes'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import {
  formatPlaylistDuration,
  invalidatePlaylists,
  playlistJobActive,
  playlistJobLabels,
  playlistJobProgress,
} from '@/utils/playlist-sync'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'
import { spotifyCallbackSetup } from '@/utils/spotify-setup'
import { youtubeScheduleLabels } from '@/utils/youtube'

type JobLabels = Record<SpotifyPlaylistJob['status'], string>

const listingLabels: JobLabels = {
  queued: 'Queued',
  running: 'Listing',
  succeeded: 'Listed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export type ImportPlaylistSortKey =
  | 'name'
  | 'owner'
  | 'tracks'
  | 'status'
  | 'schedule'
  | 'checked'
  | 'added'
  | 'imported'
  | 'storedTracks'
  | 'linkedTracks'
  | 'albums'
  | 'duration'
  | 'current'
  | 'importable'
  | 'nextSync'
  | 'description'

type ImportColumn = TableColumn &
  (
    | { key: ImportPlaylistSortKey; sortable: true }
    | { key: 'selection' | 'artwork'; sortable: false }
  )

const importColumns: readonly ImportColumn[] = [
  { key: 'selection', sortable: false, label: 'Selection', required: true },
  { key: 'artwork', sortable: false, label: 'Artwork' },
  { key: 'name', sortable: true, label: 'Playlist', required: true },
  { key: 'owner', sortable: true, label: 'Owner' },
  { key: 'tracks', sortable: true, label: 'Tracks' },
  { key: 'status', sortable: true, label: 'Import' },
  { key: 'schedule', sortable: true, label: 'Schedule' },
  { key: 'checked', sortable: true, label: 'Last checked' },
  { key: 'added', sortable: true, label: 'Added to library' },
  {
    key: 'imported',
    sortable: true,
    label: 'Last imported',
    defaultVisible: false,
  },
  {
    key: 'storedTracks',
    sortable: true,
    label: 'Imported tracks',
    defaultVisible: false,
  },
  {
    key: 'linkedTracks',
    sortable: true,
    label: 'In album library',
    defaultVisible: false,
  },
  { key: 'albums', sortable: true, label: 'Albums', defaultVisible: false },
  { key: 'duration', sortable: true, label: 'Duration', defaultVisible: false },
  {
    key: 'current',
    sortable: true,
    label: 'Up to date',
    defaultVisible: false,
  },
  {
    key: 'importable',
    sortable: true,
    label: 'Importable',
    defaultVisible: false,
  },
  {
    key: 'nextSync',
    sortable: true,
    label: 'Next import',
    defaultVisible: false,
  },
  {
    key: 'description',
    sortable: true,
    label: 'Description',
    defaultVisible: false,
  },
]

export function importPlaylistSortValue(
  playlist: SpotifyPlaylist,
  summary: PlaylistSummary | undefined,
  key: ImportPlaylistSortKey,
) {
  switch (key) {
    case 'name':
      return playlist.name
    case 'owner':
      return playlist.ownerName
    case 'tracks':
      return playlist.trackTotal
    case 'status':
      return playlist.job && playlist.job.status !== 'succeeded'
        ? playlistJobLabels[playlist.job.status]
        : playlist.stored
          ? 'Imported'
          : 'Not imported'
    case 'schedule':
      return summary?.sync.syncable
        ? youtubeScheduleLabels[summary.sync.schedule]
        : null
    case 'checked':
      return summary?.sync.lastCheckedAt
        ? Date.parse(summary?.sync.lastCheckedAt)
        : null
    case 'added':
      return summary?.createdAt ? Date.parse(summary?.createdAt) : null
    case 'imported':
      return playlist.stored?.importedAt
        ? Date.parse(playlist.stored?.importedAt)
        : null
    case 'storedTracks':
      return playlist.stored?.trackCount
    case 'linkedTracks':
      return summary?.linkedTrackCount
    case 'albums':
      return summary?.albumCount
    case 'duration':
      return summary?.durationSec
    case 'current':
      return playlist.stored ? playlist.current : null
    case 'importable':
      return playlist.importable && cannotImportReason(playlist) === null
    case 'nextSync':
      return summary?.sync.nextScheduledAt
        ? Date.parse(summary?.sync.nextScheduledAt)
        : null
    case 'description':
      return summary?.description
    default:
      return null
  }
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

function tracksLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'track' : 'tracks'}`
}

/** The playlist drawer on the Playlists page. */
function playlistDrawerHref(playlistId: string, tab?: 'sync') {
  const params = new URLSearchParams({ playlist: playlistId })
  if (tab) params.set('tab', tab)
  return `/playlists?${params}`
}

function jobHref(job: SpotifyPlaylistJob) {
  return scopedHref(`/jobs?jobId=${encodeURIComponent(job.jobId)}`, 'album')
}

/** Refreshes the stored list and everything an import changes. */
function invalidateImportedPlaylists(client: QueryClient) {
  return Promise.all([
    invalidatePlaylists(client),
    client.invalidateQueries({ queryKey: ['spotify-playlists'] }),
  ])
}

function JobStatus({
  job,
  labels,
}: {
  job: SpotifyPlaylistJob
  labels: JobLabels
}) {
  return (
    <Link
      className="job-status underline underline-offset-2"
      data-status={job.status}
      href={jobHref(job)}
      title={job.errorMessage ?? undefined}
    >
      {labels[job.status]}
    </Link>
  )
}

/** Status, page progress and failure message of a playlist job. */
function JobState({
  job,
  labels,
}: {
  job: SpotifyPlaylistJob
  labels: JobLabels
}) {
  const progress = playlistJobActive(job)
    ? playlistJobProgress(job.progress)
    : null
  return (
    <>
      <JobStatus job={job} labels={labels} />
      {progress && <span className="muted"> {progress}</span>}
      {job.status === 'failed' && job.errorMessage && (
        <span className="block whitespace-normal">{job.errorMessage}</span>
      )}
    </>
  )
}

function storedLabel(stored: NonNullable<SpotifyPlaylist['stored']>) {
  return `Imported ${formatDateTime(stored.importedAt)} · ${tracksLabel(stored.trackCount)}`
}

function ImportState({ playlist }: { playlist: SpotifyPlaylist }) {
  const { job, stored } = playlist
  const showJob = job && job.status !== 'succeeded'
  const reason = cannotImportReason(playlist)
  return (
    <>
      {showJob && <JobState job={job} labels={playlistJobLabels} />}
      {!playlistJobActive(job) &&
        (stored ? (
          <span className={showJob ? 'muted block' : undefined}>
            {storedLabel(stored)}
            {!playlist.current && ' · Changed on Spotify'}
          </span>
        ) : (
          !showJob && 'Not imported'
        ))}
      {reason && (
        <span className="muted block whitespace-normal">{reason}</span>
      )}
    </>
  )
}

function ScheduleCell({ summary }: { summary: PlaylistSummary | undefined }) {
  if (!summary?.sync.syncable) return <>-</>
  const { schedule, nextScheduledAt } = summary.sync
  return (
    <Link
      className="underline underline-offset-2"
      href={playlistDrawerHref(summary.id, 'sync')}
      title={
        nextScheduledAt
          ? `Next import ${formatDateTime(nextScheduledAt)}`
          : undefined
      }
    >
      {youtubeScheduleLabels[schedule]}
    </Link>
  )
}

function overItemLimit(playlist: SpotifyPlaylist) {
  return playlist.trackTotal > SPOTIFY_PLAYLIST_ITEM_LIMIT
}

function cannotImportReason(playlist: SpotifyPlaylist) {
  if (playlist.notImportableReason) return playlist.notImportableReason
  if (overItemLimit(playlist))
    return `Over ${SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString()} tracks, cannot be imported.`
  return null
}

function importsActive(
  imports: z.infer<typeof SpotifyPlaylistImportsSchema> | undefined,
) {
  return imports
    ? playlistJobActive(imports.likedSongs.job) ||
        Object.values(imports.jobs).some(playlistJobActive)
    : false
}

/** Playlists Spotify returns tracks for, within the item limit, with no import in progress. */
function selectable(playlist: SpotifyPlaylist) {
  return (
    playlist.importable &&
    cannotImportReason(playlist) === null &&
    !playlistJobActive(playlist.job)
  )
}

export default function SpotifyPlaylistImport() {
  const { apiBaseUrl, appUrl } = useConfig()
  const client = useQueryClient()
  const outcome = useSearchParams().get('spotify')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<ImportPlaylistSortKey>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const columns = useTableColumns('spotify-playlist-import', importColumns)
  function onSort(key: ImportPlaylistSortKey) {
    if (key === sortBy) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setDirection('asc')
    }
  }
  const sorting = { sortBy, direction, onSort }
  const [selected, setSelected] = useState<string[]>([])
  const [confirmedKey, setConfirmedKey] = useState('')
  const account = useQuery({
    queryKey: ['spotify-account'],
    staleTime: 0,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
      ),
  })
  const status = account.data
  const ready = Boolean(status?.connected && status.playlists)
  const imports = useQuery({
    queryKey: ['spotify-playlist-imports'],
    staleTime: 0,
    refetchInterval: (query) =>
      importsActive(query.state.data) ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists/imports',
        SpotifyPlaylistImportsSchema,
      ),
  })
  // The stored list; reading it makes no Spotify request.
  const listing = useQuery({
    queryKey: ['spotify-playlists'],
    enabled: ready,
    staleTime: 0,
    refetchInterval: (query) =>
      playlistJobActive(query.state.data?.job) ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists',
        SpotifyPlaylistListSchema,
      ),
  })
  const library = useQuery({
    queryKey: ['playlists'],
    enabled: ready,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/playlists',
        z.array(PlaylistSummarySchema),
      ),
  })
  const authorize = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playlists: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const list = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists',
        SpotifyPlaylistListSchema,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: (data) => client.setQueryData(['spotify-playlists'], data),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  const queue = useMutation({
    mutationFn: (request: SpotifyPlaylistImportInput) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists/import',
        EnrichmentResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(SpotifyPlaylistImportInputSchema.parse(request)),
        },
      ),
    onSuccess: (_result, request) => {
      if (!request.likedSongs) {
        setSelected([])
        setConfirmedKey('')
      }
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['spotify-playlist-imports'] }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })

  const active = importsActive(imports.data)
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) void invalidateImportedPlaylists(client)
    wasActive.current = active
  }, [active, client])

  const listingJob = listing.data?.job ?? null
  const listingActive = playlistJobActive(listingJob)
  const wasListing = useRef(listingActive)
  useEffect(() => {
    if (wasListing.current && !listingActive)
      void Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    wasListing.current = listingActive
  }, [listingActive, client])

  const setup = spotifyCallbackSetup(
    apiBaseUrl,
    appUrl,
    status?.redirectUri ?? null,
  )
  const summaries = new Map(
    (library.data ?? []).map((summary) => [summary.id, summary]),
  )
  const summaryOf = (playlistId: string | undefined) =>
    playlistId ? summaries.get(playlistId) : undefined
  const playlists = (listing.data?.playlists ?? []).map((playlist) => ({
    ...playlist,
    job: imports.data?.jobs[playlist.spotifyId] ?? playlist.job,
  }))
  const term = search.trim().toLocaleLowerCase()
  const filtered = term
    ? playlists.filter((playlist) =>
        playlist.name.toLocaleLowerCase().includes(term),
      )
    : playlists
  const visible = sortTableRows(
    filtered,
    { key: sortBy, direction },
    (playlist, key) =>
      importPlaylistSortValue(
        playlist,
        summaryOf(playlist.stored?.playlistId),
        key,
      ),
  )
  const targets = playlists.filter(
    (playlist) => selected.includes(playlist.spotifyId) && selectable(playlist),
  )
  const confirmationKey = JSON.stringify(
    targets.map((playlist) => playlist.spotifyId),
  )
  const broad = targets.length > 5
  const confirmed = confirmedKey === confirmationKey
  const tooMany = targets.length > 100
  const liked = imports.data?.likedSongs
  const likedSummary = summaryOf(liked?.stored?.playlistId)
  const likedResult = queue.variables?.likedSongs === true
  const listedAt = listing.data?.listedAt ?? null
  const result = queue.data && (
    <div role="status">
      {queue.data.queued} queued · {queue.data.skipped} skipped.{' '}
      <Link
        href={scopedHref(
          `/jobs?batchId=${encodeURIComponent(queue.data.batchId)}`,
          'album',
        )}
      >
        View import jobs
      </Link>
      {queue.data.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  )
  const queueError = queue.isError && (
    <p role="alert">
      {errorMessage(queue.error, 'Could not queue the import.')}
    </p>
  )

  return (
    <section className="film-import-workflow table-workspace">
      {account.isPending && (
        <p className="muted">Loading Spotify connection...</p>
      )}
      {account.isError && (
        <p role="alert">
          Could not load Spotify connection.{' '}
          <button onClick={() => account.refetch()}>Retry</button>
        </p>
      )}
      {outcome === 'error' && (
        <p role="alert">
          Spotify connection was not completed. Try connecting again.
        </p>
      )}
      {outcome === 'connected' && ready && (
        <p role="status" className="muted">
          Spotify connected.
        </p>
      )}
      {status && !status.configured && (
        <p role="alert">
          Configure Client ID and Redirect URI in{' '}
          <Link href="/providers?provider=spotify&mediaType=album">
            Spotify provider settings
          </Link>
          .
        </p>
      )}
      {status && !ready && (
        <>
          {setup && (
            <details>
              <summary>Spotify connection setup</summary>
              <p>
                Register this exact Redirect URI in your{' '}
                <a
                  href="https://developer.spotify.com/dashboard"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Spotify developer app
                </a>
                :
              </p>
              <code className="block break-all">{setup.callbackUrl}</code>
              <p className="muted">
                Keep using this app address. The callback returns to your
                signed-in session automatically.
              </p>
            </details>
          )}
          {status.configured && (
            <p className="muted">
              {status.connected
                ? 'The Spotify connection does not include playlist access. Reconnect to grant it.'
                : 'Playlist import needs a Spotify connection with playlist access.'}
            </p>
          )}
          <div className="form-actions">
            <Button
              disabled={!status.configured || authorize.isPending}
              onClick={() => authorize.mutate()}
            >
              {authorize.isPending
                ? 'Connecting...'
                : status.connected
                  ? 'Reconnect Spotify'
                  : 'Connect Spotify'}
            </Button>
          </div>
          {authorize.isError && (
            <p role="alert">
              {errorMessage(authorize.error, 'Could not start the connection.')}
            </p>
          )}
        </>
      )}
      {ready && !status?.playlistChanges && (
        <div className="form-actions">
          <span className="muted">
            Adding albums to playlists needs playlist change access.
          </span>
          <AllowPlaylistChanges />
        </div>
      )}
      {ready && (
        <section aria-labelledby="liked-songs-heading">
          <h2 id="liked-songs-heading">Liked Songs</h2>
          {imports.isPending && (
            <p className="muted">Loading import state...</p>
          )}
          {imports.isError && (
            <p role="alert">
              Could not load import state.{' '}
              <button onClick={() => imports.refetch()}>Retry</button>
            </p>
          )}
          {liked !== undefined && (
            <div className="form-actions">
              {liked.job && liked.job.status !== 'succeeded' && (
                <span>
                  <JobState job={liked.job} labels={playlistJobLabels} />
                </span>
              )}
              {!playlistJobActive(liked.job) && (
                <span>
                  {liked.stored ? storedLabel(liked.stored) : 'Not imported'}
                </span>
              )}
              {likedSummary?.sync.syncable && (
                <span>
                  Schedule: <ScheduleCell summary={likedSummary} />
                  {likedSummary.sync.lastCheckedAt &&
                    ` · Last checked ${formatDateTime(likedSummary.sync.lastCheckedAt)}`}
                </span>
              )}
              <Button
                size="sm"
                disabled={queue.isPending || playlistJobActive(liked.job)}
                onClick={() =>
                  queue.mutate({
                    playlists: [],
                    likedSongs: true,
                    confirmBroadRun: false,
                  })
                }
              >
                {liked.stored ? 'Import again' : 'Import'}
              </Button>
            </div>
          )}
          {likedResult && result}
          {likedResult && queueError}
        </section>
      )}
      {ready && (
        <>
          <h2>Playlists</h2>
          <div className="form-actions">
            <Button
              size="sm"
              variant={listedAt ? 'outline' : 'default'}
              disabled={listingActive || list.isPending || listing.isPending}
              onClick={() => list.mutate()}
            >
              {list.isPending
                ? 'Queueing...'
                : listedAt
                  ? 'List again'
                  : 'List playlists'}
            </Button>
            {listingJob && listingActive ? (
              <span>
                <JobState job={listingJob} labels={listingLabels} />
              </span>
            ) : (
              listing.data && (
                <span className="muted">
                  {listedAt
                    ? `Listed ${formatDateTime(listedAt)}`
                    : 'Reads the playlist list from Spotify; nothing is imported.'}
                </span>
              )
            )}
          </div>
          {list.isError && (
            <p role="alert">
              {errorMessage(list.error, 'Could not list playlists.')}
            </p>
          )}
          {listingJob &&
            (listingJob.status === 'failed' ||
              listingJob.status === 'cancelled') && (
              <p role="alert">
                The last listing{' '}
                {listingJob.status === 'failed' ? 'failed' : 'was cancelled'}
                {listingJob.errorMessage
                  ? `: ${listingJob.errorMessage}`
                  : '.'}{' '}
                <Link href={jobHref(listingJob)}>View job</Link>
              </p>
            )}
          <div className="job-selection-toolbar">
            {columns.controls}
            <Input
              aria-label="Filter playlists"
              placeholder="Filter playlists..."
              className="h-7 w-56 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span>
              {visible.length.toLocaleString()} of{' '}
              {playlists.length.toLocaleString()} playlists · {targets.length}{' '}
              selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={queue.isPending || !visible.some(selectable)}
              onClick={() =>
                setSelected([
                  ...new Set([
                    ...selected,
                    ...visible
                      .filter(selectable)
                      .map((playlist) => playlist.spotifyId),
                  ]),
                ])
              }
            >
              Select all importable
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={queue.isPending || !selected.length}
              onClick={() => {
                setSelected([])
                setConfirmedKey('')
              }}
            >
              Clear
            </Button>
            {broad && !tooMany && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={queue.isPending}
                  onChange={(event) =>
                    setConfirmedKey(event.target.checked ? confirmationKey : '')
                  }
                />
                Confirm {targets.length} playlist imports
              </label>
            )}
            <Button
              size="sm"
              disabled={
                queue.isPending ||
                !targets.length ||
                tooMany ||
                (broad && !confirmed)
              }
              onClick={() =>
                queue.mutate({
                  playlists: targets.map(({ spotifyId, name }) => ({
                    spotifyId,
                    name,
                  })),
                  likedSongs: false,
                  confirmBroadRun: broad && confirmed,
                })
              }
            >
              {queue.isPending && !likedResult
                ? 'Queueing...'
                : 'Import selected'}
            </Button>
            {tooMany && (
              <span role="alert">Import up to 100 playlists at a time.</span>
            )}
          </div>
          {!likedResult && result}
          {!likedResult && queueError}
          <SecondaryTableScroll
            className="tags-scroll"
            role="region"
            aria-label="Spotify playlists"
            aria-busy={listing.isFetching}
          >
            <table className="compact-table" aria-label="Spotify playlists">
              <TableHeader>
                <TableRow>
                  {importColumns
                    .filter((column) => columns.visible(column.key))
                    .map((column) =>
                      !column.sortable ? (
                        <TableHead
                          key={column.key}
                          className={
                            column.key === 'selection'
                              ? 'table-selection-cell'
                              : undefined
                          }
                        >
                          <span className="sr-only">{column.label}</span>
                        </TableHead>
                      ) : (
                        <SecondaryTableHead
                          key={column.key}
                          sortKey={column.key}
                          label={column.label}
                          className={
                            [
                              'tracks',
                              'storedTracks',
                              'linkedTracks',
                              'albums',
                              'duration',
                            ].includes(column.key)
                              ? 'numeric'
                              : undefined
                          }
                          {...sorting}
                        />
                      ),
                    )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {!visible.length && (
                  <TableState colSpan={columns.count} error={listing.isError}>
                    {listing.isPending ? (
                      'Loading playlists...'
                    ) : listing.isError ? (
                      <>
                        Could not load playlists.{' '}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => listing.refetch()}
                        >
                          Retry
                        </button>
                      </>
                    ) : playlists.length ? (
                      'No playlists match this filter.'
                    ) : listingActive ? (
                      'Listing playlists...'
                    ) : listedAt ? (
                      'No playlists in this Spotify account.'
                    ) : (
                      'No stored playlist list.'
                    )}
                  </TableState>
                )}
                {visible.map((playlist) => {
                  const checked =
                    selected.includes(playlist.spotifyId) &&
                    selectable(playlist)
                  const summary = summaryOf(playlist.stored?.playlistId)
                  return (
                    <TableRow
                      key={playlist.spotifyId}
                      data-selected={checked || undefined}
                    >
                      {columns.visible('selection') && (
                        <TableCell className="table-selection-cell">
                          <input
                            type="checkbox"
                            aria-label={`Select ${playlist.name}`}
                            checked={checked}
                            disabled={queue.isPending || !selectable(playlist)}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? [...selected, playlist.spotifyId]
                                  : selected.filter(
                                      (id) => id !== playlist.spotifyId,
                                    ),
                              )
                            }
                          />
                        </TableCell>
                      )}
                      {columns.visible('artwork') && (
                        <TableCell className="w-10">
                          {playlist.artworkUrl && (
                            <MediaArtwork
                              src={playlist.artworkUrl}
                              alt=""
                              fallbackLabel=""
                              containerClassName="size-6 rounded"
                              imageClassName="size-6 object-cover"
                              fallbackClassName="size-6"
                            />
                          )}
                        </TableCell>
                      )}
                      {columns.visible('name') && (
                        <TableCell>
                          {playlist.stored ? (
                            <Link
                              className="font-medium hover:underline"
                              href={playlistDrawerHref(
                                playlist.stored.playlistId,
                              )}
                            >
                              {playlist.name}
                            </Link>
                          ) : (
                            playlist.name
                          )}
                        </TableCell>
                      )}
                      {columns.visible('owner') && (
                        <TableCell>{playlist.ownerName ?? '-'}</TableCell>
                      )}
                      {columns.visible('tracks') && (
                        <TableCell className="numeric">
                          {playlist.trackTotal.toLocaleString()}
                        </TableCell>
                      )}
                      {columns.visible('status') && (
                        <TableCell className="max-w-sm">
                          <ImportState playlist={playlist} />
                        </TableCell>
                      )}
                      {columns.visible('schedule') && (
                        <TableCell className="whitespace-nowrap">
                          <ScheduleCell summary={summary} />
                        </TableCell>
                      )}
                      {columns.visible('checked') && (
                        <TableCell className="whitespace-nowrap">
                          {summary?.sync.lastCheckedAt ? (
                            <time dateTime={summary.sync.lastCheckedAt}>
                              {formatDateTime(summary.sync.lastCheckedAt)}
                            </time>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      )}
                      {columns.visible('added') && (
                        <TableCell
                          className="whitespace-nowrap"
                          title="When the playlist was added to this library. Spotify does not provide the date a playlist was saved."
                        >
                          {formatDateTime(summary?.createdAt ?? null)}
                        </TableCell>
                      )}
                      {columns.visible('imported') && (
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(playlist.stored?.importedAt ?? null)}
                        </TableCell>
                      )}
                      {columns.visible('storedTracks') && (
                        <TableCell className="numeric">
                          {playlist.stored?.trackCount.toLocaleString() ?? '-'}
                        </TableCell>
                      )}
                      {columns.visible('linkedTracks') && (
                        <TableCell className="numeric">
                          {summary?.linkedTrackCount.toLocaleString() ?? '-'}
                        </TableCell>
                      )}
                      {columns.visible('albums') && (
                        <TableCell className="numeric">
                          {summary?.albumCount.toLocaleString() ?? '-'}
                        </TableCell>
                      )}
                      {columns.visible('duration') && (
                        <TableCell className="numeric">
                          {summary
                            ? formatPlaylistDuration(summary.durationSec)
                            : '-'}
                        </TableCell>
                      )}
                      {columns.visible('current') && (
                        <TableCell>
                          {playlist.stored
                            ? playlist.current
                              ? 'Yes'
                              : 'No'
                            : '-'}
                        </TableCell>
                      )}
                      {columns.visible('importable') && (
                        <TableCell>
                          {playlist.importable &&
                          cannotImportReason(playlist) === null
                            ? 'Yes'
                            : 'No'}
                        </TableCell>
                      )}
                      {columns.visible('nextSync') && (
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(
                            summary?.sync.nextScheduledAt ?? null,
                          )}
                        </TableCell>
                      )}
                      {columns.visible('description') && (
                        <TableCell>{summary?.description ?? '-'}</TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </table>
          </SecondaryTableScroll>
        </>
      )}
    </section>
  )
}
