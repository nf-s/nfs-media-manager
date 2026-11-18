import { z } from 'zod'
import { ProviderFreshnessFiltersSchema } from './film-selection'
import { JobStatusSchema } from './job'
import { spotifyIdPattern } from './playback'

export const SPOTIFY_TRACK_SEARCH_TASK = 'spotify-track-search'
export const SPOTIFY_TRACK_SEARCH_LIMIT = 10

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'))
const trackId = z.string().trim().pipe(id)
const spotifyId = z.string().regex(spotifyIdPattern)
const name = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'))
const dateTime = z.string().datetime()

export const SpotifyTrackSearchParamsSchema = z.object({ trackId })
export const SpotifyTrackSearchAcceptInputSchema = z
  .object({ jobId: id, spotifyTrackId: spotifyId })
  .strict()
export const SpotifyTrackSearchAcceptResultSchema = z.object({
  targetId: trackId,
})

export const SpotifyTrackSearchStatusInputSchema = z
  .object({ trackIds: z.array(trackId).min(1).max(100) })
  .strict()

export const SpotifyTrackSearchFreshnessSchema =
  ProviderFreshnessFiltersSchema.refine(
    (filters) => filters.every((filter) => filter.provider === 'spotify'),
    'Track search freshness is available for Spotify',
  )
export type SpotifyTrackSearchFreshness = z.infer<
  typeof SpotifyTrackSearchFreshnessSchema
>

export const SpotifyTrackSearchMarketSchema = z
  .string()
  .length(2)
  .regex(
    /^[A-Z]{2}$/,
    'Spotify market must be a two-letter uppercase country code.',
  )

export const SpotifyTrackSearchInputSchema =
  SpotifyTrackSearchStatusInputSchema.extend({
    batchId: id.optional(),
    confirmBroadRun: z.boolean().default(false),
    freshness: SpotifyTrackSearchFreshnessSchema.optional(),
    market: SpotifyTrackSearchMarketSchema.optional(),
  }).refine((input) => input.trackIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm searching more than five tracks',
    path: ['confirmBroadRun'],
  })

export const SpotifyTrackSearchCandidateSchema = z.object({
  spotifyTrackId: spotifyId,
  title: name,
  artists: z.array(name).min(1).max(50),
  artistCredits: z
    .array(z.object({ id: spotifyId, name }))
    .max(50)
    .default([]),
  albumName: name.nullable(),
  spotifyAlbumId: spotifyId.nullable(),
  durationSec: z.number().int().nonnegative(),
  isrc: z
    .string()
    .max(40)
    .regex(/^[A-Z0-9-]+$/)
    .nullable(),
  artworkUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  spotifyUrl: z
    .string()
    .regex(/^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}$/),
})

export const SpotifyTrackSearchJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  acceptedTrackId: trackId.optional(),
  matchMethod: z.enum(['automatic', 'manual']).optional(),
  resultCount: z
    .number()
    .int()
    .min(0)
    .max(SPOTIFY_TRACK_SEARCH_LIMIT)
    .nullable(),
  errorMessage: z.string().nullable(),
  createdAt: dateTime,
  startedAt: dateTime.nullable(),
  finishedAt: dateTime.nullable(),
})

export const SpotifyTrackSearchSchema = z.object({
  job: SpotifyTrackSearchJobSchema.nullable(),
  query: z.string().max(200),
  candidates: z
    .array(SpotifyTrackSearchCandidateSchema)
    .max(SPOTIFY_TRACK_SEARCH_LIMIT),
})

export const SpotifyTrackSearchStatusSchema = z.object({
  items: z
    .array(
      z.object({
        trackId,
        job: SpotifyTrackSearchJobSchema.nullable(),
        lastAttemptAt: dateTime.nullable(),
        lastSuccessfulAt: dateTime.nullable(),
      }),
    )
    .max(100),
})

export type SpotifyTrackSearchInput = z.input<
  typeof SpotifyTrackSearchInputSchema
>
export type SpotifyTrackSearchJob = z.infer<typeof SpotifyTrackSearchJobSchema>
export type SpotifyTrackSearchCandidate = z.infer<
  typeof SpotifyTrackSearchCandidateSchema
>
export type SpotifyTrackSearch = z.infer<typeof SpotifyTrackSearchSchema>
export type SpotifyTrackSearchStatus = z.infer<
  typeof SpotifyTrackSearchStatusSchema
>
