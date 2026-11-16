'use client'

import Link from 'next/link'
import { DetailLink } from './detail-link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
  type SpotifyPlaylist,
  type SpotifyPlaylistImportInput,
  type SpotifyPlaylistJob,
  type SpotifyPlaylistStoredMetadata,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import {
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
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
import { useConfig } from './providers'
import { useLibraryView } from './media-scope'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableSelectionBar,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { ConfirmAction } from './confirm-action'
import { sortTableRows } from '@/utils/secondary-table'
import { MediaThumb } from './media-artwork'
import { errorMessage } from './lastfm-sync'
import AllowPlaylistChanges from './spotify-playlist-changes'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import {
  invalidatePlaylists,
  playlistJobActive,
  playlistJobProgress,
} from '@/utils/playlist-sync'
import { runStatusLabel, runStatusStates } from '@/utils/run-status'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'
import { spotifyCallbackSetup } from '@/utils/spotify-setup'
import { youtubeScheduleLabels } from '@/utils/youtube'

const spotifyListingKey = ['playlists', 'spotify-listing']
/** Width of the selection column; the playlist name is pinned after it. */
const CHECK_WIDTH = 36
const NUMERIC = new Set<string>([
  'tracks',
  'storedTracks',
  'linkedTracks',
  'albums',
  'duration',
])
const spotifyImportsKey = ['playlists', 'spotify-imports']

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
    | { key: 'selection'; sortable: false }
  )

