import { z } from 'zod'
import { SpotifyPlaylistJobSchema } from './tracks'

export const SPOTIFY_PLAYLIST_ADD_TRACK_TASK = 'spotify-playlist-add-track'

export const TrackPlaylistAdditionInputSchema = z
  .object({ playlistId: z.string().min(1).max(200) })
  .strict()

/** The latest job adding one library track to an imported Spotify playlist. */
export const TrackPlaylistAdditionSchema = z.object({
  trackId: z.string(),
  /** Current library identity after a follow-on import may replace a Last.fm row. */
  resolvedTrackId: z.string().nullable(),
  playlistId: z.string(),
  job: SpotifyPlaylistJobSchema,
})
export type TrackPlaylistAddition = z.infer<typeof TrackPlaylistAdditionSchema>

export const TrackPlaylistAdditionsSchema = z.object({
  additions: z.array(TrackPlaylistAdditionSchema),
})
