import { z } from 'zod'
import { CreatorIdSchema } from './common'
import { ArtistMetadataQuerySchema } from './creators'

export const CreateArtistSelectionSnapshotSchema = z
  .object({ query: ArtistMetadataQuerySchema })
  .strict()
export type CreateArtistSelectionSnapshot = z.infer<
  typeof CreateArtistSelectionSnapshotSchema
>

export const ArtistSelectionSnapshotSchema = z.object({
  id: z.string().min(1),
  totalCount: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
})
export type ArtistSelectionSnapshot = z.infer<
  typeof ArtistSelectionSnapshotSchema
>

export const ArtistSelectionSnapshotParamsSchema = z.object({
  selectionId: z.string().min(1).max(100),
})
export const ArtistSelectionSnapshotPageQuerySchema = z
  .object({
    after: CreatorIdSchema.optional(),
    size: z.coerce.number().int().min(1).max(100).default(100),
    ids: z.preprocess((value) => {
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }, z.array(CreatorIdSchema).min(1).max(100).optional()),
  })
  .refine(
    (query) => query.ids === undefined || query.after === undefined,
    'Use either an artist ID list or a page cursor',
  )
export type ArtistSelectionSnapshotPageQuery = z.infer<
  typeof ArtistSelectionSnapshotPageQuerySchema
>
export const ArtistSelectionSnapshotPageSchema =
  ArtistSelectionSnapshotSchema.omit({ id: true }).extend({
    ids: z.array(CreatorIdSchema).max(100),
    nextCursor: CreatorIdSchema.nullable(),
  })
export type ArtistSelectionSnapshotPage = z.infer<
  typeof ArtistSelectionSnapshotPageSchema
>
