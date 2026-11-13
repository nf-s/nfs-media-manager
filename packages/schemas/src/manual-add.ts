import { z } from 'zod'

export const ManualMediaSearchInputSchema = z
  .object({
    mediaType: z.enum(['album', 'film']),
    q: z.string().trim().min(1).max(200),
    page: z.number().int().min(1).max(50).default(1),
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
})

export const ManualMediaSearchResultSchema = z.object({
  items: z.array(ManualMediaSearchItemSchema).max(20),
  page: z.number().int().min(1).max(50),
  hasMore: z.boolean(),
})

export const ManualMediaAddInputSchema = z.discriminatedUnion('mediaType', [
  z
    .object({
      mediaType: z.literal('album'),
      externalId: z.string().regex(/^[A-Za-z0-9]{22}$/),
    })
    .strict(),
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

export type ManualMediaSearchInput = z.input<
  typeof ManualMediaSearchInputSchema
>
export type ManualMediaSearchItem = z.infer<typeof ManualMediaSearchItemSchema>
export type ManualMediaSearchResult = z.infer<
  typeof ManualMediaSearchResultSchema
>
export type ManualMediaAddInput = z.infer<typeof ManualMediaAddInputSchema>
export type ManualMediaAddResult = z.infer<typeof ManualMediaAddResultSchema>
