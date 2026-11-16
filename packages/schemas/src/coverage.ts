import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import { PlaylistDetailQuerySchema, PlaylistEntrySchema } from './tracks'

/** IDs returned per list; the album queue accepts at most 100 per request. */
export const COVERAGE_ITEM_ID_LIMIT = 100

export const CoverageQuerySchema = z.object({
  /** Same freshness rule and default as album and film refreshes. */
  olderThanDays: z.coerce.number().int().min(1).max(3650).default(180),
})

/**
 * `credentials-missing`: a required credential is not configured, so queued
 * jobs would be skipped. `halted`: provider requests are halted.
 */
export const CoverageUnavailableReasonSchema = z.enum([
  'credentials-missing',
  'halted',
])

export const ProviderCoverageSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  /**
   * Albums the provider has scraped or can look up from a stored identifier
   * or by name. The others need an identifier before they can be queued.
   */
  eligible: z.number().int().nonnegative(),
  /** Eligible albums scraped within `olderThanDays`. */
  covered: z.number().int().nonnegative(),
  /** Eligible albums last scraped before `olderThanDays`. */
  stale: z.number().int().nonnegative(),
  /** Eligible albums without a successful scrape. */
  missing: z.number().int().nonnegative(),
  unavailableReason: CoverageUnavailableReasonSchema.nullable(),
  /** The first 100 missing albums, by title. */
  missingItemIds: z.array(z.string()).max(COVERAGE_ITEM_ID_LIMIT),
  /** The first 100 stale albums, oldest scrape first. */
  staleItemIds: z.array(z.string()).max(COVERAGE_ITEM_ID_LIMIT),
})

export const CoverageSchema = z.object({
  /** Albums in the set. */
  total: z.number().int().nonnegative(),
  olderThanDays: z.number().int().positive(),
  providers: z.array(ProviderCoverageSchema),
})

/** `missing`: never scraped. `stale`: last scraped before `olderThanDays`. */
export const CoverageGapSchema = z.enum(['missing', 'stale'])

/**
 * A page of a playlist's entries whose albums have a gap, with the entry
 * query's order and filters. Without `provider`, any provider's gap counts.
 */
export const CoverageEntriesQuerySchema = PlaylistDetailQuerySchema.extend({
  ...CoverageQuerySchema.shape,
  gap: CoverageGapSchema.default('missing'),
  provider: z.string().trim().min(1).max(100).optional(),
})

/** One provider's gap in an entry: the album itself, or a track's albums. */
export const EntryGapSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  albumIds: z.array(z.string()).min(1),
})

export const CoverageEntrySchema = z.object({
  entry: PlaylistEntrySchema,
  gaps: z.array(EntryGapSchema),
})

export const CoverageEntriesSchema = PaginatedDataSchema(
  CoverageEntrySchema,
).extend({
  name: z.string(),
  gap: CoverageGapSchema,
  provider: z.string().nullable(),
  olderThanDays: z.number().int().positive(),
  /**
   * Albums of the playlist with the gap, before search and type filters:
   * the count Coverage shows for the provider, or for all providers combined.
   */
  albumCount: z.number().int().nonnegative(),
})

export type CoverageQuery = z.infer<typeof CoverageQuerySchema>
export type CoverageUnavailableReason = z.infer<
  typeof CoverageUnavailableReasonSchema
>
export type ProviderCoverage = z.infer<typeof ProviderCoverageSchema>
export type Coverage = z.infer<typeof CoverageSchema>
export type CoverageGap = z.infer<typeof CoverageGapSchema>
export type CoverageEntriesQuery = z.infer<typeof CoverageEntriesQuerySchema>
export type EntryGap = z.infer<typeof EntryGapSchema>
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>
export type CoverageEntries = z.infer<typeof CoverageEntriesSchema>