const importColumns: readonly ImportColumn[] = [
  { key: 'selection', sortable: false, label: 'Selection', required: true },
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

type ImportPlaylistFilter = 'not-imported' | 'imported' | 'needs-update'
const importStatusOptions: readonly {
  value: ImportPlaylistFilter
  label: string
}[] = [
  { value: 'not-imported', label: 'Not imported' },
  { value: 'imported', label: 'Imported' },
  { value: 'needs-update', label: 'Needs update' },
]

export function filterImportPlaylists(
  playlists: readonly SpotifyPlaylist[],
  search: string,
  status: readonly ImportPlaylistFilter[],
  owners: readonly string[] = [],
): SpotifyPlaylist[] {
  const term = search.trim().toLocaleLowerCase()
  return playlists.filter((playlist) => {
    if (
      term &&
      ![playlist.name, playlist.ownerName]
        .join(' ')
        .toLocaleLowerCase()
        .includes(term)
    )
      return false
    if (owners.length && !owners.includes(playlist.ownerName ?? ''))
      return false
    return (
      !status.length ||
      status.some((value) => {
        if (value === 'not-imported') return playlist.stored === null
        if (value === 'needs-update')
          return playlist.stored !== null && !playlist.current
        return playlist.stored !== null
      })
    )
  })
}

export function importPlaylistSortValue(
  playlist: SpotifyPlaylist,
  key: ImportPlaylistSortKey,
) {
  const summary = playlist.stored?.summary
  switch (key) {
    case 'name':
      return playlist.name
    case 'owner':
      return playlist.ownerName
    case 'tracks':
      return playlist.trackTotal
    case 'status':
      return playlist.job && playlist.job.status !== 'succeeded'
        ? runStatusLabel(playlist.job.status)
        : playlist.stored
          ? playlist.current
            ? 'Imported'
            : 'Needs update'
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

const TRACKS = { one: 'track', other: 'tracks' }
const PLAYLISTS = { one: 'playlist', other: 'playlists' }

function JobStatus({
  job,
  labels = {},
}: {
  job: SpotifyPlaylistJob
  labels?: Partial<Record<SpotifyPlaylistJob['status'], string>>
}) {
  return (
    <DetailLink kind="job" id={job.jobId} title={job.errorMessage ?? undefined}>
      <Status state={runStatusStates[job.status]}>
        {labels[job.status] ?? runStatusLabel(job.status)}
      </Status>
    </DetailLink>
  )
}

/** Status, page progress and failure message of a playlist job. */
function JobState({ job }: { job: SpotifyPlaylistJob }) {
  const progress = playlistJobActive(job)
    ? playlistJobProgress(job.progress)
    : null
  return (
    <>
      <JobStatus job={job} />
      {progress && <span className="ds-muted"> {progress}</span>}
      {job.status === 'failed' && job.errorMessage && (
        <span className="block whitespace-normal">{job.errorMessage}</span>
      )}
    </>
  )
}

function storedLabel(stored: NonNullable<SpotifyPlaylist['stored']>) {
  return `Imported ${formatDateTime(stored.importedAt)} · ${formatItemCount(stored.trackCount, TRACKS)}`
}

/** The stored state of a playlist without a job in progress. */
function StoredStatus({ playlist }: { playlist: SpotifyPlaylist }) {
  return playlist.stored ? (
    playlist.current ? (
      <Status state="done">Imported</Status>
    ) : (
      <Status state="attention">Needs update</Status>
    )
  ) : (
    <Status state="never">Not imported</Status>
  )
}

function ImportState({ playlist }: { playlist: SpotifyPlaylist }) {
  const { job, stored } = playlist
  const showJob = job && job.status !== 'succeeded'
  const reason = cannotImportReason(playlist)
  const hasJobDetails =
    showJob &&
    ((playlistJobActive(job) && playlistJobProgress(job.progress)) ||
      (job.status === 'failed' && job.errorMessage))
  const label = showJob
    ? runStatusLabel(job.status)
    : stored
      ? playlist.current
        ? 'Imported'
        : 'Needs update'
      : 'Not imported'
  return (
    <SecondaryCell
      text={label}
      label={`Import details for ${playlist.name}`}
      details={
        stored || reason || hasJobDetails ? (
          <>
            {hasJobDetails && (
              <p>
                <JobState job={job} />
              </p>
            )}
            {stored && (
              <p>
                {storedLabel(stored)}
                {!playlist.current && ' · Changed on Spotify'}
              </p>
            )}
            {reason && <p>{reason}</p>}
          </>
        ) : undefined
      }
    >
      {showJob ? <JobStatus job={job} /> : <StoredStatus playlist={playlist} />}
    </SecondaryCell>
  )
}

function ScheduleCell({
  summary,
}: {
  summary: SpotifyPlaylistStoredMetadata | undefined
}) {
  if (!summary?.sync.syncable) return <EmptyValue />
  const { schedule, nextScheduledAt } = summary.sync
  return (
    <DetailLink
      kind="playlist"
      id={summary.id}
      tab="sync"
      title={
        nextScheduledAt
          ? `Next import ${formatDateTime(nextScheduledAt)}`
          : undefined
      }
    >
      {youtubeScheduleLabels[schedule]}
    </DetailLink>
  )
}

function DateCell({ value }: { value: string | null | undefined }) {
  return value ? (
    <time dateTime={value} title={formatDateTime(value)}>
      {formatDate(value)}
    </time>
  ) : (
    <EmptyValue />
  )
}

function overItemLimit(playlist: SpotifyPlaylist) {
  return playlist.trackTotal > SPOTIFY_PLAYLIST_ITEM_LIMIT
}

function cannotImportReason(playlist: SpotifyPlaylist) {
  if (playlist.notImportableReason) return playlist.notImportableReason
  if (overItemLimit(playlist))
    return `Over ${formatCount(SPOTIFY_PLAYLIST_ITEM_LIMIT)} tracks, cannot be imported.`
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
  const trackLibrary = useLibraryView() === 'track'
  const outcome = useSearchParams().get('spotify')
  const [search, setSearch] = useState('')
  const [importStatus, setImportStatus] = useState<ImportPlaylistFilter[]>([])
  const [owners, setOwners] = useState<string[]>([])
  const selectAll = useRef<HTMLInputElement>(null)
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
    queryKey: spotifyImportsKey,
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
    queryKey: spotifyListingKey,
    enabled: ready,
    refetchInterval: (query) =>
      playlistJobActive(query.state.data?.job) ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists',
        SpotifyPlaylistListSchema,
      ),
  })
  const authorize = useMutation({
    mutationFn: () =>
      spotifyAuthorizationUrl(apiBaseUrl, {
        playlists: true,
        playlistLibrary: trackLibrary ? 'track' : 'album',
      }),
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
    onSuccess: (data) => client.setQueryData(spotifyListingKey, data),
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
      }
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: spotifyImportsKey }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })

  const active = importsActive(imports.data)
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) void invalidatePlaylists(client)
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
  const playlists = (listing.data?.playlists ?? []).map((playlist) => ({
    ...playlist,
    job: imports.data?.jobs[playlist.spotifyId] ?? playlist.job,
  }))
  const ownerOptions = [
    ...new Set(playlists.map((playlist) => playlist.ownerName ?? '')),
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value || 'Unknown owner' }))
  const filtered = filterImportPlaylists(
    playlists,
    search,
    importStatus,
    owners,
  )
  const visible = sortTableRows(
    filtered,
    { key: sortBy, direction },
    importPlaylistSortValue,
  )
  const targets = visible.filter(
    (playlist) => selected.includes(playlist.spotifyId) && selectable(playlist),
  )
  const selectableIds = visible
    .filter(selectable)
    .map((playlist) => playlist.spotifyId)
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selected.includes(id))
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = !allSelected && targets.length > 0
  }, [allSelected, targets.length])
  const broad = targets.length > 5
  const tooMany = targets.length > 100
  const liked = imports.data?.likedSongs
  const likedSummary = liked?.stored?.summary
  const likedResult = queue.variables?.likedSongs === true
  const listedAt = listing.data?.listedAt ?? null
  const result = queue.data && (
    <Notice>
      {formatCount(queue.data.queued)} queued ·{' '}
      {formatCount(queue.data.skipped)} skipped.{' '}
      <Link
        href={scopedHref(
          `/jobs?batchId=${encodeURIComponent(queue.data.batchId)}`,
          'album',
        )}
      >
        {trackLibrary ? 'View import jobs in Albums' : 'View import jobs'}
      </Link>
      {queue.data.warnings.map((warning) => (
        <span key={warning} className="block">
          {warning}
        </span>
      ))}
    </Notice>
  )
  const queueError = queue.isError && (
    <Notice tone="danger">
      {errorMessage(queue.error, 'Could not queue the import.')}
    </Notice>
  )
  const shown = importColumns.filter((column) => columns.visible(column.key))

  return (
    <div className="sec-fill">
      <div className="sec-notices">
        {account.isError && (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => account.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load Spotify connection.
          </Notice>
        )}
        {outcome === 'error' && (
          <Notice tone="danger">
            Spotify connection was not completed. Try connecting again.
          </Notice>
        )}
        {outcome === 'connected' && ready && (
          <Notice>Spotify connected.</Notice>
        )}
        {status && !status.configured && (
          <Notice tone="attention">
            Configure Client ID and Redirect URI in{' '}
            <Link href="/providers/spotify">
              {trackLibrary
                ? 'Spotify provider settings in Albums'
                : 'Spotify provider settings'}
            </Link>
            .
          </Notice>
        )}
        {ready && !status?.playlistChanges && (
          <Notice
            action={
              <AllowPlaylistChanges
                playlistLibrary={trackLibrary ? 'track' : 'album'}
              />
            }
          >
            Adding albums to playlists needs playlist change access.
          </Notice>
        )}
      </div>
      {account.isPending && (
        <div className="ds-panelpad">
          <Skeleton width="50%" height={16} />
        </div>
      )}
      {status && !ready && (
        <div className="ds-panelpad sec-form">
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
              <code className="ds-mono block break-all">
                {setup.callbackUrl}
              </code>
              <p className="ds-help">
                Keep using this app address. The callback returns to your
                signed-in session automatically.
              </p>
            </details>
          )}
          {status.configured && (
            <p className="ds-help">
              {status.connected
                ? 'The Spotify connection does not include playlist access. Reconnect to grant it.'
                : 'Playlist import needs a Spotify connection with playlist access.'}
            </p>
          )}
          <span className="ds-actions">
            <Button
              size="md"
              variant="primary"
              disabled={!status.configured || authorize.isPending}
              onClick={() => authorize.mutate()}
            >
              {authorize.isPending
                ? 'Connecting...'
                : status.connected
                  ? 'Reconnect Spotify'
                  : 'Connect Spotify'}
            </Button>
          </span>
          {authorize.isError && (
            <Notice tone="danger">
              {errorMessage(authorize.error, 'Could not start the connection.')}
            </Notice>
          )}
        </div>
      )}
      {ready && (
        <div className="ds-panelpad">
          <Section
            title="Liked Songs"
            flush
            aside={
              liked !== undefined && (
                <Button
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
              )
            }
          >
            {imports.isPending && <Skeleton width="40%" height={16} />}
            {imports.isError && (
              <Notice
                tone="danger"
                action={
                  <Button size="xs" onClick={() => imports.refetch()}>
                    Retry
                  </Button>
                }
              >
                Could not load import state.
              </Notice>
            )}
            {liked !== undefined && (
              <span className="sec-line">
                {liked.job && liked.job.status !== 'succeeded' && (
                  <span>
                    <JobState job={liked.job} />
                  </span>
                )}
                {!playlistJobActive(liked.job) && (
                  <span>
                    {liked.stored ? (
                      storedLabel(liked.stored)
                    ) : (
                      <Status state="never">Not imported</Status>
                    )}
                  </span>
                )}
                {likedSummary?.sync.syncable && (
                  <span>
                    Schedule: <ScheduleCell summary={likedSummary} />
                    {likedSummary.sync.lastCheckedAt &&
                      ` · Last checked ${formatDateTime(likedSummary.sync.lastCheckedAt)}`}
                  </span>
                )}
              </span>
            )}
            {likedResult && result}
            {likedResult && queueError}
          </Section>
        </div>
      )}
      {ready && (
        <>
          <div className="ds-section-head sec-pad">
            <h3>Playlists</h3>
          </div>
          <div className="sec-notices">
            {list.isError && (
              <Notice tone="danger">
                {errorMessage(list.error, 'Could not list playlists.')}
              </Notice>
            )}
            {listingJob &&
              (listingJob.status === 'failed' ||
                listingJob.status === 'cancelled') && (
                <Notice
                  tone="danger"
                  action={
                    <Button size="xs" asChild>
                      <DetailLink kind="job" id={listingJob.jobId}>
                        View job
                      </DetailLink>
                    </Button>
                  }
                >
                  The last listing{' '}
                  {listingJob.status === 'failed' ? 'failed' : 'was cancelled'}
                  {listingJob.errorMessage
                    ? `: ${listingJob.errorMessage}`
                    : '.'}
                </Notice>
              )}
          </div>
          <Toolbar>
            <Button
              variant={listedAt ? 'default' : 'primary'}
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
                <JobState job={listingJob} />
              </span>
            ) : (
              listing.data && (
                <span className="ds-muted">
                  {listedAt
                    ? `Listed ${formatDateTime(listedAt)}`
                    : 'Reads the playlist list from Spotify; nothing is imported.'}
                </span>
              )
            )}
            <SecondaryTableSearch
              label="Search playlists"
              placeholder="Search playlists or owners"
              value={search}
              disabled={queue.isPending}
              onChange={(value) => {
                setSearch(value)
                setSelected([])
              }}
            />
            <ToolbarCount>
              {formatItemCount(visible.length, PLAYLISTS, playlists.length)}
            </ToolbarCount>
            {columns.controls && <ToolbarEnd>{columns.controls}</ToolbarEnd>}
          </Toolbar>
          <SecondaryTableFrame>
            <SecondaryTableScroll
              role="region"
              aria-label="Spotify playlists"
              aria-busy={listing.isFetching}
            >
              <table className="ds-table" aria-label="Spotify playlists">
                <TableHeader>
                  <TableRow>
                    {shown.map((column) =>
                      !column.sortable ? (
                        <TableHead
                          key={column.key}
                          className="sec-check-cell"
                          sticky={0}
                        >
                          <input
                            ref={selectAll}
                            type="checkbox"
                            className="ds-check"
                            aria-label="Select all importable playlists"
                            checked={allSelected}
                            disabled={queue.isPending || !selectableIds.length}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked ? selectableIds : [],
                              )
                            }
                          />
                        </TableHead>
                      ) : (
                        <SecondaryTableHead
                          key={column.key}
                          sortKey={column.key}
                          label={column.label}
                          align={NUMERIC.has(column.key) ? 'end' : undefined}
                          sticky={
                            column.key === 'name' ? CHECK_WIDTH : undefined
                          }
                          stickyEdge={column.key === 'name'}
                          filter={
                            column.key === 'status' ? (
                              <SecondaryColumnFilter
                                label="Import status"
                                options={importStatusOptions}
                                value={importStatus}
                                disabled={queue.isPending}
                                onChange={(value) => {
                                  setImportStatus(value)
                                  setSelected([])
                                }}
                              />
                            ) : column.key === 'owner' ? (
                              <SecondaryColumnFilter
                                label="Owner"
                                options={ownerOptions}
                                value={owners}
                                disabled={queue.isPending}
                                onChange={(value) => {
                                  setOwners(value)
                                  setSelected([])
                                }}
                              />
                            ) : undefined
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
                        <Skeleton width="40%" height={12} />
                      ) : listing.isError ? (
                        <>
                          Could not load playlists.{' '}
                          <Button size="xs" onClick={() => listing.refetch()}>
                            Retry
                          </Button>
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
                    const summary = playlist.stored?.summary
                    return (
                      <TableRow key={playlist.spotifyId} selected={checked}>
                        {columns.visible('selection') && (
                          <TableCell className="sec-check-cell" sticky={0}>
                            <input
                              type="checkbox"
                              className="ds-check"
                              aria-label={`Select ${playlist.name}`}
                              checked={checked}
                              disabled={
                                queue.isPending || !selectable(playlist)
                              }
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
                        {columns.visible('name') && (
                          <TableCell sticky={CHECK_WIDTH} stickyEdge>
                            <span className="ds-cell-id">
                              <MediaThumb
                                kind="playlist"
                                src={playlist.artworkUrl}
                              />
                              <SecondaryCell text={playlist.name}>
                                {playlist.stored ? (
                                  <DetailLink
                                    className="ds-cell-title"
                                    kind="playlist"
                                    id={playlist.stored.playlistId}
                                  >
                                    {playlist.name}
                                  </DetailLink>
                                ) : (
                                  playlist.name
                                )}
                              </SecondaryCell>
                            </span>
                          </TableCell>
                        )}
                        {columns.visible('owner') && (
                          <TableCell>
                            <SecondaryCell>
                              {playlist.ownerName ?? EMPTY_VALUE}
                            </SecondaryCell>
                          </TableCell>
                        )}
                        {columns.visible('tracks') && (
                          <TableCell align="end">
                            {formatCount(playlist.trackTotal)}
                          </TableCell>
                        )}
                        {columns.visible('status') && (
                          <TableCell>
                            <ImportState playlist={playlist} />
                          </TableCell>
                        )}
                        {columns.visible('schedule') && (
                          <TableCell>
                            <ScheduleCell summary={summary} />
                          </TableCell>
                        )}
                        {columns.visible('checked') && (
                          <TableCell>
                            <DateCell value={summary?.sync.lastCheckedAt} />
                          </TableCell>
                        )}
                        {columns.visible('added') && (
                          <TableCell title="When the playlist was added to this library. Spotify does not provide the date a playlist was saved.">
                            <DateCell value={summary?.createdAt} />
                          </TableCell>
                        )}
                        {columns.visible('imported') && (
                          <TableCell>
                            <DateCell value={playlist.stored?.importedAt} />
                          </TableCell>
                        )}
                        {columns.visible('storedTracks') && (
                          <TableCell align="end">
                            {playlist.stored
                              ? formatCount(playlist.stored.trackCount)
                              : EMPTY_VALUE}
                          </TableCell>
                        )}
                        {columns.visible('linkedTracks') && (
                          <TableCell align="end">
                            {summary
                              ? formatCount(summary.linkedTrackCount)
                              : EMPTY_VALUE}
                          </TableCell>
                        )}
                        {columns.visible('albums') && (
                          <TableCell align="end">
                            {summary
                              ? formatCount(summary.albumCount)
                              : EMPTY_VALUE}
                          </TableCell>
                        )}
                        {columns.visible('duration') && (
                          <TableCell align="end">
                            {summary
                              ? formatRuntime(summary.durationSec / 60)
                              : EMPTY_VALUE}
                          </TableCell>
                        )}
                        {columns.visible('current') && (
                          <TableCell>
                            {playlist.stored
                              ? playlist.current
                                ? 'Yes'
                                : 'No'
                              : EMPTY_VALUE}
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
                          <TableCell>
                            {formatDateTime(summary?.sync.nextScheduledAt)}
                          </TableCell>
                        )}
                        {columns.visible('description') && (
                          <TableCell>
                            <SecondaryCell>
                              {summary?.description ?? EMPTY_VALUE}
                            </SecondaryCell>
                          </TableCell>
                        )}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </table>
            </SecondaryTableScroll>
            <SecondaryTableSelectionBar
              selectedCount={targets.length}
              total={selectableIds.length}
            >
              {tooMany && (
                <span role="alert">Import up to 100 playlists at a time.</span>
              )}
              <span className="ds-actions ds-toolbar-end">
                <ConfirmAction
                  variant="primary"
                  confirm={broad}
                  question={`Import ${formatItemCount(targets.length, PLAYLISTS)}?`}
                  details="Each playlist is read from Spotify and its tracks are imported."
                  confirmLabel="Import"
                  disabled={queue.isPending || !targets.length || tooMany}
                  onConfirm={() =>
                    queue.mutate({
                      playlists: targets.map(({ spotifyId, name }) => ({
                        spotifyId,
                        name,
                      })),
                      likedSongs: false,
                      confirmBroadRun: broad,
                    })
                  }
                >
                  {queue.isPending && !likedResult
                    ? 'Queueing...'
                    : 'Import selected'}
                </ConfirmAction>
              </span>
            </SecondaryTableSelectionBar>
            {!likedResult && (result || queueError) && (
              <div className="sec-notices">
                {result}
                {queueError}
              </div>
            )}
          </SecondaryTableFrame>
        </>
      )}
    </div>
  )
}
