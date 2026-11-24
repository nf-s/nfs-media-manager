import { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  SpotifyCodeMatchSchema,
  TIDAL_SIMILAR_LIMIT,
  normalizeSimilarGenres,
  tidalSuggestionTitle,
  type SpotifyCodeMatch,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import {
  SonovaultBulkResolveResponseSchema,
  resolveSonovaultTracks,
  sonovaultGatedPlugin,
  sonovaultSettings,
  type SonovaultResolveResult,
} from '@/lib/sonovault-api'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import {
  nextTaskResponseOrdinal,
  saveProviderResponseCapture,
} from './provider-response-history'
import { observeSonovaultTrack } from './sonovault-catalog-observations'
import {
  reportedSonovaultCredits,
  storedSonovaultResponse,
  verifySonovaultRecord,
} from './sonovault-track-lookup'
import { storeSpotifyCodeLookup } from './spotify-similar-lookup'
import {
  parseSimilarSonovaultResponse,
  readSimilarSonovaultResponses,
} from './similar-sonovault-responses'

const PROVIDER = 'sonovault'
const spotifyTrackIdPattern = /^[A-Za-z0-9]{22}$/

/** A similar track's ISRC with TIDAL's title and duration for it. */
export const SimilarTrackCheckSchema = z.object({
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(1100),
  durationSec: z.number().int().nonnegative().nullable(),
})
export type SimilarTrackCheck = z.infer<typeof SimilarTrackCheckSchema>

/** Why a similar track was not mapped through Sonovault. */
export type SonovaultSimilarMiss =
  | 'not_found'
  | 'no_spotify'
  | 'unverified'
  | 'skipped_no_credits'

export type SonovaultSimilarLookup =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'resolved'
      /** Spotify matches by ISRC key. */
      matches: Map<string, SpotifyCodeMatch>
      misses: Map<string, SonovaultSimilarMiss>
      responseId: string
      fetchedAt: Date
      creditsUsed: number
      creditsRemaining: number
    }

type Lookup =
  | { kind: 'reserve'; remaining: number; reserve: number }
  | {
      kind: 'resolved'
      results: SonovaultResolveResult[]
      creditsUsed: number
      creditsRemaining: number
    }

/** What a similar track's Sonovault record is checked against (SONO-08). */
export function similarTrackCheck(
  suggestion: TidalSuggestion,
): SimilarTrackCheck | null {
  const code = validIsrc(suggestion.code)
  return code
    ? {
        code,
        title: tidalSuggestionTitle(suggestion),
        durationSec: suggestion.durationSec,
      }
    : null
}

/** Reuse verified records in the saved Similar bulk responses, without a request. */
export async function readSimilarSonovaultTracks(
  database: Pick<typeof db, 'select'>,
  candidates: ReadonlyArray<{
    suggestion: TidalSuggestion
    responseIds: readonly string[]
  }>,
) {
  const responses = new Map<
    string,
    { genres: string[]; jobId: string; responseId: string }
  >()
  const rows = await readSimilarSonovaultResponses(
    database,
    candidates.flatMap(({ responseIds }) => responseIds),
  )
  const lookups = new Map<
    string,
    { jobId: string; records: Map<string, SonovaultResolveResult> }
  >()
  for (const row of rows) {
    if (row.status !== 200) continue
    const payload = parseSimilarSonovaultResponse(
      SonovaultBulkResolveResponseSchema,
      row.text,
    )
    if (!payload) continue
    const records = new Map<string, SonovaultResolveResult>()
    for (const line of payload.results) {
      const isrc = typeof line.input === 'string' && validIsrc(line.input)
      if (isrc && (line.status === 'matched' || line.status === 'not_found'))
        records.set(isrc, line)
    }
    lookups.set(row.id, { jobId: row.jobId, records })
  }
  for (const { suggestion, responseIds } of candidates) {
    const check = similarTrackCheck(suggestion)
    if (!check) continue
    for (const id of responseIds) {
      const lookup = lookups.get(id)
      const line = lookup?.records.get(check.code)
      if (!lookup || !line) continue
      const track = line.status === 'matched' ? line.track : null
      responses.set(suggestion.tidalId, {
        jobId: lookup.jobId,
        responseId: id,
        genres:
          track && verifySonovaultRecord(check, track)
            ? normalizeSimilarGenres([...track.genre, ...track.subgenre])
            : [],
      })
      break
    }
  }
  return responses
}

