import { z } from 'zod'
import {
  SONOVAULT_BULK_LIMIT,
  SonovaultTrackLookupJobSchema,
} from './sonovault'

/**
 * Stage 4 (SONO-23 to SONO-25): library tracks with neither a Spotify ID nor
 * an ISRC are looked up by artist and title. A result is a candidate that is
 * accepted automatically only on equal artist, title and duration, and
 * otherwise waits for the owner in Tracks → Matches.
 */

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'))
const trackId = z.string().trim().pipe(id)
const dateTime = z.string().datetime()

export const SonovaultCandidateStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
])
export const SonovaultCandidateAcceptedBySchema = z.enum(['automatic', 'owner'])

/** One Sonovault track offered for a library track. */
export const SonovaultTrackCandidateSchema = z.object({
  sonovaultTrackId: z.string().min(1).max(100),
  title: z.string().max(2000),
  artists: z.array(z.string().max(2000)).max(200),
  /** The first release the record lists, with its date. */
  release: z.string().max(2000).nullable(),
  releaseDate: z.string().max(40).nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  isrc: z.string().max(40).nullable(),
  spotifyTrackId: z.string().max(100).nullable(),
  spotifyUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  status: SonovaultCandidateStatusSchema,
  acceptedBy: SonovaultCandidateAcceptedBySchema.nullable(),
  foundAt: dateTime,
  decidedAt: dateTime.nullable(),
  jobId: z.string().nullable(),
  /** The Spotify job that takes the candidate's Spotify ID after acceptance. */
  spotifyJobId: z.string().nullable(),
})
export type SonovaultTrackCandidate = z.infer<
  typeof SonovaultTrackCandidateSchema
>

/** A library track's latest artist-and-title lookup and its candidates. */
export const SonovaultTrackCandidateReviewSchema = z.object({
  trackId,
  /** The latest artist-and-title lookup job, or null before any. */
  job: SonovaultTrackLookupJobSchema.nullable(),
  /** Whether the latest lookup by artist and title found nothing. */
  notFound: z.boolean(),
  candidates: z.array(SonovaultTrackCandidateSchema).max(50),
})
export type SonovaultTrackCandidateReview = z.infer<
  typeof SonovaultTrackCandidateReviewSchema
>

export const SonovaultCandidateStatusInputSchema = z
  .object({ trackIds: z.array(trackId).min(1).max(SONOVAULT_BULK_LIMIT) })
  .strict()
export const SonovaultCandidateStatusListSchema = z.object({
  items: z.array(SonovaultTrackCandidateReviewSchema).max(SONOVAULT_BULK_LIMIT),
})

/** Tracks to look up by artist and title, 100 at a time from the app. */
export const SonovaultTrackNameLookupInputSchema = z
  .object({
    trackIds: z.array(trackId).min(1).max(SONOVAULT_BULK_LIMIT),
    batchId: id.optional(),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.trackIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm looking up more than five tracks',
    path: ['confirmBroadRun'],
  })

export const SonovaultCandidateParamsSchema = z.object({ trackId })
export const SonovaultCandidateDecisionInputSchema = z
  .object({ sonovaultTrackId: z.string().trim().min(1).max(100) })
  .strict()

/** After an acceptance: the review, and whether a Spotify job was queued. */
export const SonovaultCandidateAcceptResultSchema = z.object({
  review: SonovaultTrackCandidateReviewSchema,
  /** Why the candidate's Spotify ID was not queued, when it was not. */
  spotifyWarning: z.string().max(500).nullable(),
})
