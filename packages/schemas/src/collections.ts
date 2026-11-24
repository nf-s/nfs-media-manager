import { z } from 'zod'
import { DirectionSchema, PaginationQuerySchema } from './common'
import { SourceNavigationLinkSchema } from './tags'
import { CatalogScopeQuerySchema } from './catalog'

export const CollectionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceLinks: z.array(SourceNavigationLinkSchema).default([]),
  createdAt: z.string().datetime(),
})

export const CollectionQuerySchema = PaginationQuerySchema.extend({
  ...CatalogScopeQuerySchema.shape,
  q: z.string().trim().max(200).optional(),
  size: PaginationQuerySchema.shape.size.default(100),
  direction: DirectionSchema.default('asc'),
  includeSources: z.enum(['true', 'false']).optional(),
})
export type CollectionQuery = z.infer<typeof CollectionQuerySchema>

export const CollectionItemSchema = z.object({
  id: z.string(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  artworkUrl: z.string().nullable(),
  releaseDate: z.string().datetime().nullable(),
  source: z.string().nullable(),
  dateAdded: z.string().datetime().nullable(),
})