/**
 * The Spotify match of one resolve line, or why there is none. The record
 * must agree with TIDAL's suggestion (SONO-08), because Sonovault's record
 * for an ISRC can carry another version's title or duration.
 */
export function sonovaultSimilarMatch(
  check: SimilarTrackCheck,
  line: SonovaultResolveResult,
): SpotifyCodeMatch | SonovaultSimilarMiss {
  if (line.status !== 'matched' || !line.track)
    return line.status === 'skipped_no_credits'
      ? 'skipped_no_credits'
      : 'not_found'
  const spotify = line.links.find(
    (link) =>
      link.source === 'spotify' && spotifyTrackIdPattern.test(link.external_id),
  )
  if (!spotify) return 'no_spotify'
  if (
    !verifySonovaultRecord(
      { title: check.title, durationSec: check.durationSec },
      line.track,
    )
  )
    return 'unverified'
  const match = SpotifyCodeMatchSchema.safeParse({
    spotifyId: spotify.external_id,
    url: `https://open.spotify.com/track/${spotify.external_id}`,
    title: line.track.title,
    artists: line.track.artists.slice(0, 50).map(({ name }) => name),
    // Sonovault keeps one Spotify ID per recording; its release list does
    // not say which release that ID is on, so no album is claimed.
    albumName: null,
    spotifyAlbumId: null,
    artworkUrl: null,
    durationSec: line.track.duration,
    trackCount: null,
  })
  return match.success ? match.data : 'no_spotify'
}

/** The job a Sonovault similar lookup runs in and stores its response with. */
export type SonovaultSimilarContext = Pick<
  TaskJobContext,
  'jobId' | 'assertActive' | 'maxSlotWaitMs'
> & {
  /** The job's own provider when it is not Sonovault (a TIDAL similar read). */
  jobProvider?: string
}

/**
 * SONO-26: sends the ISRCs of one track's similar tracks through one
 * Sonovault bulk resolve, storing the response with the job, and returns
 * the verified Spotify matches. Each ISRC comes with TIDAL's title and
 * duration, which the record is checked against. The request takes its turn
 * in Sonovault's request gate with every other Sonovault request, waiting at
 * most `maxSlotWaitMs` for its slot when set. Returns `unavailable`, and
 * makes no request, when Sonovault is not configured, cooling down, halted
 * or busy past that wait, or the credit reserve would be crossed; the caller
 * then searches Spotify.
 */
