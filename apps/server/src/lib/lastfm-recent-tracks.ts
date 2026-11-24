import { z } from 'zod'
import { AlbumCountSchema } from '@/plugins/builtin/album-provider-helpers'

const NamedSchema = z.object({
  '#text': z.string(),
  mbid: z.string().optional(),
})
const ScrobbleSchema = z.object({
  artist: NamedSchema,
  album: NamedSchema.optional(),
  name: z.string(),
  mbid: z.string().optional(),
  date: z.object({ uts: AlbumCountSchema }).optional(),
  '@attr': z.object({ nowplaying: z.string().optional() }).optional(),
})
export const RecentTracksSchema = z.object({
  recenttracks: z.object({
    // Last.fm returns a bare object when a page holds one track.
    track: z.union([z.array(ScrobbleSchema), ScrobbleSchema]).optional(),
    '@attr': z.object({
      page: AlbumCountSchema,
      totalPages: AlbumCountSchema,
      user: z.string().optional(),
      total: AlbumCountSchema.optional(),
    }),
  }),
})
