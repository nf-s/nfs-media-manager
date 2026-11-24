import { z } from 'zod'

export const SpotifyAlbumReferenceInputSchema = z.object({
  trackId: z.string().min(1).max(500),
  spotifyAlbumId: z.string().regex(/^[A-Za-z0-9]{22}$/),
  add: z.boolean().optional(),
})
export type SpotifyAlbumReferenceInput = z.infer<
  typeof SpotifyAlbumReferenceInputSchema
>

export const SpotifyAlbumReferenceResultSchema = z.object({
  mediaItemId: z.string(),
  jobId: z.string().optional(),
})
