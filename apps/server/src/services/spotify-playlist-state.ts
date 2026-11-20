import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getJobProgress } from '@repo/schemas/job'
import {
  PlaylistSyncScheduleSchema,
  SpotifyPlaylistJobSchema,
  type PlaylistSync,
  type PlaylistSummary,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { nextPlaylistSyncAt } from '@/lib/playlist-sync'
import { ServerError } from '@/lib/error'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { playlist, scrapeJob, spotifyPlaylistListing } from '@/schemas/db'
import { getSpotifyAccountStatus } from './spotify-oauth'

export const LIKED_SONGS_KEY = 'spotify-liked'
export const PLAYLIST_KEY_PREFIX = 'spotify:'
export const LIKED_SONGS_NAME = 'Liked Songs'
export const NOT_IMPORTABLE =
  'Spotify returns tracks only for playlists the account owns or collaborates on. Copy the playlist into the account to import it.'

export function refused(message: string) {
  return new ServerError({ statusCode: 422, message })
}

/** The import job group of a Spotify playlist, or of Liked Songs. */
export const playlistGroupKey = (spotifyId: string | null) =>
  spotifyId === null ? LIKED_SONGS_KEY : `${PLAYLIST_KEY_PREFIX}${spotifyId}`

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

export const playlistUrl = (spotifyId: string) =>
  `https://open.spotify.com/playlist/${spotifyId}`

export async function requirePlaylistAccess(userId: string) {
  const status = await getSpotifyAccountStatus(userId)
  if (!status.configured)
    throw refused(
      'Spotify is not configured. Configure and connect the account first.',
    )
  if (!status.connected)
    throw refused('Connect a Spotify account before reading playlists')
  if (!status.playlists)
    throw refused(
      'Reconnect the Spotify account to allow playlist access. The current connection does not include it.',
    )
  return status
}

/** The latest job of a Spotify task in each job group, with its progress. */
export async function latestSpotifyJobs(
  task: string,
  groupKeys?: string[],
  albumId?: string,
) {
  const groupKey = sql<string>`${scrapeJob.options}->>'groupKey'`
  const latest = new Map<
    string,
    { job: SpotifyPlaylistJob; options: Record<string, unknown> }
  >()
  if (groupKeys?.length === 0) return latest
  const jobs = await db
    .selectDistinctOn([groupKey], {
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
      finishedAt: scrapeJob.finishedAt,
      options: scrapeJob.options,
      groupKey,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`${scrapeJob.options}->>'task' = ${task}`,
        groupKeys ? inArray(groupKey, groupKeys) : undefined,
        albumId === undefined
          ? undefined
          : sql`${scrapeJob.options}->>'albumId' = ${albumId}`,
      ),
    )
    .orderBy(groupKey, desc(scrapeJob.createdAt), desc(scrapeJob.id))
  for (const job of jobs) {
    const key = z.string().safeParse(job.groupKey)
    if (key.success)
      latest.set(key.data, {
        job: SpotifyPlaylistJobSchema.parse({
          jobId: job.id,
          status: job.status,
          errorMessage: job.errorMessage,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          progress: getJobProgress(job.options),
        }),
        options: job.options,
      })
  }
  return latest
}

export async function listStoredSpotifyImports(spotifyIds: string[]) {
  if (!spotifyIds.length) return []
  return db
    .select({
      id: playlist.id,
      spotifyId: playlist.spotifyId,
      snapshotId: playlist.snapshotId,
    })
    .from(playlist)
    .where(
      and(
        eq(playlist.kind, 'playlist'),
        eq(playlist.source, 'spotify'),
        inArray(playlist.spotifyId, spotifyIds),
      ),
    )
}

export const storedSummary = (summary: PlaylistSummary) => ({
  playlistId: summary.id,
  importedAt: summary.importedAt,
  trackCount: summary.trackCount,
  summary,
})

/** One playlist as the listing job stored it. */
export const ListedPlaylistSchema = z.object({
  spotifyId: SpotifyIdSchema,
  name: z.string().min(1).max(500),
  ownerName: z.string().nullable(),
  description: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  snapshotId: z.string().nullable(),
  importable: z.boolean(),
  trackTotal: z.number().int().nonnegative(),
})
export type ListedPlaylist = z.infer<typeof ListedPlaylistSchema>

/** The account's stored playlist list; no Spotify requests. */
export async function readSpotifyPlaylistListing(userId: string) {
  const [row] = await db
    .select()
    .from(spotifyPlaylistListing)
    .where(eq(spotifyPlaylistListing.userId, userId))
  return row
    ? {
        playlists: z.array(ListedPlaylistSchema).parse(row.playlists),
        listedAt: row.listedAt,
      }
    : null
}