export async function lookupSimilarTracksOnSonovault(
  context: SonovaultSimilarContext,
  checks: readonly SimilarTrackCheck[],
  subjectId?: string,
): Promise<SonovaultSimilarLookup> {
  const byIsrc = new Map<string, SimilarTrackCheck>()
  for (const check of checks) {
    const isrc = validIsrc(check.code)
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, check)
  }
  const sent = [...byIsrc].map(([isrc, check]) => ({ isrc, check }))
  if (!sent.length)
    return {
      kind: 'unavailable',
      reason: 'no track to check its record against',
    }
  const now = new Date()
  let lookup: Lookup
  try {
    lookup = await providerOperation<Lookup>(
      PROVIDER,
      async ({ secrets }, plugin) => {
        const settings = sonovaultSettings(secrets)
        const report = await reportedSonovaultCredits(db, now)
        const remaining = report?.current
          ? report.remaining
          : settings.monthlyCredits
        if (remaining - sent.length < settings.creditReserve)
          return {
            kind: 'reserve',
            remaining,
            reserve: settings.creditReserve,
          }
        const recorder = createProviderResponseRecorder(
          (capture) =>
            saveProviderResponseCapture({
              jobId: context.jobId,
              provider: PROVIDER,
              ...(context.jobProvider === undefined
                ? {}
                : { jobProvider: context.jobProvider }),
              attempt: 1,
              capture,
            }),
          providerResponseSecretValues({ apiKey: settings.apiKey }),
          undefined,
          undefined,
          undefined,
          { firstOrdinal: await nextTaskResponseOrdinal(context.jobId) },
        )
        const payload = await resolveSonovaultTracks(
          createProviderRequest(
            sonovaultGatedPlugin(plugin, settings),
            context.assertActive,
            {
              ...(context.maxSlotWaitMs === undefined
                ? {}
                : { maxSlotWaitMs: context.maxSlotWaitMs }),
              beginResponseCapture: recorder('task'),
            },
          ),
          settings.apiKey,
          'isrc',
          sent.map(({ isrc }) => isrc),
        )
        recorder.assertStored()
        return {
          kind: 'resolved',
          results: payload.results,
          creditsUsed: payload.credits_used,
          creditsRemaining: payload.credits_remaining,
        }
      },
      context.assertActive,
      'looking up similar tracks',
    )
  } catch (error) {
    if (!(error instanceof ServerError)) throw error
    return { kind: 'unavailable', reason: error.message }
  }
  if (lookup.kind === 'reserve')
    return {
      kind: 'unavailable',
      reason: `${sent.length} credits would leave fewer than the ${lookup.reserve}-credit reserve (${lookup.remaining} left)`,
    }
  const response = await storedSonovaultResponse(db, context.jobId)
  if (subjectId) {
    await context.assertActive()
    await db.transaction(async (tx) => {
      for (const [index, line] of lookup.results.entries()) {
        if (line.status !== 'matched' || !line.track) continue
        await observeSonovaultTrack(tx, line.track, line.links, {
          operation: 'similar-resolution',
          occurrenceKey: context.jobId,
          jobId: context.jobId,
          responseId: response.id,
          observedAt: response.fetchedAt,
          subjectKind: 'track',
          subjectId,
          position: index + 1,
        })
      }
    })
  }
  const matches = new Map<string, SpotifyCodeMatch>()
  const misses = new Map<string, SonovaultSimilarMiss>()
  sent.forEach(({ isrc, check }, index) => {
    const line = lookup.results[index]
    const result =
      line && typeof line.input === 'string' && validIsrc(line.input) === isrc
        ? sonovaultSimilarMatch(check, line)
        : 'not_found'
    if (typeof result === 'string') misses.set(isrc, result)
    else matches.set(isrc, result)
  })
  return {
    kind: 'resolved',
    matches,
    misses,
    responseId: response.id,
    fetchedAt: response.fetchedAt,
    creditsUsed: lookup.creditsUsed,
    creditsRemaining: lookup.creditsRemaining,
  }
}

const LookupOptionsSchema = z.object({
  kind: z.literal('track'),
  itemId: z.string().trim().min(1).max(200),
  tracks: z.array(SimilarTrackCheckSchema).min(1).max(TIDAL_SIMILAR_LIMIT),
})

/**
 * New `sonovault-similar-lookup` jobs are refused: the lookup runs in the
 * TIDAL similar read. Jobs queued before that still run.
 */
export async function prepareSonovaultSimilarLookup(): Promise<never> {
  throw new ServerError({
    statusCode: 409,
    message:
      'Similar tracks are looked up on Sonovault when they are read from TIDAL. Read them again from the Similar tab.',
  })
}

/** Queues the Spotify search for the ISRCs Sonovault did not map. */
async function queueSpotifyFallback(
  userId: string | null,
  itemId: string,
  codes: readonly string[],
) {
  if (!codes.length) return null
  try {
    await createTaskJob(SPOTIFY_SIMILAR_LOOKUP_TASK, userId, {
      taskOptions: { kind: 'track', itemId, codes: [...codes] },
    })
    return `${codes.length} left for Spotify search.`
  } catch (error) {
    if (!(error instanceof ServerError)) throw error
    return `${codes.length} not searched on Spotify: ${error.message}`
  }
}

export type SonovaultSimilarMapping = {
  message: string
  /** Counts for the job's options, with the credits Sonovault reported. */
  summary: Record<string, JsonValue>
  /** Credits as reported, for `reportedSonovaultCredits`; none without a request. */
  credits: { creditsRemaining: number; creditsReportedAt: string } | null
}

