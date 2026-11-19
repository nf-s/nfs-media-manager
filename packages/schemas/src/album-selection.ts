import { z } from 'zod'
import { AlbumListItemSchema, AlbumQuerySchema } from './media'
import { PaginatedDataSchema } from './common'
import { CoverageGapSchema, CoverageQuerySchema } from './coverage'
import {
  QueueFilmSelectionSchema,
  selectionItemFields,
  selectionProviderRequired,
  selectionQueryFields,
} from './film-selection'

export const AlbumSelectionQuerySchema = AlbumQuerySchema.extend({
  ...selectionQueryFields,
  sortBy: AlbumQuerySchema.shape.sortBy.default('dateAdded'),
}).refine(
  selectionProviderRequired,
  'Choose a provider for legacy freshness sorting or filtering',
)
export const AlbumSelectionItemSchema = AlbumListItemSchema.extend({
  ...selectionItemFields,
})
export const AlbumSelectionPageSchema = PaginatedDataSchema(
  AlbumSelectionItemSchema,
)
export const QueueAlbumSelectionSchema = QueueFilmSelectionSchema.extend({
  coverageGap: CoverageQuerySchema.extend({
    gap: CoverageGapSchema,
  }).optional(),
}).refine(
  ({ coverageGap, freshness, olderThanDays }) =>
    !coverageGap || (freshness === undefined && olderThanDays === undefined),
  'Coverage gaps and scrape freshness are separate filters',
)
export type AlbumSelectionItem = z.infer<typeof AlbumSelectionItemSchema>
