import { z } from 'zod'
import { SonovaultTrackLookupJobSchema } from './sonovault'

/** The task that confirms one library album as a Sonovault release (SONO-18). */
export const SONOVAULT_ALBUM_LOOKUP_TASK = 'sonovault-album-lookup'
/** Releases on the seed track's record fetched at most, one credit each. */
export const SONOVAULT_RELEASE_CANDIDATE_LIMIT = 5
/**
 * Credits one album job can use at most: every candidate release and the
 * matched edition's numbering. Its tracks are looked up by track lookups.
 */
export const SONOVAULT_ALBUM_MAX_CREDITS = SONOVAULT_RELEASE_CANDIDATE_LIMIT + 1

const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'))
const dateTime = z.string().datetime()

/** The identifiers that can confirm a release as the library album (SONO-19). */
export const SonovaultAlbumConfirmationSchema = z.enum([
  'spotify-album',
  'upc',
  'musicbrainz-release-group',
])
export type SonovaultAlbumConfirmation = z.infer<
  typeof SonovaultAlbumConfirmationSchema
>

export const SonovaultAlbumLookupStatusSchema = z.enum([
  'confirmed',
  'not_found',
])

/** Why an album was not found. */
export const SonovaultAlbumMissSchema = z.enum([
  /** No album track has a Spotify ID, an ISRC or a Sonovault record. */
  'no-track',
  /** No looked-up track of the album is on Sonovault. */
  'track-not-found',
  /** The album's track records list no release. */
  'no-release',
  /** No candidate release carries one of the album's identifiers. */
  'not-confirmed',
])
export type SonovaultAlbumMiss = z.infer<typeof SonovaultAlbumMissSchema>

/** The `sonovault` references an album gains from its release (SONO-21). */
export const SonovaultAlbumReferenceTypeSchema = z.enum([
  'sonovault-release',
  'digital-upc',
  'discogs-release',
  'discogs-master',
  'musicbrainz-release',
  'musicbrainz-release-group',
  'beatport-release',
  'applemusic-album',
])
export type SonovaultAlbumReferenceType = z.infer<
  typeof SonovaultAlbumReferenceTypeSchema
>

/** The `metadata` of every `sonovault` reference on a library album. */
export const SonovaultAlbumReferenceMetadataSchema = z.object({
  url: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  fetchedAt: dateTime,
  /** The stored release response it was read from. */
  responseId: id,
  jobId: id,
  /** The Sonovault edition that lists it; null for the release's own IDs. */
  editionId: z.number().int().positive().nullable(),
  /** Whether that edition is the one that confirmed the album. */
  matchedEdition: z.boolean(),
  /** On `sonovault-release`: what it was confirmed by, and the edition's details. */
  confirmedBy: z.array(SonovaultAlbumConfirmationSchema).max(3).optional(),
  title: z.string().max(2000).optional(),
  artist: z.string().max(2000).optional(),
  label: z.string().max(2000).nullable().optional(),
  catalogNo: z.string().max(500).nullable().optional(),
})
export type SonovaultAlbumReferenceMetadata = z.infer<
  typeof SonovaultAlbumReferenceMetadataSchema
>

export const SonovaultAlbumLookupParamsSchema = z.object({
  albumId: id,
  refresh: z.boolean().default(false),
  /** Look up an album not found in the last 30 days again now. */
  retry: z.boolean().default(false),
})

export const SonovaultAlbumParamsSchema = z.object({ albumId: id })

/** Albums to look up; each due album is one job. */
export const SonovaultAlbumLookupInputSchema = z
  .object({
    albumIds: z.array(id).min(1).max(100),
    batchId: id.optional(),
    /** Look up albums whose lookup is older than 11 months again. */
    refresh: z.boolean().default(false),
    /** Look up albums not found in the last 30 days again now. */
    retry: z.boolean().default(false),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.albumIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm looking up more than five albums',
    path: ['confirmBroadRun'],
  })
export type SonovaultAlbumLookupInput = z.input<
  typeof SonovaultAlbumLookupInputSchema
>

/**
 * SONO-22: a Discogs or MusicBrainz identity of the confirmed release that the
 * album lacks (`stored` null) or holds a different value for.
 */
export const SonovaultAlbumReviewSchema = z.object({
  provider: z.enum(['discogs', 'musicbrainz']),
  referenceType: z.enum(['master', 'release', 'release-group']),
  /** The album's own identifier of that kind, or null when it has none. */
  stored: z.string().nullable(),
  /** The identifier on the confirmed Sonovault release. */
  sonovault: z.string().min(1),
  url: z.url({ protocol: /^https$/ }).nullable(),
})
export type SonovaultAlbumReview = z.infer<typeof SonovaultAlbumReviewSchema>

export const SonovaultAlbumReferenceSchema = z.object({
  referenceType: SonovaultAlbumReferenceTypeSchema,
  externalId: z.string().min(1).max(500),
  url: z.string().nullable(),
  matchedEdition: z.boolean(),
  fetchedAt: dateTime,
})
export type SonovaultAlbumReference = z.infer<
  typeof SonovaultAlbumReferenceSchema
>

/** One library album's latest Sonovault lookup, references, review and job. */
export const SonovaultAlbumStateSchema = z.object({
  albumId: z.string(),
  lookup: z
    .object({
      status: SonovaultAlbumLookupStatusSchema,
      miss: SonovaultAlbumMissSchema.nullable(),
      releaseId: z.string().nullable(),
      editionId: z.string().nullable(),
      confirmedBy: z.array(SonovaultAlbumConfirmationSchema).max(3),
      /** Library tracks given a record from the release. */
      aligned: z.number().int().nonnegative(),
      /** Library tracks of the album that did not align. */
      unaligned: z.number().int().nonnegative(),
      /** Aligned tracks given an ISRC reference. */
      isrcs: z.number().int().nonnegative(),
      creditsUsed: z.number().int().nonnegative(),
      lookedUpAt: dateTime,
      /** An album that was not found can be looked up again from this time. */
      retryAfter: dateTime.nullable(),
    })
    .nullable(),
  /** Whether the album has a track Sonovault can be asked about. */
  canLookUp: z.boolean(),
  references: z.array(SonovaultAlbumReferenceSchema).max(200),
  review: z.array(SonovaultAlbumReviewSchema).max(20),
  job: SonovaultTrackLookupJobSchema.nullable(),
})
export type SonovaultAlbumState = z.infer<typeof SonovaultAlbumStateSchema>

/** Albums whose confirmed release differs from or adds a Discogs or MusicBrainz match. */
export const SonovaultAlbumReviewListSchema = z.object({
  items: z
    .array(
      z.object({
        albumId: z.string(),
        title: z.string(),
        artist: z.string().nullable(),
        review: z.array(SonovaultAlbumReviewSchema).min(1).max(20),
      }),
    )
    .max(500),
  totalCount: z.number().int().nonnegative(),
})
export type SonovaultAlbumReviewList = z.infer<
  typeof SonovaultAlbumReviewListSchema
>

/** Album counts for Providers → Sonovault. */
export const SonovaultAlbumSummarySchema = z.object({
  confirmed: z.number().int().nonnegative(),
  notFound: z.number().int().nonnegative(),
  alignedTracks: z.number().int().nonnegative(),
  /** Confirmed albums with a differing Discogs master or MusicBrainz release group. */
  differing: z.number().int().nonnegative(),
  /** Confirmed albums with no Discogs or MusicBrainz match that Sonovault can offer one for. */
  candidates: z.number().int().nonnegative(),
})
export type SonovaultAlbumSummary = z.infer<typeof SonovaultAlbumSummarySchema>
