import { z } from 'zod'
import { JobStatusSchema } from './job'

/** The task that looks up to 100 library tracks on Sonovault in one request. */
export const SONOVAULT_TRACK_LOOKUP_TASK = 'sonovault-track-lookup'
/**
 * Maps one library track's similar tracks from TIDAL to Spotify by ISRC
 * through one bulk request (SONO-26).
 */
export const SONOVAULT_SIMILAR_LOOKUP_TASK = 'sonovault-similar-lookup'
/** The bulk call takes at most this many input lines. */
export const SONOVAULT_BULK_LIMIT = 100
/** A lookup that found nothing is not repeated for this many days (SONO-09). */
export const SONOVAULT_MISS_RETRY_DAYS = 30
/** Records older than this many months are looked up again (SONO-10). */
export const SONOVAULT_REFRESH_MONTHS = 11

/** The plan's limits when Providers sets none: the Starter plan. */
export const SONOVAULT_DEFAULT_REQUESTS_PER_MINUTE = 60
export const SONOVAULT_DEFAULT_MONTHLY_CREDITS = 50000
/** A bulk run stops before the credits left would fall below this. */
export const SONOVAULT_DEFAULT_CREDIT_RESERVE = 2000

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'))
const trackId = z.string().trim().pipe(id)
const dateTime = z.string().datetime()

/** How a library track is sent to the bulk call. */
export const SonovaultLookupInputTypeSchema = z.enum(['spotify_id', 'isrc'])
export type SonovaultLookupInputType = z.infer<
  typeof SonovaultLookupInputTypeSchema
>

/**
 * The reference types a Sonovault record gives a library track, each naming
 * the service and kind (SONO-05). The ISRC is an `isrc` reference instead.
 */
export const SonovaultReferenceTypeSchema = z.enum([
  'sonovault-track',
  'spotify-track',
  'applemusic-track',
  'tidal-track',
  'beatport-track',
  'musicbrainz-recording',
  'discogs-release-track',
  'youtube-video',
])
export type SonovaultReferenceType = z.infer<
  typeof SonovaultReferenceTypeSchema
>

/**
 * The `metadata` of every `sonovault` reference on a library track. Later
 * stages read `verified` and `responseId`: an unverified record's references
 * are not used by other features (SONO-08), and the response is where the
 * record's tempo, key, genre and releases are read from.
 */
export const SonovaultReferenceMetadataSchema = z.object({
  /** The service page, or null when the service has none. */
  url: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  /** The SONO-08 result: duration and title agree with the library track. */
  verified: z.boolean(),
  /** When the response it was read from was received. */
  fetchedAt: dateTime,
  /** The stored `provider_response` it was read from. */
  responseId: id,
  jobId: id,
  inputType: SonovaultLookupInputTypeSchema,
  /**
   * On the `sonovault-track` reference: the record's ISRC (an unverified
   * record's ISRC is kept only here), title and duration, which the
   * verification compared with the library track.
   */
  isrc: z.string().max(40).nullable().optional(),
  title: z.string().max(2000).optional(),
  durationSec: z.number().int().nonnegative().nullable().optional(),
})
export type SonovaultReferenceMetadata = z.infer<
  typeof SonovaultReferenceMetadataSchema
>

export const SonovaultTrackLookupParamsSchema = z.object({
  trackIds: z.array(trackId).min(1).max(SONOVAULT_BULK_LIMIT),
  inputType: SonovaultLookupInputTypeSchema,
})

/** Tracks to look up; each call queues at most two jobs (one per input type). */
export const SonovaultTrackLookupInputSchema = z
  .object({
    trackIds: z.array(trackId).min(1).max(SONOVAULT_BULK_LIMIT),
    batchId: id.optional(),
    /** Look up tracks whose records are older than 11 months again. */
    refresh: z.boolean().default(false),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.trackIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm looking up more than five tracks',
    path: ['confirmBroadRun'],
  })
export type SonovaultTrackLookupInput = z.input<
  typeof SonovaultTrackLookupInputSchema
>

export const SonovaultLookupStatusSchema = z.enum(['matched', 'not_found'])

export const SonovaultTrackLookupJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  errorMessage: z.string().nullable(),
  createdAt: dateTime,
  finishedAt: dateTime.nullable(),
})
export type SonovaultTrackLookupJob = z.infer<
  typeof SonovaultTrackLookupJobSchema
>

export const SonovaultTrackReferenceSchema =
  SonovaultReferenceMetadataSchema.pick({
    url: true,
    verified: true,
    fetchedAt: true,
  }).extend({
    referenceType: z.union([SonovaultReferenceTypeSchema, z.literal('isrc')]),
    externalId: z.string().min(1).max(500),
  })
export type SonovaultTrackReference = z.infer<
  typeof SonovaultTrackReferenceSchema
>

/** One library track's latest Sonovault lookup, its references and job. */
export const SonovaultTrackStateSchema = z.object({
  trackId: z.string(),
  lookup: z
    .object({
      status: SonovaultLookupStatusSchema,
      inputType: SonovaultLookupInputTypeSchema,
      sonovaultTrackId: z.string().nullable(),
      verified: z.boolean().nullable(),
      /** The primary ISRC this lookup gave the track, while it is still its. */
      primaryIsrc: z.string().nullable(),
      lookedUpAt: dateTime,
      /** A track that found nothing can be looked up again from this time. */
      retryAfter: dateTime.nullable(),
    })
    .nullable(),
  references: z.array(SonovaultTrackReferenceSchema).max(20),
  job: SonovaultTrackLookupJobSchema.nullable(),
})
export type SonovaultTrackState = z.infer<typeof SonovaultTrackStateSchema>

export const SonovaultTrackParamsSchema = z.object({ trackId })
export const SonovaultTrackStatusInputSchema = z
  .object({ trackIds: z.array(trackId).min(1).max(SONOVAULT_BULK_LIMIT) })
  .strict()
export const SonovaultTrackStatusSchema = z.object({
  items: z.array(SonovaultTrackStateSchema).max(SONOVAULT_BULK_LIMIT),
})

/** What is stored from Sonovault, the credits left and the refresh queue. */
export const SonovaultSummarySchema = z.object({
  lookups: z.object({
    matched: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    notFound: z.number().int().nonnegative(),
    /** Matched records older than 11 months. */
    dueForRefresh: z.number().int().nonnegative(),
  }),
  references: z.number().int().nonnegative(),
  primaryIsrcs: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
  credits: z.object({
    /** As the latest response reported, or null before any response. */
    remaining: z.number().int().nonnegative().nullable(),
    reportedAt: dateTime.nullable(),
    monthlyCredits: z.number().int().positive(),
    reserve: z.number().int().nonnegative(),
  }),
})
export type SonovaultSummary = z.infer<typeof SonovaultSummarySchema>

export const SonovaultRefreshInputSchema = z
  .object({ batchId: id.optional(), confirmBroadRun: z.literal(true) })
  .strict()

export const SonovaultRemovalInputSchema = z
  .object({ confirm: z.literal(true) })
  .strict()
export const SonovaultRemovalSchema = z.object({
  references: z.number().int().nonnegative(),
  lookups: z.number().int().nonnegative(),
  primaryIsrcs: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
  trackFacts: z.number().int().nonnegative(),
})
export type SonovaultRemoval = z.infer<typeof SonovaultRemovalSchema>