/**
 * SONO-26: maps one library track's similar tracks to Spotify through one
 * Sonovault bulk resolve by ISRC and stores each verified match where the
 * Similar tab reads Spotify lookups, marked as Sonovault's with the stored
 * response. A miss is not "Not on Spotify": the ISRCs it does not map, and
 * all of them when Sonovault cannot be used, are queued for the existing
 * Spotify search. Null when the job stopped.
 */
export async function mapSimilarTracksThroughSonovault(
  context: SonovaultSimilarContext & Pick<TaskJobContext, 'isActive'>,
  input: {
    userId: string | null
    itemId: string
    tracks: readonly SimilarTrackCheck[]
    /** Existing Spotify matches and recent misses do not need remapping. */
    spotifyCodes?: ReadonlySet<string>
    spotifyOnlyCodes?: readonly string[]
  },
): Promise<SonovaultSimilarMapping | null> {
  const lookup = await lookupSimilarTracksOnSonovault(
    context,
    input.tracks,
    input.itemId,
  )
  const needsSpotify = (isrc: string) => input.spotifyCodes?.has(isrc) ?? true
  if (!(await context.isActive())) return null
  if (lookup.kind === 'unavailable') {
    const spotify = await queueSpotifyFallback(input.userId, input.itemId, [
      ...input.tracks.map(({ code }) => code).filter(needsSpotify),
      ...(input.spotifyOnlyCodes ?? []),
    ])
    return {
      message: [`Sonovault not used: ${lookup.reason}.`, spotify]
        .filter(Boolean)
        .join(' '),
      summary: { sent: 0, mapped: 0 },
      credits: null,
    }
  }
  for (const [key, match] of lookup.matches) {
    if (!needsSpotify(key)) continue
    await storeSpotifyCodeLookup({
      kind: 'track',
      key,
      match,
      jobId: context.jobId,
      sonovault: {
        responseId: lookup.responseId,
        fetchedAt: lookup.fetchedAt,
      },
    })
  }
  const missed = [...lookup.misses.keys()]
  const spotify = await queueSpotifyFallback(input.userId, input.itemId, [
    ...missed.filter(needsSpotify),
    ...(input.spotifyOnlyCodes ?? []),
  ])
  const missCount = (reason: SonovaultSimilarMiss) =>
    [...lookup.misses.values()].filter((miss) => miss === reason).length
  return {
    message: [
      `Mapped ${lookup.matches.size} of ${lookup.matches.size + missed.length} to Spotify through Sonovault.`,
      spotify,
      `${lookup.creditsRemaining} credits left.`,
    ]
      .filter(Boolean)
      .join(' '),
    summary: {
      sent: lookup.matches.size + missed.length,
      mapped: lookup.matches.size,
      notFound: missCount('not_found'),
      noSpotify: missCount('no_spotify'),
      unverified: missCount('unverified'),
      skipped: missCount('skipped_no_credits'),
      creditsUsed: lookup.creditsUsed,
      responseId: lookup.responseId,
    },
    credits: {
      creditsRemaining: lookup.creditsRemaining,
      creditsReportedAt: new Date().toISOString(),
    },
  }
}

/**
 * A `sonovault-similar-lookup` job queued before the lookup moved into the
 * TIDAL similar read: maps its tracks as that read does.
 */
export async function runSonovaultSimilarLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = LookupOptionsSchema.parse(input)
    await context.assertActive()
    await context.activity('Matching similar tracks through Sonovault', {
      total: options.tracks.length,
      unit: 'tracks',
    })
    const mapping = await mapSimilarTracksThroughSonovault(context, {
      userId: context.requestedByUserId,
      itemId: options.itemId,
      tracks: options.tracks,
    })
    if (!mapping) return { outcome: 'stopped' }
    return {
      outcome: 'complete',
      message: mapping.message,
      ...(mapping.credits ? {} : { noProviderRequests: true }),
      options: { ...mapping.summary, ...mapping.credits },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
