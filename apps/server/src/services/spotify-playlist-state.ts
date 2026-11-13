import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getJobProgress } from '@repo/schemas/job'
import {
  SpotifyPlaylistJobSchema,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { scrapeJob, spotifyPlaylistListing } from '@/schemas/db'
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
export async function latestSpotifyJobs(task: string) {
  const jobs = await db
    .selectDistinctOn([sql`${scrapeJob.options}->>'groupKey'`], {
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
      finishedAt: scrapeJob.finishedAt,
      options: scrapeJob.options,
      groupKey: sql<unknown>`${scrapeJob.options}->>'groupKey'`,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`${scrapeJob.options}->>'task' = ${task}`,
      ),
    )
    .orderBy(
      sql`${scrapeJob.options}->>'groupKey'`,
      desc(scrapeJob.createdAt),
      desc(scrapeJob.id),
    )
  const latest = new Map<
    string,
    { job: SpotifyPlaylistJob; options: Record<string, unknown> }
  >()
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

const StoredRowsSchema = z.array(
  z.object({
    id: z.string(),
    source: z.string(),
    spotify_id: z.string().nullable(),
    snapshot_id: z.string().nullable(),
    imported_at: z.string().nullable(),
    track_count: z.number().int().nonnegative(),
  }),
)
export type StoredImport = z.infer<typeof StoredRowsSchema>[number]

export async function storedImports() {
  return StoredRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, p.source, p.spotify_id, p.snapshot_id,
          to_char(p.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as imported_at,
          (select count(*)::int from playlist_item pi
            join library_track lt on lt.media_item_id = pi.media_item_id
            where pi.playlist_id = p.id) as track_count
        from playlist p where p.source is not null`)
    ).rows,
  )
}

export const storedSummary = (row: StoredImport) => ({
  playlistId: row.id,
  importedAt: row.imported_at,
  trackCount: row.track_count,
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
