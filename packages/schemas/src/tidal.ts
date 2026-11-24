import { z } from 'zod'
import { JobStatusSchema } from './job'
import { normalizeTagName } from './tags'

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
  source: z.enum(['tidal-album', 'tidal-track-match', 'tidal-similar']),
  matchReason: TidalTrackMatchReasonSchema.nullable(),
  alignment: TidalAlbumTrackAlignmentSchema.nullable(),
})
export type TidalTrackMatch = z.infer<typeof TidalTrackMatchSchema>

export const TidalTrackMatchParamsSchema = z.object({ trackId })
/**
 * Tracks matched in one request. Each match runs in the request, one TIDAL
 * request at least 1.5 seconds after the last.
 */
export const TIDAL_TRACK_MATCH_REQUEST_LIMIT = 10

export const TidalTrackMatchInputSchema = z
  .object({
    trackIds: z.array(trackId).min(1).max(TIDAL_TRACK_MATCH_REQUEST_LIMIT),
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

/**
 * The matches run in one request, in the order asked. Tracks that were
 * missing, had no ISRC or were already being matched are skipped. A cooldown
 * or busy provider stops the rest, which the warnings say.
 */
export const TidalTrackMatchRunSchema = z.object({
  batchId: z.string(),
  items: z
    .array(TidalTrackMatchReviewSchema)
    .max(TIDAL_TRACK_MATCH_REQUEST_LIMIT),
  skipped: z.number().int().nonnegative(),
  notRun: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
})
export type TidalTrackMatchRun = z.infer<typeof TidalTrackMatchRunSchema>

export const TidalTrackMatchStatusInputSchema = z
  .object({ trackIds: z.array(trackId).min(1).max(100) })
  .strict()
export const TidalTrackMatchStatusSchema = z.object({
  items: z.array(TidalTrackMatchReviewSchema).max(100),
})
export type TidalTrackMatchStatus = z.infer<typeof TidalTrackMatchStatusSchema>

/** The task that reads one album's or track's similar items from TIDAL. */
export const TIDAL_SIMILAR_TASK = 'tidal-similar'
/**
 * The Spotify task that looks up, by ISRC or UPC, the similar items of one
 * album or track that are not in the library.
 */
export const SPOTIFY_SIMILAR_LOOKUP_TASK = 'spotify-similar-lookup'
/** TIDAL's first page of similar items, the only page read. */
export const TIDAL_SIMILAR_LIMIT = 20

export const TidalSimilarKindSchema = z.enum(['album', 'track'])
export type TidalSimilarKind = z.infer<typeof TidalSimilarKindSchema>

export const TidalSimilarParamsSchema = z.object({
  kind: z.enum(['albums', 'tracks']),
  id: trackId,
})

const SIMILAR_GENRE_LIMIT = 100
export const SimilarGenreNamesSchema = z.array(name).max(SIMILAR_GENRE_LIMIT)

/** Keep the spelling and order from the source, with one entry per name. */
export function normalizeSimilarGenres(values: readonly string[]): string[] {
  const genres = new Map<string, string>()
  for (const value of values) {
    const genre = name.safeParse(value)
    if (!genre.success) continue
    const key = normalizeTagName(genre.data)
    if (!genres.has(key)) genres.set(key, genre.data)
    if (genres.size === SIMILAR_GENRE_LIMIT) break
  }
  return [...genres.values()]
}

/** One similar album or track as TIDAL returned it, in TIDAL's order. */
export const TidalSuggestionSchema = z.object({
  tidalId: TidalIdSchema,
  catalogMediaItemId: id.optional(),
  catalogPosition: z.number().int().positive().optional(),
  title: name,
  /** A track's version label, such as a remix name. */
  version: name.nullable(),
  artists: z.array(name).max(20),
  /** The track's ISRC or the album's barcode, as TIDAL wrote it. */
  code: z.string().max(40).nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  /** Albums only. */
  releaseDate: z.string().max(40).nullable(),
  url: z.url({ protocol: /^https$/ }).max(2000),
  /** The genres included in TIDAL's response, when available. */
  genres: SimilarGenreNamesSchema.optional(),
})
export type TidalSuggestion = z.infer<typeof TidalSuggestionSchema>

/** What a Spotify `isrc:` or `upc:` search found for one code. */
export const SpotifyCodeMatchSchema = z.object({
  spotifyId: z.string().regex(/^[A-Za-z0-9]{22}$/),
  url: z.url({ protocol: /^https$/ }).max(2000),
  title: name,
  artists: z.array(name).max(50),
  albumName: name.nullable(),
  spotifyAlbumId: z
    .string()
    .regex(/^[A-Za-z0-9]{22}$/)
    .nullable(),
  artworkUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  /** Albums only. */
  trackCount: z.number().int().nonnegative().nullable(),
  /** Album genres in Spotify's catalogue response, when available. */
  genres: SimilarGenreNamesSchema.optional(),
})
export type SpotifyCodeMatch = z.infer<typeof SpotifyCodeMatchSchema>

/**
 * Who answered a stored Spotify lookup: a Spotify `isrc:` or `upc:` search,
 * or, for tracks, Sonovault's bulk resolve by ISRC (SONO-26).
 */
export const SpotifyCodeLookupSourceSchema = z.enum(['spotify', 'sonovault'])
export type SpotifyCodeLookupSource = z.infer<
  typeof SpotifyCodeLookupSourceSchema
>

/**
 * How a suggestion can be played: `library` opens the library item;
 * `spotify` plays it on Spotify; `none` was searched on Spotify and not
 * found; `unsearched` has not been searched on Spotify yet.
 */
export const TidalSuggestionStateSchema = z.enum([
  'library',
  'spotify',
  'none',
  'unsearched',
])
export type TidalSuggestionState = z.infer<typeof TidalSuggestionStateSchema>

export const SimilarGenreSourceSchema = z.enum([
  'library',
  'sonovault',
  'sonovault-album-tracks',
  'tidal',
  'spotify',
  'album-tracks',
  'track-album',
  'artist',
])
export type SimilarGenreSource = z.infer<typeof SimilarGenreSourceSchema>

export const TidalSimilarItemSchema = TidalSuggestionSchema.extend({
  genres: SimilarGenreNamesSchema.default([]),
  genreSource: SimilarGenreSourceSchema.nullable().default(null),
  genreArtist: z.object({ id, name }).nullable().default(null),
  genreEvidence: z
    .object({ jobId: id, responseId: id })
    .nullable()
    .default(null),
  state: TidalSuggestionStateSchema,
  /** The library album or track, for `library`. */
  library: z
    .object({
      id: z.string(),
      title: name,
      artworkUrl: z.string().url().nullable(),
      spotifyId: z
        .string()
        .regex(/^[A-Za-z0-9]{22}$/)
        .nullable(),
      /** A library track's linked library album. */
      album: z.object({ id: z.string(), title: name }).nullable(),
      albumName: name.nullable(),
      trackCount: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  /** The reference that linked this suggestion to its library item. */
  libraryMatch: z
    .object({
      basis: z.enum(['tidal-id', 'isrc', 'upc', 'spotify-id']),
      value: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** The Spotify album or track, for `spotify` (and `library` when known). */
  spotify: SpotifyCodeMatchSchema.nullable(),
})
export type TidalSimilarItem = z.infer<typeof TidalSimilarItemSchema>

export const TidalSimilarJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  errorMessage: z.string().nullable(),
  createdAt: dateTime,
  finishedAt: dateTime.nullable(),
})
export type TidalSimilarJob = z.infer<typeof TidalSimilarJobSchema>

/**
 * Where the TIDAL ID of a read came from: TIDAL's own match or album job, or
 * a verified Sonovault record's TIDAL link (SONO-27). `jobId` is the job that
 * recorded the ID, when known.
 */
export const TidalSimilarSourceSchema = z.object({
  kind: z.enum(['tidal', 'sonovault']),
  tidalId: TidalIdSchema,
  jobId: z.string().nullable(),
})
export type TidalSimilarSource = z.infer<typeof TidalSimilarSourceSchema>

/**
 * Why a track is not matched on TIDAL: its latest track match left
 * `candidateCount` TIDAL tracks for the owner to choose from (`review`), the
 * track has no ISRC to match by (`no-isrc`), or TIDAL has no track with the
 * ISRC the latest match used (`not-found`).
 */
export const TidalSimilarUnmatchedSchema = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('review'),
    candidateCount: z
      .number()
      .int()
      .positive()
      .max(TIDAL_TRACK_CANDIDATE_LIMIT),
  }),
  z.object({ reason: z.literal('no-isrc') }),
  z.object({ reason: z.literal('not-found'), isrc: z.string().max(40) }),
])
export type TidalSimilarUnmatched = z.infer<typeof TidalSimilarUnmatchedSchema>

