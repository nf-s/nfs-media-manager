import { z } from 'zod'
import { SpotifyPlaylistJobSchema } from './tracks'

export const SPOTIFY_ARTIST_ALBUMS_TASK = 'spotify-artist-albums'

export const SpotifyArtistAlbumListingSchema = z.object({
  market: z.string().nullable(),
  artistUrl: z.string().nullable(),
  unavailableReason: z.string().nullable(),
  retryAt: z.string().nullable(),
  pagesSaved: z.number().int().nonnegative(),
  releasesSeen: z.number().int().nonnegative(),
  expectedTotal: z.number().int().nonnegative().nullable(),
  completedAt: z.string().nullable(),
  job: SpotifyPlaylistJobSchema.nullable(),
})

export type SpotifyArtistAlbumListing = z.infer<
  typeof SpotifyArtistAlbumListingSchema
>
