import { z } from 'zod'
import { PaginationQuerySchema } from './common'

export const LibraryScopeSchema = z.enum(['library', 'outside', 'all'])
export const CatalogNativeKindSchema = z.enum([
  'artist',
  'person',
  'playlist',
  'collection',
  'subscription-source',
  'subscription-item',
])
export type CatalogNativeKind = z.infer<typeof CatalogNativeKindSchema>

export const CatalogScopeQuerySchema = z.object({
  libraryScope: LibraryScopeSchema.optional(),
  discoverySources: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/)
    .max(500)
    .optional(),
  discoverySourceMode: z.enum(['any', 'all', 'exclude']).optional(),
  discoverySourceScope: z.literal('selection').optional(),
})
export type CatalogScopeQuery = z.infer<typeof CatalogScopeQuerySchema>

export const listeningDiscoveryOperations: readonly string[] = [
  'playback',
  'playback-queue',
  'playback-recovery',
  'scrobble',
]

export function isTrackDiscoverySource(operation: string) {
  return !listeningDiscoveryOperations.includes(operation)
}

/** The discovery operations a scope names; Tracks leave out listening ones. */
export function discoveryOperations(
  query: CatalogScopeQuery,
  kind?: CatalogNativeKind | 'track',
) {
  const operations = [...new Set(query.discoverySources?.split(','))]
  return kind === 'track'
    ? operations.filter(isTrackDiscoverySource)
    : operations
}

/** Whether a scope reads library members only: the default scope. */
export function memberScope(query: CatalogScopeQuery, kind?: 'track') {
  return (
    (!query.libraryScope || query.libraryScope === 'library') &&
    !(
      query.discoverySourceScope === 'selection' &&
      discoveryOperations(query, kind).length
    )
  )
}

export const CatalogObservationQuerySchema = PaginationQuerySchema

export const CatalogObservationSchema = z.object({
  id: z.string(),
  provider: z.string(),
  operation: z.string(),
  subjectKind: z.string().nullable(),
  subjectId: z.string().nullable(),
  relationshipRole: z.string().nullable(),
  page: z.number().int().nullable(),
  position: z.number().int().nullable(),
  jobId: z.string().nullable(),
  responseId: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  snapshotId: z.string().nullable(),
  directResponse: z
    .object({
      mediaItemId: z.string(),
      mediaType: z.enum(['album', 'film', 'track']),
    })
    .optional(),
  importId: z.string().nullable(),
  observedAt: z.string(),
})

export const CatalogObservationPageSchema = z.object({
  items: z.array(CatalogObservationSchema),
  page: z.number().int(),
  size: z.number().int(),
  totalCount: z.number().int(),
  pageCount: z.number().int(),
})

const TrackAppearanceTargetSchema = z.object({
  id: z.string(),
  title: z.string(),
})

export const TrackAppearancesSchema = z.object({
  items: z.array(
    z.discriminatedUnion('kind', [
      TrackAppearanceTargetSchema.extend({
        kind: z.literal('album'),
        relationship: z.literal('album'),
        spotifyAlbumId: z
          .string()
          .regex(/^[A-Za-z0-9]{22}$/)
          .optional(),
      }),
      TrackAppearanceTargetSchema.extend({
        kind: z.literal('playlist'),
        relationship: z.literal('playlist'),
      }),
      TrackAppearanceTargetSchema.extend({
        kind: z.literal('track'),
        relationship: z.literal('similar'),
      }),
    ]),
  ),
})
export type TrackAppearances = z.infer<typeof TrackAppearancesSchema>
