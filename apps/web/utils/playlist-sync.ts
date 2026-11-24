import type { QueryClient } from '@tanstack/react-query'
import type { JobProgress } from '@repo/schemas/job'
import { formatCount } from '@repo/ui/lib/format'
import {
  SpotifyPlaylistImportInputSchema,
  type PlaylistSource,
  type PlaylistSummary,
  type PlaylistSync,
  type SpotifyPlaylistImportInput,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { jobActivityLabel } from './job-activity'

/** How often a playlist is read again while its import is queued or running. */
export const PLAYLIST_SYNC_POLL_MS = 2000

const playlistSourceLabels: Record<PlaylistSource, string> = {
  spotify: 'Spotify',
  'spotify-liked': 'Liked Songs',
}

/** Null source: a playlist from the legacy album import. */
export function playlistSourceLabel(source: PlaylistSource | null) {
  return source ? playlistSourceLabels[source] : 'Library'
}

/** Refreshes playlists and everything their tracks appear in. */
export function invalidatePlaylists(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) =>
      [
        'playlist',
        'playlists',
        'tracks',
        'track',
        'albums',
        'album',
        'artists',
        'artist',
        'album-playlists',
      ].includes(String(query.queryKey[0])),
  })
}

export function formatPlaylistDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function playlistJobActive(job: SpotifyPlaylistJob | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running'
}

/** Pages read so far: "2 of 5 pages", or "2 pages" while the total is unknown. */
export function playlistJobProgress(progress: JobProgress | null) {
  if (!progress) return null
  const read = formatCount(progress.pagesRead)
  return progress.totalPages === null
    ? `${read} ${progress.pagesRead === 1 ? 'page' : 'pages'}`
    : `${read} of ${formatCount(progress.totalPages)} pages`
}

/** A current stage or failure context, with page progress for older jobs. */
export function playlistJobActivityLabel(job: SpotifyPlaylistJob) {
  if (job.activity && job.status === 'failed')
    return `Last stage · ${jobActivityLabel(job.activity)}`
  if (!playlistJobActive(job)) return null
  return job.activity
    ? jobActivityLabel(job.activity)
    : playlistJobProgress(job.progress)
}

/** The next scheduled import, or why there is none. */
export function playlistNextSync(
  sync: Pick<PlaylistSync, 'schedule' | 'nextScheduledAt' | 'job'>,
) {
  if (sync.nextScheduledAt)
    return new Date(sync.nextScheduledAt).toLocaleString()
  if (sync.schedule === 'off') return 'Schedule off'
  if (playlistJobActive(sync.job)) return 'Import in progress'
  if (sync.job?.status === 'failed')
    return 'Paused: the last import failed. Sync now to resume.'
  if (sync.job?.status === 'cancelled')
    return 'Paused: the last import was cancelled. Sync now to resume.'
  return '-'
}

/** The playlist's Spotify ID, read from its open.spotify.com URL. */
export function spotifyPlaylistId(url: string | null) {
  return (
    /^https:\/\/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})$/.exec(
      url ?? '',
    )?.[1] ?? null
  )
}

/** The import request that syncs one stored playlist; null when it cannot be synced. */
export function playlistImportRequest(
  playlist: Pick<PlaylistSummary, 'name' | 'source' | 'spotifyUrl' | 'sync'>,
): SpotifyPlaylistImportInput | null {
  if (!playlist.sync.syncable) return null
  const spotifyId = spotifyPlaylistId(playlist.spotifyUrl)
  const request =
    playlist.source === 'spotify-liked'
      ? { playlists: [], likedSongs: true }
      : playlist.source === 'spotify' && spotifyId
        ? { playlists: [{ spotifyId, name: playlist.name }], likedSongs: false }
        : null
  if (!request) return null
  const parsed = SpotifyPlaylistImportInputSchema.safeParse(request)
  return parsed.success ? parsed.data : null
}
