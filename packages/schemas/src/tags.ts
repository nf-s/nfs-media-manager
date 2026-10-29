import { z } from 'zod'
import { MediaTypeSchema, PaginatedDataSchema } from './common'

export const SourceNavigationLinkSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  name: z.string(),
  url: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
      } catch {
        return false
      }
    }),
})

export const TagProvenanceQuerySchema = z
  .object({
    mediaType: MediaTypeSchema.optional(),
    mediaId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(1000),
    page: z.coerce.number().int().positive().default(1),
    size: z.coerce.number().int().positive().max(100).default(25),
  })
  .refine((query) => query.mediaType || query.mediaId, {
    message: 'Provide a media type or media item',
    path: ['mediaType'],
  })

export const TagSourceSchema = z.object({
  provider: z.string().nullable(),
  source: z.string().nullable(),
  rawName: z.string(),
  sourceId: z.string().optional(),
  kind: z.string(),
})

export const TagSchema = z.object({
  mediaType: MediaTypeSchema,
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  mediaCount: z.number().int().nonnegative(),
  hidden: z.boolean().default(false),
  mergedNames: z.array(z.string()).default([]),
  sources: z.array(TagSourceSchema),
  sourceCount: z.number().int().nonnegative(),
})

export const TagListQuerySchema = z.object({
  mediaType: MediaTypeSchema.default('film'),
  q: z.string().max(200).optional(),
  visibility: z.enum(['visible', 'hidden', 'all']).default('visible'),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})

export const TagPageSchema = PaginatedDataSchema(TagSchema)
export const TagProvenanceSourceSchema = TagSourceSchema.extend({
  providerLabel: z.string().nullable(),
  onMedia: z.boolean().nullable(),
  link: SourceNavigationLinkSchema.nullable(),
  linkKind: z.enum(['tag', 'item', 'provider-item']).nullable(),
  itemTitle: z.string().optional(),
  linkNote: z.string().optional(),
})
export const TagProvenancePageSchema = PaginatedDataSchema(
  TagProvenanceSourceSchema,
).extend({ tagId: z.string().optional(), mediaType: MediaTypeSchema })
export const TagParamsSchema = z.object({
  id: z.string().min(1).max(200),
})
export const TagDetailQuerySchema = z.object({
  mediaType: MediaTypeSchema,
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})
export const TagDetailSchema = z.object({
  tag: TagSchema,
  aliases: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string() }),
  ),
  provenance: TagProvenancePageSchema,
})
export const SetTagVisibilitySchema = z.object({
  mediaType: MediaTypeSchema,
  tagIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Select each tag only once',
    ),
  hidden: z.boolean(),
})
export const SetTagVisibilityResultSchema = z.object({
  updated: z.number().int().nonnegative(),
  hidden: z.boolean(),
})
export type TagDetailQuery = z.infer<typeof TagDetailQuerySchema>
export type TagDetail = z.infer<typeof TagDetailSchema>
export type SetTagVisibilityInput = z.infer<typeof SetTagVisibilitySchema>
export type SetTagVisibilityResult = z.infer<
  typeof SetTagVisibilityResultSchema
>
export type SourceNavigationLink = z.infer<typeof SourceNavigationLinkSchema>
export type TagProvenanceQuery = z.infer<typeof TagProvenanceQuerySchema>
export type TagProvenancePage = z.infer<typeof TagProvenancePageSchema>
export const MergeTagsSchema = z
  .object({
    mediaType: MediaTypeSchema,
    sourceIds: z.array(z.string().min(1)).min(1).max(100),
    targetId: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (new Set(value.sourceIds).size !== value.sourceIds.length)
      context.addIssue({
        code: 'custom',
        path: ['sourceIds'],
        message: 'Select each source tag only once',
      })
    if (value.sourceIds.includes(value.targetId))
      context.addIssue({
        code: 'custom',
        path: ['targetId'],
        message: 'Target must not be a source tag',
      })
  })
export const MergeTagsResultSchema = z.object({
  merged: z.number().int().nonnegative(),
  targetId: z.string(),
})

export type Tag = z.infer<typeof TagSchema>
export type TagSummary = Tag
export type TagPage = z.infer<typeof TagPageSchema>
export type TagListQuery = z.infer<typeof TagListQuerySchema>
export type MergeTagsInput = z.infer<typeof MergeTagsSchema>
