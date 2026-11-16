import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import { uniqueMusicTags } from './music-tags'
import { SourceNavigationLinkSchema } from './tags'

export const ARTIST_ENRICHMENT_TASK = 'artist-enrichment'

export const ArtistProfileProviderSchema = z.enum([
  'spotify',
  'lastfm',
  'discogs',
  'musicbrainz',
])
export type ArtistProfileProvider = z.infer<typeof ArtistProfileProviderSchema>

export const ArtistIdentifierSchema = z.object({
  provider: ArtistProfileProviderSchema,
  externalId: z.string().nullable(),
  status: z.enum(['confirmed', 'inferred', 'conflict', 'missing']),
  url: SourceNavigationLinkSchema.shape.url.nullable(),
})
export type ArtistIdentifier = z.infer<typeof ArtistIdentifierSchema>

export const ArtistIdentifierSourceSchema = z.object({
  externalId: z.string(),
  provider: ArtistProfileProviderSchema,
  kind: z.enum(['album', 'track', 'artist']),
  id: z.string(),
  title: z.string(),
  snapshotId: z.string().nullable(),
  jobId: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
})
export type ArtistIdentifierSource = z.infer<
  typeof ArtistIdentifierSourceSchema
>
export const ArtistIdentifierSourcePageSchema = PaginatedDataSchema(
  ArtistIdentifierSourceSchema,
)
export type ArtistIdentifierSourcePage = z.infer<
  typeof ArtistIdentifierSourcePageSchema
>

const ProfileTextSchema = z.string().trim().min(1)
const ProfileUrlSchema = SourceNavigationLinkSchema.shape.url

export const ArtistProfileSchema = z.object({
  name: ProfileTextSchema.optional(),
  summary: ProfileTextSchema.optional(),
  artworkUrl: ProfileUrlSchema.optional(),
  country: ProfileTextSchema.optional(),
  type: ProfileTextSchema.optional(),
  externalId: ProfileTextSchema.optional(),
  url: ProfileUrlSchema.optional(),
  tags: z.array(z.string()).transform(uniqueMusicTags).default([]),
})
export type ArtistProfile = z.infer<typeof ArtistProfileSchema>

export const ArtistProviderSnapshotSchema = z.object({
  id: z.string(),
  provider: ArtistProfileProviderSchema,
  profile: ArtistProfileSchema,
  scrapeJobId: z.string().nullable(),
  createdAt: z.string().datetime(),
})
export type ArtistProviderSnapshot = z.infer<
  typeof ArtistProviderSnapshotSchema
>

export const ArtistEnrichmentInputSchema = z
  .object({
    provider: ArtistProfileProviderSchema,
    providerArtistId: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
export type ArtistEnrichmentInput = z.infer<typeof ArtistEnrichmentInputSchema>
