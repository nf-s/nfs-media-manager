import { z } from 'zod'
import { ProviderSiteUrlSchema } from './provider'
import { LastFmUrlSchema } from './provider-identification'

/** The library items Find match serves. */
export const MatchKindSchema = z.enum(['album', 'film', 'artist'])
export type MatchKind = z.infer<typeof MatchKindSchema>

export const MatchSearchInputSchema = z
  .object({
    kind: MatchKindSchema,
    id: z.string().min(1).max(500),
    provider: z.string().min(1).max(100),
    /** Replaces the item's own title and creator as the search text. */
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
export type MatchSearchInput = z.input<typeof MatchSearchInputSchema>

/** One provider record the item could be matched to. */
export const MatchCandidateSchema = z.object({
  /** The reference type stored when this candidate is chosen. */
  referenceType: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().min(1),
  /** The artist, director or other creator. */
  subtitle: z.string().nullable(),
  /** A year or an ISO date. */
  releaseDate: z.string().nullable(),
  artworkUrl: ProviderSiteUrlSchema.nullable(),
  /** The candidate on the provider's site. */
  url: ProviderSiteUrlSchema.nullable(),
  /** The identifier stored for the item now. */
  current: z.boolean(),
})
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>

export const MatchSearchResultSchema = z.object({
  provider: z.string(),
  /** The text searched: the owner's, or the item's title and creator. */
  query: z.string(),
  items: z.array(MatchCandidateSchema).max(20),
})
export type MatchSearchResult = z.infer<typeof MatchSearchResultSchema>

export const UnresolvedMatchQuerySchema = z.object({
  kind: MatchKindSchema,
  id: z.string().min(1).max(500),
})
export type UnresolvedMatchQuery = z.infer<typeof UnresolvedMatchQuerySchema>

/**
 * A provider whose latest lookup for the item failed to match: it found
 * nothing, or found several records. `candidates` holds the records an
 * ambiguous lookup kept, listed without a new request. `suggested` is a
 * provider whose match another provider's confirmed record lacks or
 * contradicts (SONO-22); `jobId` is then that record's job.
 */
export const UnresolvedMatchSchema = z.object({
  provider: z.string(),
  jobId: z.string(),
  outcome: z.enum(['not-found', 'ambiguous', 'suggested']),
  candidates: z.array(MatchCandidateSchema).max(20),
})
export type UnresolvedMatch = z.infer<typeof UnresolvedMatchSchema>

export const UnresolvedMatchListSchema = z.object({
  /** The item's own search text, as a search without `q` uses it. */
  query: z.string().nullable(),
  items: z.array(UnresolvedMatchSchema).max(100),
})
export type UnresolvedMatchList = z.infer<typeof UnresolvedMatchListSchema>

const albumCandidate = z.object({ albumId: z.string().trim().min(1).max(500) })
export const AlbumCandidatePreviewInputSchema = z.union([
  albumCandidate
    .extend({
      provider: z.literal('discogs'),
      referenceType: z.enum(['master', 'release']),
      externalId: z
        .string()
        .max(16)
        .regex(/^[1-9]\d*$/)
        .refine((id) => Number.isSafeInteger(Number(id))),
    })
    .strict(),
  albumCandidate
    .extend({
      provider: z.literal('lastfm'),
      referenceType: z.literal('url'),
      externalId: z.string().max(1000).pipe(LastFmUrlSchema),
    })
    .strict(),
  albumCandidate
    .extend({
      provider: z.literal('lastfm'),
      referenceType: z.literal('mbid'),
      externalId: z.string().uuid(),
    })
    .strict(),
])
export type AlbumCandidatePreviewInput = z.infer<
  typeof AlbumCandidatePreviewInputSchema
>

export const AlbumCandidatePreviewSchema = z.object({
  title: z.string().min(1),
  artists: z.array(z.string().min(1)),
  url: ProviderSiteUrlSchema,
  date: z.string().nullable(),
  masterId: z.string().nullable(),
  mainReleaseId: z.string().nullable(),
  trackCount: z.number().int().nonnegative(),
  tracks: z
    .array(
      z.object({
        title: z.string().min(1),
        position: z.number().int().positive(),
        durationSec: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(500),
})
