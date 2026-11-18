import { z } from 'zod'
import { BrowsePageSliceSchema } from './browse'
import { PaginatedDataSchema } from './common'
import {
  CollectionItemSchema,
  CollectionQuerySchema,
  CollectionSummarySchema,
} from './collections'

export const AlbumCollectionSummarySchema = CollectionSummarySchema.extend({
  albumCount: z.number().int().nonnegative(),
})
export type AlbumCollectionSummary = z.infer<
  typeof AlbumCollectionSummarySchema
>

export const AlbumCollectionBrowseSortSchema = z.enum([
  'name',
  'albumCount',
  'createdAt',
])
export type AlbumCollectionBrowseSort = z.infer<
  typeof AlbumCollectionBrowseSortSchema
>

export const AlbumCollectionBrowseQuerySchema = CollectionQuerySchema.extend({
  sortBy: AlbumCollectionBrowseSortSchema.default('name'),
})
export type AlbumCollectionBrowseQuery = z.infer<
  typeof AlbumCollectionBrowseQuerySchema
>

export const AlbumCollectionBrowsePageSchema = BrowsePageSliceSchema(
  AlbumCollectionSummarySchema,
)
export type AlbumCollectionBrowsePage = z.infer<
  typeof AlbumCollectionBrowsePageSchema
>

export const AlbumCollectionSortSchema = z.enum([
  'position',
  'title',
  'artists',
  'releaseDate',
  'durationSec',
  'source',
  'dateAdded',
])
export type AlbumCollectionSort = z.infer<typeof AlbumCollectionSortSchema>

export const AlbumCollectionQuerySchema = CollectionQuerySchema.extend({
  sortBy: AlbumCollectionSortSchema.default('position'),
})
export type AlbumCollectionQuery = z.infer<typeof AlbumCollectionQuerySchema>

export const AlbumCollectionItemSchema = CollectionItemSchema.extend({
  artists: z.array(z.string()),
  durationSec: z.number().int().nonnegative().nullable(),
})
export type AlbumCollectionItem = z.infer<typeof AlbumCollectionItemSchema>

export const AlbumCollectionDetailSchema = AlbumCollectionSummarySchema.extend({
  items: PaginatedDataSchema(AlbumCollectionItemSchema),
})
export type AlbumCollectionDetail = z.infer<typeof AlbumCollectionDetailSchema>
