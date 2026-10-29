import { z } from 'zod'
import { SourceNavigationLinkSchema } from './tags'

export const AlbumProviderDetailUrlSchema = SourceNavigationLinkSchema.shape.url

export const AlbumProviderDetailsSchema = z.object({
  provider: z.enum(['musicbrainz', 'discogs', 'lastfm']),
  url: AlbumProviderDetailUrlSchema.optional(),
  facts: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .default([]),
  notes: z.array(z.object({ label: z.string(), text: z.string() })).default([]),
  credits: z
    .array(z.object({ name: z.string(), role: z.string() }))
    .default([]),
  links: z
    .array(z.object({ label: z.string(), url: AlbumProviderDetailUrlSchema }))
    .default([]),
  tags: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string(),
        count: z.number().finite().optional(),
        countLabel: z.string().optional(),
      }),
    )
    .default([]),
  tracks: z
    .array(
      z.object({
        title: z.string(),
        position: z.string().optional(),
        url: AlbumProviderDetailUrlSchema.optional(),
      }),
    )
    .default([]),
})

export type AlbumProviderDetails = z.infer<typeof AlbumProviderDetailsSchema>
