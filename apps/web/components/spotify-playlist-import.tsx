'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
  type SpotifyPlaylist,
  type SpotifyPlaylistImportInput,
  type SpotifyPlaylistImportJobSchema,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import { errorMessage } from './lastfm-sync'
import { invalidatePlaylists } from './playlists-workspace'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'
import { spotifyCallbackSetup } from '@/utils/spotify-setup'

type ImportJob = z.infer<typeof SpotifyPlaylistImportJobSchema>

const jobLabels = {
  queued: 'Queued',
  running: 'Importing...',
  succeeded: 'Imported',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function jobActive(job: ImportJob | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running'
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : '-'
}

function tracksLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'track' : 'tracks'}`
}

function JobStatus({ job }: { job: ImportJob | null }) {
  if (!job) return <span className="muted">-</span>
  return (
    <Link
      className="job-status underline underline-offset-2"
      data-status={job.status}
      href={scopedHref(`/jobs?jobId=${encodeURIComponent(job.jobId)}`, 'album')}
      title={job.errorMessage ?? undefined}
    >
      {jobLabels[job.status]}
    </Link>
  )
}

function playlistState(playlist: SpotifyPlaylist) {
  if (!playlist.stored) return 'Not imported'
  if (!playlist.current) return 'Changed on Spotify'
  return `Imported ${formatDate(playlist.stored.importedAt)} · ${tracksLabel(playlist.stored.trackCount)}`
}

function importsActive(
  imports: z.infer<typeof SpotifyPlaylistImportsSchema> | undefined,
) {
  return imports
    ? jobActive(imports.likedSongs.job) ||
        Object.values(imports.jobs).some(jobActive)
    : false
}

function overItemLimit(playlist: SpotifyPlaylist) {
  return playlist.trackTotal > SPOTIFY_PLAYLIST_ITEM_LIMIT
}

/** Playlists Spotify returns tracks for, within the item limit, with no import in progress. */
function selectable(playlist: SpotifyPlaylist) {
  return (
    playlist.importable && !overItemLimit(playlist) && !jobActive(playlist.job)
  )
}

export default function SpotifyPlaylistImport() {
  const { apiBaseUrl, appUrl } = useConfig()
  const client = useQueryClient()
  const outcome = useSearchParams().get('spotify')
  const [search, setSearch] = useState('')
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
  // Listing reads Spotify, so it runs only from the List playlists button.
  const listing = useQuery({
    queryKey: ['spotify-playlists'],
    enabled: false,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists',
        SpotifyPlaylistListSchema,
        { method: 'POST', body: '{}' },
      ),
  })
  const authorize = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playlists: true }),
    onSuccess: (url) => window.location.assign(url),
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
    if (wasActive.current && !active) void invalidatePlaylists(client)
    wasActive.current = active
  }, [active, client])

  const status = account.data
  const ready = Boolean(status?.connected && status.playlists)
  const setup = spotifyCallbackSetup(
    apiBaseUrl,
    appUrl,
    status?.redirectUri ?? null,
  )
  const playlists = (listing.data?.playlists ?? []).map((playlist) => ({
    ...playlist,
    job: imports.data?.jobs[playlist.spotifyId] ?? playlist.job,
  }))
  const term = search.trim().toLocaleLowerCase()
  const visible = term
    ? playlists.filter((playlist) =>
        playlist.name.toLocaleLowerCase().includes(term),
      )
    : playlists
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
  const likedResult = queue.variables?.likedSongs === true
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
    <section className="film-import-workflow">
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
      {ready && (
        <>
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
                <span>
                  {liked.stored
                    ? `Imported ${formatDate(liked.stored.importedAt)} · ${tracksLabel(liked.stored.trackCount)}`
                    : 'Not imported'}
                </span>
                {liked.job && <JobStatus job={liked.job} />}
                <Button
                  size="sm"
                  disabled={queue.isPending || jobActive(liked.job)}
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
          <section aria-labelledby="playlists-heading" className="grid gap-2">
            <h2 id="playlists-heading">Playlists</h2>
            <div className="form-actions">
              <Button
                size="sm"
                variant={listing.data ? 'outline' : 'default'}
                disabled={listing.isFetching}
                onClick={() => void listing.refetch()}
              >
                {listing.isFetching
                  ? 'Listing playlists...'
                  : listing.data
                    ? 'List playlists again'
                    : 'List playlists'}
              </Button>
              <span className="muted">
                Reads the playlist list from Spotify; nothing is imported.
              </span>
            </div>
            {listing.isError && (
              <p role="alert">
                {errorMessage(listing.error, 'Could not list playlists.')}
              </p>
            )}
            {listing.data && (
              <>
                {playlists.some((playlist) => !playlist.importable) && (
                  <p className="muted">
                    Spotify returns tracks only for playlists the account owns
                    or collaborates on. Copy a playlist into the account to
                    import it.
                  </p>
                )}
                <div className="job-selection-toolbar">
                  <Input
                    aria-label="Filter playlists"
                    placeholder="Filter playlists..."
                    className="h-7 w-56 text-xs"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <span>
                    {visible.length.toLocaleString()} of{' '}
                    {listing.data.total.toLocaleString()} playlists ·{' '}
                    {targets.length} selected
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
                          setConfirmedKey(
                            event.target.checked ? confirmationKey : '',
                          )
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
                    <span role="alert">
                      Import up to 100 playlists at a time.
                    </span>
                  )}
                </div>
                {!likedResult && result}
                {!likedResult && queueError}
                <TableScroll
                  className="table-scroll-bounded"
                  role="region"
                  aria-label="Spotify playlists"
                >
                  <table
                    className="compact-table"
                    aria-label="Spotify playlists"
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead className="table-selection-cell">
                          <span className="sr-only">Select</span>
                        </TableHead>
                        <TableHead>
                          <span className="sr-only">Artwork</span>
                        </TableHead>
                        <TableHead>Playlist</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead className="numeric">Tracks</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Import job</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((playlist) => {
                        const checked =
                          selected.includes(playlist.spotifyId) &&
                          selectable(playlist)
                        return (
                          <TableRow
                            key={playlist.spotifyId}
                            data-selected={checked || undefined}
                          >
                            <TableCell className="table-selection-cell">
                              <input
                                type="checkbox"
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
                            <TableCell>{playlist.name}</TableCell>
                            <TableCell>{playlist.ownerName ?? '-'}</TableCell>
                            <TableCell className="numeric">
                              {playlist.trackTotal.toLocaleString()}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {playlistState(playlist)}
                              {overItemLimit(playlist) && (
                                <span className="muted">
                                  {' '}
                                  · Over{' '}
                                  {SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString()}{' '}
                                  tracks, cannot be imported
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <JobStatus job={playlist.job} />
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </table>
                  {!visible.length && (
                    <p className="p-3 muted">
                      {playlists.length
                        ? 'No playlists match this filter.'
                        : 'No playlists in this Spotify account.'}
                    </p>
                  )}
                </TableScroll>
              </>
            )}
          </section>
        </>
      )}
    </section>
  )
}