/**
 * The Similar tab of one library album or track. `matched` is false until a
 * TIDAL album job or track match has linked the item to TIDAL; `matchJob` is
 * the latest of those, and `unmatched` says why a track is not matched when
 * it is known. `job` is the latest TIDAL similar read and `lookupJob` the
 * latest Spotify lookup. `readAt` is null until a read has succeeded, and
 * `source` says where the TIDAL ID of that read came from.
 */
export const TidalSimilarSchema = z.object({
  kind: TidalSimilarKindSchema,
  itemId: z.string(),
  matched: z.boolean(),
  matchJob: TidalSimilarJobSchema.nullable(),
  unmatched: TidalSimilarUnmatchedSchema.nullable(),
  job: TidalSimilarJobSchema.nullable(),
  lookupJob: TidalSimilarJobSchema.nullable(),
  readAt: dateTime.nullable(),
  source: TidalSimilarSourceSchema.nullable(),
  items: z.array(TidalSimilarItemSchema).max(TIDAL_SIMILAR_LIMIT),
})
export type TidalSimilar = z.infer<typeof TidalSimilarSchema>

/** The displayed title of a suggestion, including its version once. */
export function tidalSuggestionTitle({
  title,
  version,
}: Pick<TidalSuggestion, 'title' | 'version'>): string {
  return version && !title.includes(version) ? `${title} (${version})` : title
}

export const TidalSimilarAddParamsSchema = TidalSimilarParamsSchema.extend({
  tidalId: TidalIdSchema,
})

export const TidalSimilarAddResultSchema = z.object({ id: trackId })
