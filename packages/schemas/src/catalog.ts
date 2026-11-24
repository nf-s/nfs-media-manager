import { z } from 'zod'
import { PaginationQuerySchema } from './common'

export const LibraryScopeSchema = z.enum(['library', 'outside', 'all'])
export const CatalogNativeKindSchema = z.enum(['artist', 'person', 'playlist', 'collection', 'subscription-source', 'subscription-item'])
export type CatalogNativeKind = z.infer<typeof CatalogNativeKindSchema>

export const CatalogScopeQuerySchema = z.object({
  libraryScope: LibraryScopeSchema.optional(),
  discoverySources: z.string().regex(/^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/).max(500).optional(),
  discoverySourceMode: z.enum(['any', 'all', 'exclude']).optional(),
  discoverySourceScope: z.literal('selection').optional(),
})
export type CatalogScopeQuery = z.infer<typeof CatalogScopeQuerySchema>

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
