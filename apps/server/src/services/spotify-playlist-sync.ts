import { and, eq, isNotNull, ne } from 'drizzle-orm'
import {
  PlaylistSyncScheduleSchema,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  type PlaylistSync,
  type PlaylistSyncSchedule,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { nextPlaylistSyncAt } from '@/lib/playlist-sync'
import { playlist } from '@/schemas/db'
import { createTaskJob } from './jobs'
import { storedImportTarget } from './spotify-playlists'
import { latestSpotifyJobs, playlistGroupKey } from './spotify-playlist-state'

type SyncRow = {
  source: string | null
  spotifyId: string | null
  syncSchedule: string
  checkedAt: Date | null
  importedAt: Date | null
}

/** The import job group of a stored playlist; null for a legacy-only playlist. */
export const storedGroupKey = (row: Pick<SyncRow, 'source' | 'spotifyId'>) =>
  row.source === 'spotify-liked'
    ? playlistGroupKey(null)
    : row.source === 'spotify' && row.spotifyId
      ? playlistGroupKey(row.spotifyId)
      : null

/** The sync block of a stored playlist. */
export function playlistSync(
  row: SyncRow,
  job: SpotifyPlaylistJob | null,
): PlaylistSync {
  const syncable = storedGroupKey(row) !== null
  const schedule = PlaylistSyncScheduleSchema.catch('off').parse(
    row.syncSchedule,
  )
  return {
    syncable,
    schedule,
    lastCheckedAt: (row.checkedAt ?? row.importedAt)?.toISOString() ?? null,
    nextScheduledAt:
      nextPlaylistSyncAt({
        syncable,
        schedule,
        checkedAt: row.checkedAt,
        importedAt: row.importedAt,
        jobStatus: job?.status ?? null,
      })?.toISOString() ?? null,
    job,
  }
}

/** Sets how often an imported playlist is imported again; off by default. */
export async function setPlaylistSyncSchedule(
  playlistId: string,
  schedule: PlaylistSyncSchedule,
  userId: string,
) {
  const [row] = await db
    .select({ source: playlist.source, spotifyId: playlist.spotifyId })
    .from(playlist)
    .where(eq(playlist.id, playlistId))
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  if (storedGroupKey(row) === null)
    throw new ServerError({
      statusCode: 422,
      message:
        'Only imported Spotify playlists and Liked Songs can be synced on a schedule.',
    })
  await db
    .update(playlist)
    .set({ syncSchedule: schedule, syncUserId: userId })
    .where(eq(playlist.id, playlistId))
}

/**
 * Queues an import of each playlist whose schedule is due. Nothing is queued
 * for a playlist with an import queued or running, after a failed or
 * cancelled import, or while Spotify is cooling down or halted.
 */
export async function queueDueSpotifyPlaylistSyncs(
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .select()
    .from(playlist)
    .where(
      and(
        isNotNull(playlist.source),
        ne(playlist.syncSchedule, 'off'),
        isNotNull(playlist.syncUserId),
      ),
    )
  if (!rows.length) return false
  const jobs = await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK)
  let queued = false
  for (const row of rows) {
    const key = storedGroupKey(row)
    const target = storedImportTarget(row)
    if (!key || !target || !row.syncUserId) continue
    const next = playlistSync(row, jobs.get(key)?.job ?? null).nextScheduledAt
    if (!next || Date.parse(next) > now) continue
    try {
      await createTaskJob(SPOTIFY_PLAYLIST_IMPORT_TASK, row.syncUserId, {
        scheduled: true,
        taskOptions: target,
      })
      queued = true
    } catch (error) {
      // A cooldown, halt or disconnected account defers the import to a later check.
      if (!(error instanceof ServerError)) throw error
    }
  }
  return queued
}
