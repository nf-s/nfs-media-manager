import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { SONOVAULT_SIMILAR_LOOKUP_TASK } from '@repo/schemas/sonovault'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  SpotifyCodeMatchSchema,
  TIDAL_SIMILAR_LIMIT,
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
  resolveSonovaultTracks,
  sonovaultGatedPlugin,
  sonovaultSettings,
  type SonovaultResolveResult,
} from '@/lib/sonovault-api'
import { createStableId } from '@/lib/media-utils'
import { mediaItem } from '@/schemas/db'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { assertProviderConfigured, providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import {
  reportedSonovaultCredits,
  storedSonovaultResponse,
  verifySonovaultRecord,
} from './sonovault-track-lookup'
import { storeSpotifyCodeLookup } from './spotify-similar-lookup'

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

/** A suggestion's title with its version, as a library title would read. */
const suggestionTitle = (suggestion: TidalSuggestion) =>
  suggestion.version && !suggestion.title.includes(suggestion.version)
    ? `${suggestion.title} (${suggestion.version})`
    : suggestion.title

/** What a similar track's Sonovault record is checked against (SONO-08). */
export function similarTrackCheck(
  suggestion: TidalSuggestion,
): SimilarTrackCheck | null {
  const code = validIsrc(suggestion.code)
  return code
    ? {
        code,
        title: suggestionTitle(suggestion),
        durationSec: suggestion.durationSec,
      }
    : null
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

/**
 * SONO-26: sends the ISRCs of one track's similar tracks through one
 * Sonovault bulk resolve, storing the response with the job, and returns
 * the verified Spotify matches. Each ISRC comes with TIDAL's title and
 * duration, which the record is checked against. Returns `unavailable`, and
 * makes no request, when Sonovault is not configured or reachable or the
 * credit reserve would be crossed; the caller then searches Spotify.
 */
export async function lookupSimilarTracksOnSonovault(
  context: Pick<TaskJobContext, 'jobId' | 'assertActive'>,
  checks: readonly SimilarTrackCheck[],
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
              attempt: 1,
              capture,
            }),
          providerResponseSecretValues({ apiKey: settings.apiKey }),
        )
        const payload = await resolveSonovaultTracks(
          createProviderRequest(
            sonovaultGatedPlugin(plugin, settings),
            context.assertActive,
            { beginResponseCapture: recorder('task') },
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
  const matches = new Map<string, SpotifyCodeMatch>()
  const misses = new Map<string, SonovaultSimilarMiss>()
  sent.forEach(({ isrc, check }, index) => {
    const line = lookup.results[index]
    const result =
      line && validIsrc(line.input) === isrc
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

const LookupParamsSchema = z.object({
  kind: z.literal('track'),
  itemId: z.string().trim().min(1).max(200),
  tracks: z.array(SimilarTrackCheckSchema).min(1).max(TIDAL_SIMILAR_LIMIT),
})
const LookupOptionsSchema = LookupParamsSchema.extend({
  groupKey: z.string().min(1),
})

export async function prepareSonovaultSimilarLookup(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const params = LookupParamsSchema.parse(input)
  const [item] = await db
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .where(
      and(eq(mediaItem.id, params.itemId), eq(mediaItem.mediaType, 'track')),
    )
  if (!item)
    throw new ServerError({ statusCode: 404, message: 'Item not found.' })
  await assertProviderConfigured(PROVIDER, 'looking up similar tracks')
  return LookupOptionsSchema.parse({
    ...params,
    groupKey: createStableId(
      SONOVAULT_SIMILAR_LOOKUP_TASK,
      JSON.stringify([userId, params.itemId]),
    ),
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

/**
 * SONO-26: maps one library track's similar tracks to Spotify through one
 * Sonovault bulk resolve by ISRC and stores each verified match where the
 * Similar tab reads Spotify lookups, marked as Sonovault's. A miss is not
 * "Not on Spotify": the ISRCs it does not map, and all of them when Sonovault
 * cannot be used, are queued for the existing Spotify search.
 */
export async function runSonovaultSimilarLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = LookupOptionsSchema.parse(input)
    await context.assertActive()
    const lookup = await lookupSimilarTracksOnSonovault(context, options.tracks)
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (lookup.kind === 'unavailable') {
      const spotify = await queueSpotifyFallback(
        context.requestedByUserId,
        options.itemId,
        options.tracks.map(({ code }) => code),
      )
      return {
        outcome: 'complete',
        message: [`Sonovault not used: ${lookup.reason}.`, spotify]
          .filter(Boolean)
          .join(' '),
        noProviderRequests: true,
        options: { mapped: 0, sent: 0 },
      }
    }
    for (const [key, match] of lookup.matches)
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
    const missed = [...lookup.misses.keys()]
    const spotify = await queueSpotifyFallback(
      context.requestedByUserId,
      options.itemId,
      missed,
    )
    const missCount = (reason: SonovaultSimilarMiss) =>
      [...lookup.misses.values()].filter((miss) => miss === reason).length
    return {
      outcome: 'complete',
      message: [
        `Mapped ${lookup.matches.size} of ${lookup.matches.size + missed.length} to Spotify through Sonovault.`,
        spotify,
        `${lookup.creditsRemaining} credits left.`,
      ]
        .filter(Boolean)
        .join(' '),
      options: {
        sent: lookup.matches.size + missed.length,
        mapped: lookup.matches.size,
        notFound: missCount('not_found'),
        noSpotify: missCount('no_spotify'),
        unverified: missCount('unverified'),
        skipped: missCount('skipped_no_credits'),
        creditsUsed: lookup.creditsUsed,
        creditsRemaining: lookup.creditsRemaining,
        creditsReportedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
