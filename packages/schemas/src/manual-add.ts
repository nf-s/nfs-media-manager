import { z } from 'zod'

export const ManualMediaSearchInputSchema = z
  .object({
    mediaType: z.enum(['album', 'film', 'track']),
    q: z.string().trim().min(1).max(200),
    page: z.number().int().min(1).max(50).default(1),
    /** Show saved catalog releases only when their identity matches exactly. */
    exactMembership: z.boolean().optional(),
  })
  .strict()

export const ManualMediaSearchItemSchema = z.object({
  externalId: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  releaseDate: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  url: z.string().url(),
  mediaItemId: z.string().nullable(),
  catalogMediaItemId: z.string().min(1).optional(),
  membershipAmbiguous: z.literal(true).optional(),
  /** How many tracks an album result has, when the provider says. */
  trackCount: z.number().int().nonnegative().optional(),
})

export const ManualMediaSearchResultSchema = z.object({
  items: z.array(ManualMediaSearchItemSchema).max(20),
  page: z.number().int().min(1).max(50),
  hasMore: z.boolean(),
  totalCount: z.number().int().nonnegative().optional(),
})

const SpotifyAlbumInputSchema = z
  .object({
    mediaType: z.literal('album'),
    externalId: z.string().regex(/^[A-Za-z0-9]{22}$/),
  })
  .strict()

const SpotifyTrackInputSchema = SpotifyAlbumInputSchema.extend({
  mediaType: z.literal('track'),
})

export const ManualMediaAddInputSchema = z.discriminatedUnion('mediaType', [
  SpotifyAlbumInputSchema,
  SpotifyTrackInputSchema,
  z
    .object({
      mediaType: z.literal('film'),
      externalId: z.string().regex(/^[1-9]\d{0,14}$/),
    })
    .strict(),
])

export const ManualMediaAddResultSchema = z.object({
  mediaItemId: z.string().min(1),
  created: z.boolean(),
})

export const CatalogMembershipInputSchema = z
  .object({
    items: z
      .array(
        z.discriminatedUnion('mediaType', [
          SpotifyAlbumInputSchema,
          SpotifyTrackInputSchema.extend({
            recording: z
              .strictObject({
                title: z.string().trim().min(1).max(2000),
                artists: z
                  .array(z.string().trim().min(1).max(2000))
                  .min(1)
                  .max(200),
                spotifyAlbumId: SpotifyAlbumInputSchema.shape.externalId,
                albumName: z.string().max(2000),
              })
              .optional(),
          }),
        ]),
      )
      .min(1)
      .max(2000),
  })
  .strict()

export const CatalogMembershipResultSchema = z.object({
  items: z.array(
    z.object({
      mediaType: z.enum(['track', 'album']),
      externalId: z.string(),
      mediaItemId: z.string().nullable(),
      ambiguous: z.boolean(),
    }),
  ),
})

export type CatalogMembershipInput = z.infer<
  typeof CatalogMembershipInputSchema
>
export type CatalogMembershipResult = z.infer<
  typeof CatalogMembershipResultSchema
>

export type ManualMediaSearchInput = z.input<
  typeof ManualMediaSearchInputSchema
>
export type ManualMediaSearchItem = z.infer<typeof ManualMediaSearchItemSchema>
export type ManualMediaSearchResult = z.infer<
  typeof ManualMediaSearchResultSchema
>
export type ManualMediaAddInput = z.infer<typeof ManualMediaAddInputSchema>
export type ManualMediaAddResult = z.infer<typeof ManualMediaAddResultSchema>
