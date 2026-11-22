import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_LIMIT,
  TidalSimilarKindSchema,
  type SpotifyCodeMatch,
  type TidalSimilarKind,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import { mediaItem, spotifyCodeLookup } from '@/schemas/db'
import type { TaskJobContext, TaskJobResult } from './jobs'
import {
  prepareSpotifyCatalogTrackSearch,
  runSpotifyCatalogSearches,
} from './manual-add'
import { libraryItemsBySpotifyId } from './similar-library-matches'
import {
  chooseSpotifyTrack,
  codeKey,
  searchSpotifyCode,
} from './spotify-code-search'

const LookupParamsSchema = z.object({
  kind: TidalSimilarKindSchema,
  itemId: z.string().trim().min(1).max(200),
  codes: z
    .array(z.string().trim().min(1).max(40))
    .min(1)
    .max(TIDAL_SIMILAR_LIMIT),
})
const LookupOptionsSchema = LookupParamsSchema.extend({
  groupKey: z.string().min(1),
})

/** Codes as searched, one per stored key, invalid codes left out. */
function searchableCodes(kind: TidalSimilarKind, codes: readonly string[]) {
  const byKey = new Map<string, string>()
  for (const code of codes) {
    const key = codeKey(kind, code)
    if (key && !byKey.has(key)) byKey.set(key, code)
  }
  return [...byKey].map(([key, code]) => ({ key, code }))
}

export async function prepareSpotifySimilarLookup(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const params = LookupParamsSchema.parse(input)
  const codes = searchableCodes(params.kind, params.codes)
  if (!codes.length)
    throw new ServerError({
      statusCode: 422,
      message: 'No valid ISRC or UPC to look up.',
    })
  const [item] = await db
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .where(
      and(
        eq(mediaItem.id, params.itemId),
        eq(mediaItem.mediaType, params.kind),
      ),
    )
  if (!item)
    throw new ServerError({ statusCode: 404, message: 'Item not found.' })
  await prepareSpotifyCatalogTrackSearch(userId)
  return LookupOptionsSchema.parse({
    ...params,
    codes: codes.map(({ code }) => code),
    groupKey: createStableId(
      SPOTIFY_SIMILAR_LOOKUP_TASK,
      JSON.stringify([userId, params.kind, params.itemId]),
    ),
  })
}

/** Stores one search's result, or its miss, with the time of the search. */
async function storeLookup(input: {
  kind: TidalSimilarKind
  key: string
  match: SpotifyCodeMatch | null
  jobId: string
}) {
  const searchedAt = new Date()
  const values = {
    spotifyId: input.match?.spotifyId ?? null,
    result: input.match,
    scrapeJobId: input.jobId,
    searchedAt,
  }
  await db
    .insert(spotifyCodeLookup)
    .values({
      codeType: input.kind === 'album' ? 'upc' : 'isrc',
      code: input.key,
      ...values,
    })
    .onConflictDoUpdate({
      target: [spotifyCodeLookup.codeType, spotifyCodeLookup.code],
      set: { ...values, updatedAt: sql`now()` },
    })
}

/**
 * Searches Spotify for each similar item of one album or track by its ISRC
 * or UPC, one request each, and stores what was found as soon as it is.
 */
export async function runSpotifySimilarLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = LookupOptionsSchema.parse(input)
    const codes = searchableCodes(options.kind, options.codes)
    await context.assertActive()
    let found = 0
    let searched = 0
    await runSpotifyCatalogSearches(
      context.requestedByUserId,
      context.jobId,
      SPOTIFY_SIMILAR_LOOKUP_TASK,
      context.assertActive,
      async ({ token, market, request }) => {
        for (const { key, code } of codes) {
          const args = {
            kind: options.kind,
            code,
            ...(market ? { market } : {}),
          }
          const result = await searchSpotifyCode(
            await request({ operation: 'code-search', args }),
            token,
            args,
          )
          let match: SpotifyCodeMatch | null
          if (result.kind === 'album') match = result.album
          else {
            const library = await libraryItemsBySpotifyId(
              db,
              'track',
              result.tracks.map(({ spotifyId }) => spotifyId),
            )
            const chosen = chooseSpotifyTrack(
              key,
              result.tracks,
              new Set(library.keys()),
            )
            match = chosen
              ? {
                  spotifyId: chosen.spotifyId,
                  url: chosen.url,
                  title: chosen.title,
                  artists: chosen.artists,
                  albumName: chosen.albumName,
                  spotifyAlbumId: chosen.spotifyAlbumId,
                  artworkUrl: chosen.artworkUrl,
                  durationSec: chosen.durationSec,
                  trackCount: chosen.trackCount,
                }
              : null
          }
          await context.assertActive()
          await storeLookup({
            kind: options.kind,
            key,
            match,
            jobId: context.jobId,
          })
          searched += 1
          if (match) found += 1
        }
      },
    )
    return {
      outcome: 'complete',
      message: `Found ${found} of ${searched} on Spotify.`,
      options: { found, searched },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
