import { z } from 'zod'
import { BrowsePageSliceSchema } from './browse'
import { PaginatedDataSchema } from './common'
import {
  CollectionItemSchema,
  CollectionQuerySchema,
  CollectionSummarySchema,
} from './collections'

export const FilmCollectionSummarySchema = CollectionSummarySchema.extend({
  filmCount: z.number().int().nonnegative(),
})
export type FilmCollectionSummary = z.infer<typeof FilmCollectionSummarySchema>

export const FilmCollectionBrowseSortSchema = z.enum([
  'name',
  'filmCount',
  'createdAt',
])
export type FilmCollectionBrowseSort = z.infer<
  typeof FilmCollectionBrowseSortSchema
>

export const FilmCollectionBrowseQuerySchema = CollectionQuerySchema.extend({
  sortBy: FilmCollectionBrowseSortSchema.default('name'),
})
export type FilmCollectionBrowseQuery = z.infer<
  typeof FilmCollectionBrowseQuerySchema
>

export const FilmCollectionBrowsePageSchema = BrowsePageSliceSchema(
  FilmCollectionSummarySchema,
)
export type FilmCollectionBrowsePage = z.infer<
  typeof FilmCollectionBrowsePageSchema
>

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

const WatchedStatesParamSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  },
  z
    .array(z.enum(['watched', 'unwatched']))
    .max(2)
    .transform((values) => [...new Set(values)])
    .optional(),
)

export const FilmCollectionQuerySchema = CollectionQuerySchema.extend({
  watched: z.enum(['watched', 'unwatched']).optional(),
  watchedStates: WatchedStatesParamSchema,
  sortBy: FilmCollectionSortSchema.default('position'),
})
export type FilmCollectionQuery = z.infer<typeof FilmCollectionQuerySchema>

export const FilmCollectionItemSchema = CollectionItemSchema.extend({
  runtimeMinutes: z.number().int().nonnegative().nullable(),
  watched: z.boolean(),
})
export type FilmCollectionItem = z.infer<typeof FilmCollectionItemSchema>

export const FilmCollectionDetailSchema = FilmCollectionSummarySchema.extend({
  items: PaginatedDataSchema(FilmCollectionItemSchema),
})
export type FilmCollectionDetail = z.infer<typeof FilmCollectionDetailSchema>
