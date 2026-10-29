import { z } from 'zod'

export const MediaTypeSchema = z.enum(['album', 'film'])

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(24),
})

export const DirectionSchema = z.enum(['asc', 'desc'])

export const ProviderReferenceSchema = z.object({
  provider: z.string(),
  referenceType: z.string(),
  externalId: z.string(),
  isPrimary: z.boolean(),
  metadata: z.record(z.string(), JsonValueSchema).nullable(),
})

export const ProviderReferenceOverrideSchema = z
  .object({
    provider: z.string().trim().min(1),
    referenceType: z.string().trim().min(1),
    externalId: z.string().trim().min(1).max(1000),
  })
  .transform((value) => {
    const imdb =
      value.referenceType === 'imdb'
        ? value.externalId.match(
            /^(?:https?:\/\/(?:www\.)?imdb\.com\/title\/)?(tt\d+)(?:[/?#].*)?$/i,
          )?.[1]
        : undefined
    return { ...value, externalId: imdb?.toLowerCase() ?? value.externalId }
  })
  .superRefine((value, context) => {
    if (
      (value.referenceType === 'imdb' && !/^tt\d+$/.test(value.externalId)) ||
      (value.referenceType === 'tmdb' && !/^\d+$/.test(value.externalId))
    )
      context.addIssue({
        code: 'custom',
        path: ['externalId'],
        message:
          value.referenceType === 'imdb'
            ? 'Enter an IMDb ID (tt...) or title URL'
            : 'Enter a numeric TMDb ID',
      })
  })

export const ExternalLinkSchema = z.object({
  provider: z.string(),
  label: z.string(),
  url: z.string().url(),
})

export const CreditSchema = z.object({
  name: z.string(),
  role: z.string(),
  billingOrder: z.number().int().nonnegative(),
})

export const TagSchema = z.object({
  name: z.string(),
  kind: z.string(),
})

export const PlaylistMembershipSchema = z.object({
  name: z.string(),
  kind: z.enum(['playlist', 'collection']),
  position: z.number().int().nonnegative(),
})

export const PaginatedDataSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    page: z.number().int().positive(),
    size: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    items: z.array(itemSchema),
  })
