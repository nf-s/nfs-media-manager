import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import { PlaylistDetailQuerySchema, PlaylistEntrySchema } from './tracks'

/** IDs returned per list; the album and artist queues accept at most 100 per request. */
export const COVERAGE_ITEM_ID_LIMIT = 100

/**
 * What a playlist's coverage counts: the albums behind its entries, or the
 * artists credited on them. An artist's coverage counts its albums.
 */
export const CoverageSubjectSchema = z.enum(['albums', 'artists'])

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
   * Items the provider has scraped or can look up. An album needs a stored
   * identifier or a provider that looks albums up by name; the others need
   * an identifier before they can be queued. Every artist can be looked up.
   */
  eligible: z.number().int().nonnegative(),
  /** Eligible items scraped within `olderThanDays`. */
  covered: z.number().int().nonnegative(),
  /** Eligible items last scraped before `olderThanDays`. */
  stale: z.number().int().nonnegative(),
  /** Eligible items without a successful scrape. */
  missing: z.number().int().nonnegative(),
  unavailableReason: CoverageUnavailableReasonSchema.nullable(),
  /** The first 100 missing items, by title or name. */
  missingItemIds: z.array(z.string()).max(COVERAGE_ITEM_ID_LIMIT),
  /** The first 100 stale items, oldest scrape first. */
  staleItemIds: z.array(z.string()).max(COVERAGE_ITEM_ID_LIMIT),
})

export const CoverageSchema = z.object({
  /** Albums, or artists, in the set. */
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

export type CoverageSubject = z.infer<typeof CoverageSubjectSchema>
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
