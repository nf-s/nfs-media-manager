import { z } from 'zod'
import { JobStatusSchema } from './job'

/** The task that matches one library track to TIDAL by its ISRC. */
export const TIDAL_TRACK_MATCH_TASK = 'tidal-track-match'
/** TIDAL accepts at most 20 values in one barcode or ISRC filter. */
export const TIDAL_FILTER_LIMIT = 20
/** The most candidates one ISRC lookup keeps for review. */
export const TIDAL_TRACK_CANDIDATE_LIMIT = 20

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'))
const trackId = z.string().trim().pipe(id)
const name = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'))
const dateTime = z.string().datetime()

/** A TIDAL catalogue ID: digits only. */
export const TidalIdSchema = z.string().regex(/^\d{1,20}$/)

export const TidalCountryCodeSchema = z
  .string()
  .regex(
    /^[A-Z]{2}$/,
    'TIDAL country must be a two-letter uppercase country code.',
  )

export const TidalKeySchema = z.enum([
  'UNKNOWN',
  'C',
  'CSharp',
  'D',
  'Eb',
  'E',
  'F',
  'FSharp',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
])
export const TidalKeyScaleSchema = z.enum([
  'UNKNOWN',
  'MAJOR',
  'MINOR',
  'AEOLIAN',
  'BLUES',
  'DORIAN',
  'HARMONIC_MINOR',
  'LOCRIAN',
  'LYDIAN',
  'MIXOLYDIAN',
  'PENTATONIC_MAJOR',
  'PHRYGIAN',
  'MELODIC_MINOR',
  'PENTATONIC_MINOR',
])

/**
 * What a library track keeps from its TIDAL track: the metadata of its
 * `tidal` `track` reference. BPM and key are present only when TIDAL returns
 * them (it returned neither to this app on 2026-11-22), and are left out
 * rather than stored as null.
 */
export const TidalTrackDataSchema = z.object({
  url: z.url({ protocol: /^https$/ }).max(2000),
  version: name.nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  bpm: z.number().positive().max(1000).optional(),
  key: TidalKeySchema.exclude(['UNKNOWN']).optional(),
  keyScale: TidalKeyScaleSchema.exclude(['UNKNOWN']).optional(),
  popularity: z.number().min(0).max(1).nullable(),
})
export type TidalTrackData = z.infer<typeof TidalTrackDataSchema>

/** One TIDAL track an ISRC lookup returned, as the review lists it. */
export const TidalTrackCandidateSchema = TidalTrackDataSchema.extend({
  tidalTrackId: TidalIdSchema,
  title: name,
  isrc: z.string().max(40).nullable(),
  streamable: z.boolean(),
  albums: z
    .array(
      z.object({
        tidalAlbumId: TidalIdSchema,
        title: name,
        albumType: z.enum(['ALBUM', 'EP', 'SINGLE']).nullable(),
        barcodeId: z.string().max(40).nullable(),
        releaseDate: z.string().max(40).nullable(),
      }),
    )
    .max(20),
})
export type TidalTrackCandidate = z.infer<typeof TidalTrackCandidateSchema>

/**
 * Why a lookup chose a candidate, or why it left the choice to review;
 * `manual` when the owner chose it in review.
 */
export const TidalTrackMatchReasonSchema = z.enum([
  'single',
  'album-upc',
  'duration',
  'version',
  'streamable',
  'ambiguous',
  'none',
  'manual',
])

/** How an album job paired a TIDAL track with a library album track. */
export const TidalAlbumTrackAlignmentSchema = z.enum([
  'position-duration',
  'position-title',
  'title-duration',
])

/**
 * A library track's current TIDAL track: its `tidal` `track` reference,
 * written by an album job or a track match.
 */
export const TidalTrackMatchSchema = TidalTrackDataSchema.extend({
  tidalTrackId: TidalIdSchema,
  source: z.enum(['tidal-album', 'tidal-track-match']),
  matchReason: TidalTrackMatchReasonSchema.nullable(),
  alignment: TidalAlbumTrackAlignmentSchema.nullable(),
})
export type TidalTrackMatch = z.infer<typeof TidalTrackMatchSchema>

export const TidalTrackMatchParamsSchema = z.object({ trackId })
export const TidalTrackMatchInputSchema = z
  .object({
    trackIds: z.array(trackId).min(1).max(100),
    batchId: id.optional(),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.trackIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm matching more than five tracks',
    path: ['confirmBroadRun'],
  })
export type TidalTrackMatchInput = z.input<typeof TidalTrackMatchInputSchema>

export const TidalTrackMatchAcceptInputSchema = z
  .object({ jobId: id, tidalTrackId: TidalIdSchema })
  .strict()

export const TidalTrackMatchJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  isrc: z.string().max(40).nullable(),
  reason: TidalTrackMatchReasonSchema.nullable(),
  acceptedTidalTrackId: TidalIdSchema.nullable(),
  candidateCount: z
    .number()
    .int()
    .min(0)
    .max(TIDAL_TRACK_CANDIDATE_LIMIT)
    .nullable(),
  errorMessage: z.string().nullable(),
  createdAt: dateTime,
  finishedAt: dateTime.nullable(),
})
export type TidalTrackMatchJob = z.infer<typeof TidalTrackMatchJobSchema>

/**
 * A library track's current TIDAL track, its latest TIDAL lookup and that
 * lookup's candidates: all of an unresolved ambiguous lookup, or the one it
 * settled on. Status lists leave the candidates out.
 */
export const TidalTrackMatchReviewSchema = z.object({
  trackId,
  match: TidalTrackMatchSchema.nullable(),
  job: TidalTrackMatchJobSchema.nullable(),
  candidates: z
    .array(TidalTrackCandidateSchema)
    .max(TIDAL_TRACK_CANDIDATE_LIMIT),
})
export type TidalTrackMatchReview = z.infer<typeof TidalTrackMatchReviewSchema>

export const TidalTrackMatchStatusInputSchema = z
  .object({ trackIds: z.array(trackId).min(1).max(100) })
  .strict()
export const TidalTrackMatchStatusSchema = z.object({
  items: z.array(TidalTrackMatchReviewSchema).max(100),
})
export type TidalTrackMatchStatus = z.infer<typeof TidalTrackMatchStatusSchema>
