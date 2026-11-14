import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getJobProgress } from '@repo/schemas/job'
import {
  SPOTIFY_PLAYLIST_ADD_TRACK_TASK,
  TrackPlaylistAdditionInputSchema,
  TrackPlaylistAdditionSchema,
  TrackPlaylistAdditionsSchema,
  type TrackPlaylistAddition,
} from '@repo/schemas/track-playlist-additions'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { trackSpotifyIdExpression } from './track-values'
import { latestSpotifyJobs, refused } from './spotify-playlist-state'
import {
  appendSpotifyPlaylistTracks,
  prepareSpotifyPlaylistWrite,
  queuePlaylistImportAfterAddition,
} from './spotify-playlist-additions'

const RequestSchema = z.object({
  trackId: z.string().min(1).max(200),
  playlistId: z.string().min(1).max(200),
})
const OptionsSchema = RequestSchema.extend({
  userId: z.string().min(1),
  groupKey: z.string().min(1),
  spotifyPlaylistId: SpotifyIdSchema,
  playlistName: z.string(),
  spotifyTrackId: SpotifyIdSchema,
  trackTitle: z.string(),
})
const TrackRowsSchema = z.array(
  z.object({
    title: z.string(),
    spotify_track_id: z.string().nullable(),
  }),
)
const IdentityRowsSchema = z.array(
  z.object({ id: z.string(), spotify_track_id: z.string().nullable() }),
)

async function resolvedAdditionTrackIds(trackId: string, spotifyIds: string[]) {
  if (!spotifyIds.length) return new Map<string, string | null>()
  const rows = IdentityRowsSchema.parse(
    (
      await db.execute(sql`
    select mi.id, lt.spotify_track_id from media_item mi
    join library_track lt on lt.media_item_id = mi.id
    where mi.media_type = 'track' and mi.metadata->>'legacyHidden' is distinct from 'true'
      and (mi.id = ${trackId} or lt.spotify_track_id in (${sql.join(
        spotifyIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`)
    ).rows,
  )
  const original = rows.find((row) => row.id === trackId)
  return new Map(
    spotifyIds.map((spotifyId) => [
      spotifyId,
      original?.id ??
        rows.find((row) => row.spotify_track_id === spotifyId)?.id ??
        null,
    ]),
  )
}

/** Uses the same stored recording identity as playback; never searches Spotify. */
async function trackSpotifyReference(trackId: string) {
  const [track] = TrackRowsSchema.parse(
    (
      await db.execute(sql`
    select mi.title,
      ${trackSpotifyIdExpression(sql`lt.spotify_track_id`, sql`lt.album_media_item_id`, sql`mi.title`)} as spotify_track_id
    from media_item mi join library_track lt on lt.media_item_id = mi.id
    where mi.id = ${trackId} and mi.media_type = 'track'
      and mi.metadata->>'legacyHidden' is distinct from 'true'`)
    ).rows,
  )
  if (!track)
    throw new ServerError({ statusCode: 404, message: 'Track not found' })
  const spotifyId = SpotifyIdSchema.safeParse(track.spotify_track_id)
  if (!spotifyId.success)
    throw refused('Match this track to Spotify before adding it to a playlist.')
  return { title: track.title, spotifyId: spotifyId.data }
}

export async function prepareSpotifyTrackPlaylistAddition(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const { trackId, playlistId } = RequestSchema.parse(input)
  const target = await prepareSpotifyPlaylistWrite(userId, playlistId, 'track')
  const track = await trackSpotifyReference(trackId)
  return {
    ...target,
    trackId,
    groupKey: `spotify-add-track:${playlistId}:${trackId}`,
    spotifyTrackId: track.spotifyId,
    trackTitle: track.title,
  }
}

export async function runSpotifyTrackPlaylistAddition(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = OptionsSchema.parse(input)
    await context.assertActive()
    const target = await prepareSpotifyPlaylistWrite(
      options.userId,
      options.playlistId,
      'track',
    )
    const track = await trackSpotifyReference(options.trackId)
    if (
      target.spotifyPlaylistId !== options.spotifyPlaylistId ||
      track.spotifyId !== options.spotifyTrackId
    )
      throw refused(
        'The track or playlist identity changed. Queue the addition again.',
      )
    const result = await appendSpotifyPlaylistTracks(
      context,
      options,
      async () => [options.spotifyTrackId],
    )
    if (!result || !(await context.isActive())) return { outcome: 'stopped' }
    const importJobId = result.refreshNeeded
      ? await queuePlaylistImportAfterAddition(context, options)
      : null
    return {
      outcome: 'complete',
      message: [
        result.added
          ? `Added ${options.trackTitle} to ${options.playlistName}.`
          : `${options.trackTitle} is already in ${options.playlistName}.`,
        ...(importJobId ? ['Queued an import of the playlist.'] : []),
      ].join(' '),
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

export async function queueSpotifyTrackPlaylistAddition(
  trackId: string,
  input: z.infer<typeof TrackPlaylistAdditionInputSchema>,
  userId: string,
): Promise<TrackPlaylistAddition> {
  const { playlistId } = TrackPlaylistAdditionInputSchema.parse(input)
  const job = await createTaskJob(SPOTIFY_PLAYLIST_ADD_TRACK_TASK, userId, {
    taskOptions: { trackId, playlistId },
  })
  const options = OptionsSchema.parse(job.options)
  const resolved = await resolvedAdditionTrackIds(trackId, [
    options.spotifyTrackId,
  ])
  return TrackPlaylistAdditionSchema.parse({
    trackId,
    resolvedTrackId: resolved.get(options.spotifyTrackId) ?? null,
    playlistId,
    job: {
      jobId: job.id,
      status: job.status,
      errorMessage: job.errorMessage,
      finishedAt: job.finishedAt,
      progress: getJobProgress(job.options),
    },
  })
}

/** Latest track-addition jobs by playlist; reading them makes no provider requests. */
export async function listSpotifyTrackPlaylistAdditions(trackId: string) {
  const matching = [
    ...(await latestSpotifyJobs(SPOTIFY_PLAYLIST_ADD_TRACK_TASK)).values(),
  ].flatMap((latest) => {
    const target = OptionsSchema.safeParse(latest.options)
    return target.success && target.data.trackId === trackId
      ? [{ options: target.data, job: latest.job }]
      : []
  })
  const resolved = await resolvedAdditionTrackIds(
    trackId,
    matching.map((item) => item.options.spotifyTrackId),
  )
  const additions: TrackPlaylistAddition[] = matching.map(
    ({ options, job }) => ({
      trackId,
      resolvedTrackId: resolved.get(options.spotifyTrackId) ?? null,
      playlistId: options.playlistId,
      job,
    }),
  )
  return TrackPlaylistAdditionsSchema.parse({ additions })
}
