import { z } from 'zod'
import { CatalogScopeQuerySchema } from './catalog'
import { CreatorIdSchema, PaginatedDataSchema } from './common'
import { ProviderFreshnessFiltersSchema } from './film-selection'
import { JobSchema } from './job'
import { uniqueMusicTags } from './music-tags'
import { SourceNavigationLinkSchema, TagReleaseSupportSchema } from './tags'
import { EntityRelationshipSchema } from './entity-relationships'

export const ARTIST_ENRICHMENT_TASK = 'artist-enrichment'

export const ArtistProfileProviderSchema = z.enum([
  'spotify',
  'lastfm',
  'discogs',
  'musicbrainz',
])
export type ArtistProfileProvider = z.infer<typeof ArtistProfileProviderSchema>

export const ArtistProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)
export type ArtistProviderId = z.infer<typeof ArtistProviderIdSchema>

export const ArtistIdentifierSchema = z.object({
  provider: ArtistProviderIdSchema,
  externalId: z.string().nullable(),
  status: z.enum(['confirmed', 'inferred', 'conflict', 'missing']),
  url: SourceNavigationLinkSchema.shape.url.nullable(),
})
export type ArtistIdentifier = z.infer<typeof ArtistIdentifierSchema>

export const ArtistIdentifierSourceSchema = z.object({
  externalId: z.string(),
  provider: ArtistProviderIdSchema,
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
export const ArtistSimilarCandidateSchema = z.object({
  name: ProfileTextSchema,
  externalId: ProfileTextSchema.max(1000).optional(),
})

export const ArtistProfileSchema = z.object({
  name: ProfileTextSchema.optional(),
  summary: ProfileTextSchema.optional(),
  artworkUrl: ProfileUrlSchema.optional(),
  country: ProfileTextSchema.optional(),
  type: ProfileTextSchema.optional(),
  externalId: ProfileTextSchema.optional(),
  url: ProfileUrlSchema.optional(),
  tags: z.array(z.string()).transform(uniqueMusicTags).default([]),
  tagReleaseSupport: z
    .array(TagReleaseSupportSchema.safeExtend({ name: ProfileTextSchema }))
    .optional(),
  relationships: z.array(EntityRelationshipSchema).max(100).optional(),
  similarArtists: z
    .array(
      ArtistSimilarCandidateSchema.extend({
        artistId: CreatorIdSchema.optional(),
      }),
    )
    .max(100)
    .optional(),
})
export type ArtistProfile = z.infer<typeof ArtistProfileSchema>

export const ArtistProviderSnapshotSchema = z.object({
  id: z.string(),
  provider: ArtistProviderIdSchema,
  profile: ArtistProfileSchema,
  scrapeJobId: z.string().nullable(),
  createdAt: z.string().datetime(),
})
export type ArtistProviderSnapshot = z.infer<
  typeof ArtistProviderSnapshotSchema
>

export const ArtistVerificationProviderSchema = z.enum(['spotify', 'lastfm'])
export type ArtistVerificationProvider = z.infer<
  typeof ArtistVerificationProviderSchema
>
const ArtistVerificationSnapshotIdSchema = z.string().trim().min(1).max(500)

export const ArtistVerificationResultSchema = z.object({
  snapshotId: ArtistVerificationSnapshotIdSchema,
  verdict: z.enum(['verified', 'conflict', 'insufficient', 'stale']),
  reason: z.string().min(1).max(100),
  evidenceCount: z.number().int().min(0).max(50),
})
export type ArtistVerificationResult = z.infer<
  typeof ArtistVerificationResultSchema
>

export const ArtistEnrichmentInputSchema = z
  .object({
    provider: ArtistProviderIdSchema,
    providerArtistId: z.string().trim().min(1).max(1000).optional(),
    verifySnapshotId: ArtistVerificationSnapshotIdSchema.optional(),
  })
  .strict()
  .superRefine(({ provider, providerArtistId, verifySnapshotId }, context) => {
    if (verifySnapshotId === undefined) return
    if (providerArtistId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['providerArtistId'],
        message: 'Choose a snapshot to verify or enter a provider identifier.',
      })
    if (!ArtistVerificationProviderSchema.safeParse(provider).success)
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Saved match verification supports Spotify and Last.fm.',
      })
  })
export type ArtistEnrichmentInput = z.infer<typeof ArtistEnrichmentInputSchema>

export const ArtistFreshnessFiltersSchema =
  ProviderFreshnessFiltersSchema.refine(
    (filters) =>
      filters.every(
        (filter) => ArtistProviderIdSchema.safeParse(filter.provider).success,
      ),
    'Choose artist enrichment providers',
  )

export const QueueArtistSelectionSchema = z
  .object({
    ...CatalogScopeQuerySchema.shape,
    artistIds: z.array(CreatorIdSchema).min(1).max(100),
    providers: z.array(ArtistProviderIdSchema).min(1).max(20),
    freshness: ArtistFreshnessFiltersSchema.optional(),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
export type QueueArtistSelection = z.infer<typeof QueueArtistSelectionSchema>

export const ArtistEnrichmentResultSchema = z.object({
  jobs: z.array(JobSchema),
  skipped: z.array(
    z.object({
      artistId: CreatorIdSchema,
      provider: ArtistProviderIdSchema,
      reason: z.string(),
    }),
  ),
})
export type ArtistEnrichmentResult = z.infer<
  typeof ArtistEnrichmentResultSchema
>
