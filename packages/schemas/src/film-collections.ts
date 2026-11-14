import { z } from 'zod'
import {
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
} from './common'

export const FilmCollectionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  filmCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
})
export type FilmCollectionSummary = z.infer<typeof FilmCollectionSummarySchema>

export const FilmCollectionSortSchema = z.enum([
  'position',
  'title',
  'releaseDate',
  'runtimeMinutes',
  'watched',
  'source',
  'dateAdded',
])
export type FilmCollectionSort = z.infer<typeof FilmCollectionSortSchema>

export const FilmCollectionQuerySchema = PaginationQuerySchema.extend({
  size: PaginationQuerySchema.shape.size.default(100),
  sortBy: FilmCollectionSortSchema.default('position'),
  direction: DirectionSchema.default('asc'),
})
export type FilmCollectionQuery = z.infer<typeof FilmCollectionQuerySchema>

export const FilmCollectionItemSchema = z.object({
  id: z.string(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  artworkUrl: z.string().nullable(),
  releaseDate: z.string().datetime().nullable(),
  runtimeMinutes: z.number().int().nonnegative().nullable(),
  watched: z.boolean(),
  source: z.string().nullable(),
  dateAdded: z.string().datetime(),
})
export type FilmCollectionItem = z.infer<typeof FilmCollectionItemSchema>

export const FilmCollectionDetailSchema = FilmCollectionSummarySchema.extend({
  items: PaginatedDataSchema(FilmCollectionItemSchema),
})
export type FilmCollectionDetail = z.infer<typeof FilmCollectionDetailSchema>
