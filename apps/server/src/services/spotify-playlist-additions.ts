import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getJobProgress } from '@repo/schemas/job'
import {
  PlaylistAlbumAdditionInputSchema,
  PlaylistAlbumAdditionSchema,
  PlaylistAlbumAdditionsSchema,
  SPOTIFY_PLAYLIST_ADD_ALBUM_TASK,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SPOTIFY_PLAYLIST_PAGE_SIZE,
  type PlaylistAlbumAddition,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  SpotifyIdSchema,
  SpotifySnapshotSchema,
  SpotifyTracksPageSchema,
  spotifyAlbumId,
  spotifyJson,
  spotifyPostJson,
  spotifyTrackAdditions,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import { playlist, track } from '@/schemas/db'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import {
  getSpotifyAccountStatus,
  spotifyOperation,
  spotifyPlaylistChangeToken,
} from './spotify-oauth'
import {
  markPlaylistNotEditable,
  readSpotifyPlaylist,
  readSpotifyTrackEntries,
  storedImportTarget,
} from './spotify-playlists'
import { latestSpotifyJobs, refused } from './spotify-playlist-state'

// Album track pagination is bounded like the album metadata job's.
const MAX_ALBUM_TRACKS = 500
const NOT_WRITABLE =
  'Spotify accepts additions only to playlists the account owns or collaborates on.'

const RequestSchema = z.object({
  playlistId: z.string().min(1),
  albumId: z.string().min(1),
})
const OptionsSchema = RequestSchema.extend({
  userId: z.string().min(1),
  groupKey: z.string().min(1),
  spotifyPlaylistId: SpotifyIdSchema,
  playlistName: z.string(),
  spotifyAlbumId: SpotifyIdSchema,
  albumTitle: z.string(),
})
type Options = z.infer<typeof OptionsSchema>

const AlbumRowsSchema = z.array(
  z.object({
    title: z.string(),
    spotify_url: z.string().nullable(),
    refs: z.array(z.string()),
  }),
)

/** The album's Spotify ID: its Spotify URL, then a Spotify album reference. */
async function albumSpotifyReference(albumId: string) {
  const [row] = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.title, al.spotify_url,
          coalesce((
            select array_agg(r.external_id order by r.is_primary desc, r.created_at)
            from provider_reference r
            where r.media_item_id = mi.id and (r.reference_type = 'spotify'
              or (r.provider = 'spotify' and r.reference_type = 'album'))), '{}') as refs
        from media_item mi join album al on al.media_item_id = mi.id
        where mi.id = ${albumId} and mi.media_type = 'album'`)
    ).rows,
  )
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Album not found' })
  const spotifyId = [row.spotify_url, ...row.refs]
    .map((value) => (value ? spotifyAlbumId(value) : null))
    .find((value) => value !== null)
  if (!spotifyId)
    throw refused(
      'The album has no Spotify album reference. Add its Spotify link or scrape it with Spotify first.',
    )
  return { title: row.title, spotifyId }
}

/**
 * Checks the account, the target playlist and the album before an addition
 * is queued. Only an imported Spotify playlist the account owns or
 * collaborates on is a target; Liked Songs and legacy playlists are not.
 */
export async function prepareSpotifyPlaylistAddition(
  userId: string | null,
  input: Record<string, unknown>,
) {
  if (!userId) throw refused('Sign in to change Spotify playlists.')
  const { playlistId, albumId } = RequestSchema.parse(input)
  const status = await getSpotifyAccountStatus(userId)
  if (!status.configured || !status.connected)
    throw refused('Connect a Spotify account before changing playlists.')
  if (!status.playlistChanges)
    throw refused(
      'Reconnect the Spotify account to allow playlist changes. The current connection does not include them.',
    )
  const [target] = await db
    .select({
      name: playlist.name,
      source: playlist.source,
      spotifyId: playlist.spotifyId,
      spotifyEditable: playlist.spotifyEditable,
    })
    .from(playlist)
    .where(eq(playlist.id, playlistId))
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  if (target.source === 'spotify-liked')
    throw refused('Albums cannot be added to Liked Songs.')
  if (target.source !== 'spotify' || !target.spotifyId)
    throw refused('Only imported Spotify playlists accept albums.')
  if (!target.spotifyEditable) throw refused(NOT_WRITABLE)
  const album = await albumSpotifyReference(albumId)
  return {
    playlistId,
    albumId,
    userId,
    groupKey: `spotify-add:${playlistId}:${albumId}`,
    spotifyPlaylistId: target.spotifyId,
    playlistName: target.name,
    spotifyAlbumId: album.spotifyId,
    albumTitle: album.title,
  }
}

/**
 * The album's Spotify track IDs in album order: its stored track list when
 * every track has a Spotify ID, otherwise read from Spotify.
 */
async function albumTrackIds(
  request: SpotifyRequest,
  token: string,
  options: Options,
) {
  const stored = await db
    .select({ externalId: track.externalId })
    .from(track)
    .where(eq(track.albumMediaItemId, options.albumId))
    .orderBy(asc(track.position))
  const ids = stored.flatMap((row) => {
    const id = SpotifyIdSchema.safeParse(row.externalId)
    return id.success ? [id.data] : []
  })
  if (stored.length && ids.length === stored.length) return ids
  const tracks: z.infer<typeof SpotifyTracksPageSchema>['items'] = []
  let offset = 0
  for (;;) {
    const page = SpotifyTracksPageSchema.parse(
      await spotifyJson(
        request,
        token,
        `albums/${options.spotifyAlbumId}/tracks`,
        {
          limit: String(SPOTIFY_PLAYLIST_PAGE_SIZE),
          offset: String(offset),
        },
      ),
    )
    if (
      page.offset !== offset ||
      page.items.length > SPOTIFY_PLAYLIST_PAGE_SIZE
    )
      throw refused('Invalid Spotify album track pagination')
    if (page.total > MAX_ALBUM_TRACKS)
      throw refused(
        `The album has more than ${MAX_ALBUM_TRACKS} tracks. Nothing was added.`,
      )
    tracks.push(...page.items)
    offset += page.items.length
    if (page.next === null || !page.items.length || offset >= page.total) break
  }
  return tracks
    .sort(
      (a, b) =>
        a.disc_number - b.disc_number || a.track_number - b.track_number,
    )
    .flatMap((item) => (item.id ? [item.id] : []))
}

/**
 * The tracks the playlist holds now. The stored copy is used when its
 * snapshot is Spotify's current one; otherwise the playlist is read again,
 * so a retry after a partial addition sees the tracks already added.
 */
async function presentTrackIds(
  context: TaskJobContext,
  request: SpotifyRequest,
  token: string,
  options: Options,
  current: { snapshotId: string | null; total: number },
) {
  const [stored] = await db
    .select({ snapshotId: playlist.snapshotId })
    .from(playlist)
    .where(eq(playlist.id, options.playlistId))
  if (stored?.snapshotId && stored.snapshotId === current.snapshotId) {
    const rows = z.array(z.object({ spotify_track_id: z.string() })).parse(
      (
        await db.execute(sql`
            select lt.spotify_track_id from playlist_item pi
            join library_track lt on lt.media_item_id = pi.media_item_id
            where pi.playlist_id = ${options.playlistId}`)
      ).rows,
    )
    return new Set(rows.map((row) => row.spotify_track_id))
  }
  const fetched = await readSpotifyTrackEntries(
    context,
    request,
    token,
    `playlists/${options.spotifyPlaylistId}/items`,
    current.total,
  )
  return fetched
    ? new Set(fetched.entries.map((entry) => entry.spotifyTrackId))
    : null
}

/** Queues the playlist's import so the stored copy is read again from Spotify. */
async function queueFollowOnImport(context: TaskJobContext, options: Options) {
  const [row] = await db
    .select()
    .from(playlist)
    .where(eq(playlist.id, options.playlistId))
  const target = row ? storedImportTarget(row) : null
  if (!target) return null
  try {
    const job = await createTaskJob(
      SPOTIFY_PLAYLIST_IMPORT_TASK,
      options.userId,
      { scheduled: true, taskOptions: target },
    )
    return job.id
  } catch (error) {
    if (!(error instanceof ServerError)) throw error
    await context.log(
      'warn',
      `The playlist import could not be queued: ${error.message}`,
    )
    return null
  }
}

/**
 * One addition job: appends the album's tracks that the playlist does not
 * hold yet, in album order and in requests of at most 100, then queues the
 * playlist's import. Nothing is written to the stored playlist directly.
 */
export async function runSpotifyPlaylistAddition(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = OptionsSchema.parse(input)
    await context.assertActive()
    const result = await spotifyOperation(async (request) => {
      const token = await spotifyPlaylistChangeToken(options.userId, request)
      const albumTracks = await albumTrackIds(request, token, options)
      if (!albumTracks.length)
        throw refused(
          'Spotify lists no tracks for the album. Nothing was added.',
        )
      const current = await readSpotifyPlaylist(
        request,
        token,
        options.spotifyPlaylistId,
      )
      if (!current.readable) {
        await markPlaylistNotEditable(options.spotifyPlaylistId)
        throw refused(NOT_WRITABLE)
      }
      const present = await presentTrackIds(
        context,
        request,
        token,
        options,
        current,
      )
      if (!present) return null
      const batches = spotifyTrackAdditions(albumTracks, present)
      const adding = batches.reduce((sum, batch) => sum + batch.length, 0)
      if (current.total + adding > SPOTIFY_PLAYLIST_ITEM_LIMIT)
        throw refused(
          `Spotify playlists hold at most ${SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString('en')} items. Nothing was added.`,
        )
      let added = 0
      for (const uris of batches) {
        // Stop only between requests, so no request is left half-recorded.
        if (!(await context.isActive())) return null
        SpotifySnapshotSchema.parse(
          await spotifyPostJson(
            request,
            token,
            `playlists/${options.spotifyPlaylistId}/items`,
            { uris },
          ),
        )
        added += uris.length
      }
      return { added, alreadyPresent: new Set(albumTracks).size - adding }
    })
    if (!result || !(await context.isActive())) return { outcome: 'stopped' }
    const importJobId = result.added
      ? await queueFollowOnImport(context, options)
      : null
    return {
      outcome: 'complete',
      message: result.added
        ? [
            `Added ${result.added} tracks of ${options.albumTitle} to ${options.playlistName}.`,
            ...(result.alreadyPresent
              ? [`${result.alreadyPresent} were already in the playlist.`]
              : []),
            ...(importJobId ? ['Queued an import of the playlist.'] : []),
          ].join(' ')
        : `Every track of ${options.albumTitle} is already in ${options.playlistName}.`,
      options: {
        added: result.added,
        alreadyPresent: result.alreadyPresent,
        importJobId,
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

/** Queues an album addition, or returns the one already queued or running. */
export async function queueSpotifyPlaylistAddition(
  playlistId: string,
  input: z.infer<typeof PlaylistAlbumAdditionInputSchema>,
  userId: string,
): Promise<PlaylistAlbumAddition> {
  const { albumId } = PlaylistAlbumAdditionInputSchema.parse(input)
  const job = await createTaskJob(SPOTIFY_PLAYLIST_ADD_ALBUM_TASK, userId, {
    taskOptions: { playlistId, albumId },
  })
  return PlaylistAlbumAdditionSchema.parse({
    playlistId,
    albumId,
    job: {
      jobId: job.id,
      status: job.status,
      errorMessage: job.errorMessage,
      finishedAt: job.finishedAt,
      progress: getJobProgress(job.options),
    },
  })
}

/** The latest addition job of an album into each playlist; no Spotify requests. */
export async function listSpotifyPlaylistAdditions(albumId: string) {
  const additions: PlaylistAlbumAddition[] = []
  for (const latest of (
    await latestSpotifyJobs(SPOTIFY_PLAYLIST_ADD_ALBUM_TASK)
  ).values()) {
    const target = RequestSchema.safeParse(latest.options)
    if (target.success && target.data.albumId === albumId)
      additions.push({
        playlistId: target.data.playlistId,
        albumId,
        job: latest.job,
      })
  }
  return PlaylistAlbumAdditionsSchema.parse({ additions })
}
