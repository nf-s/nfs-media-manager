import { z } from 'zod'
import { FilmListItemSchema, FilmQuerySchema } from './media'
import { PaginatedDataSchema } from './common'
import type { BrowseField } from './browse'

export const lastScrapedField: BrowseField = {
  key: 'lastScrapedAt',
  label: 'Last scraped',
  type: 'date',
  filterable: false,
}

export const ProviderFreshnessFilterSchema = z.discriminatedUnion('mode', [
  z.object({ provider: z.string().min(1), mode: z.literal('all') }),
  z.object({ provider: z.string().min(1), mode: z.literal('never') }),
  z.object({ provider: z.string().min(1), mode: z.literal('failed') }),
  z.object({ provider: z.string().min(1), mode: z.literal('unscraped') }),
  z.object({
    provider: z.string().min(1),
    mode: z.literal('older'),
    olderThanDays: z.number().int().min(1).max(3650),
  }),
])
export type ProviderFreshnessFilter = z.infer<
  typeof ProviderFreshnessFilterSchema
>
export const ProviderFreshnessFiltersSchema = z
  .array(ProviderFreshnessFilterSchema)
  .max(20)
  .refine(
    (filters) =>
      new Set(filters.map((filter) => filter.provider)).size === filters.length,
    'Only one freshness filter is allowed per provider',
  )
const FreshnessParamSchema = z.preprocess((value) => {
  if (value === undefined) return []
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, ProviderFreshnessFiltersSchema)

export const selectionQueryFields = {
  provider: z.string().min(1).optional(),
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  freshness: FreshnessParamSchema,
}
export const selectionProviderRequired = (query: {
  provider?: string
  olderThanDays?: number
  sortBy: string
}) =>
  !!query.provider ||
  (query.sortBy !== 'lastScrapedAt' && query.olderThanDays === undefined)

export const FilmSelectionQuerySchema = FilmQuerySchema.extend({
  ...selectionQueryFields,
  sortBy: FilmQuerySchema.shape.sortBy.default('dateAdded'),
}).refine(
  selectionProviderRequired,
  'Choose a provider for legacy freshness sorting or filtering',
)
export const ProviderScrapeAttemptSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  jobId: z.string(),
})
export const selectionItemFields = {
  lastScrapedAt: z.string().nullable(),
  hasProviderIdentifier: z.boolean(),
  providerFreshness: z.record(
    z.string(),
    z.object({
      lastScrapedAt: z.string().datetime().nullable(),
      hasProviderIdentifier: z.boolean(),
      lastAttempt: ProviderScrapeAttemptSchema.nullable().default(null),
    }),
  ),
}
export const FilmSelectionItemSchema = FilmListItemSchema.extend({
  ...selectionItemFields,
})
export const FilmSelectionPageSchema = PaginatedDataSchema(
  FilmSelectionItemSchema,
)
export type FilmSelectionItem = z.infer<typeof FilmSelectionItemSchema>
export const QueueFilmSelectionSchema = z.object({
  providers: z.array(z.string().min(1)).min(1).max(20),
  mediaItemIds: z.array(z.string().min(1)).min(1).max(100),
  olderThanDays: z.number().int().min(1).max(3650).optional(),
  freshness: ProviderFreshnessFiltersSchema.optional(),
  confirmBroadRun: z.boolean().default(false),
  batchId: z.string().uuid(),
})
