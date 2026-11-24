import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_LIMIT,
  TidalSimilarKindSchema,
  TidalSuggestionSchema,
  type SpotifyCodeLookupSource,
  type SpotifyCodeMatch,
  type TidalSimilarKind,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId, parseOptionalDate } from '@/lib/media-utils'
import { mediaItem, spotifyCodeLookup, tidalSimilar } from '@/schemas/db'
import { reconcileSimilarArtistCredits } from './catalog-artist-reconciliation'
import type { TaskJobContext, TaskJobResult } from './jobs'
import { observeCatalogMedia, type CatalogOrigin } from './catalog-discoveries'
import {
  prepareSpotifyCatalogTrackSearch,
  runSpotifyCatalogSearches,
} from './manual-add'
import {
  latestCatalogResponseId,
  observeTidalSimilarLibraryMatches,
  spotifyTrackAndAlbumObservations,
} from './music-catalog-observations'
import { libraryMembershipBySpotifyId } from './similar-library-matches'
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

/**
 * Stores one lookup's result, or a Spotify search's miss, with its time and
 * who answered: a Spotify search, or Sonovault with the response it came
 * from (SONO-26).
 */
export async function storeSpotifyCodeLookup(input: {
  kind: TidalSimilarKind
  key: string
  match: SpotifyCodeMatch | null
  jobId: string
  itemId?: string
  sonovault?: { responseId: string; fetchedAt: Date }
}) {
  const source: SpotifyCodeLookupSource = input.sonovault
    ? 'sonovault'
    : 'spotify'
  const values = {
    spotifyId: input.match?.spotifyId ?? null,
    result: input.match,
    source,
    responseId: input.sonovault?.responseId ?? null,
    scrapeJobId: input.jobId,
    searchedAt: input.sonovault?.fetchedAt ?? new Date(),
  }
  await db.transaction(async (tx) => {
    if (input.itemId && input.kind === 'track')
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    await tx
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
    if (
      source === 'spotify' &&
      input.itemId &&
      input.kind === 'track' &&
      input.match
    ) {
      const [saved] = await tx
        .select({
          items: tidalSimilar.items,
          jobId: tidalSimilar.scrapeJobId,
          readAt: tidalSimilar.readAt,
        })
        .from(tidalSimilar)
        .where(
          and(
            eq(tidalSimilar.mediaItemId, input.itemId),
            eq(tidalSimilar.kind, 'track'),
          ),
        )
      const items =
        z.array(TidalSuggestionSchema).safeParse(saved?.items).data ?? []
      const matching = items.flatMap((item, index) =>
        codeKey('track', item.code ?? '') === input.key
          ? [{ ...item, catalogPosition: item.catalogPosition ?? index + 1 }]
          : [],
      )
      if (!saved || !matching.length) return
      const responseId = saved.jobId
        ? await latestCatalogResponseId(tx, saved.jobId, 'tidal')
        : undefined
      await observeTidalSimilarLibraryMatches(tx, matching, {
        seedId: input.itemId,
        jobId: saved.jobId ?? undefined,
        responseId,
        observedAt: saved.readAt,
      })
      if (input.match.artistCredits?.length)
        await reconcileSimilarArtistCredits(tx, matching)
    }
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
    await context.activity('Searching Spotify for similar items', {
      done: 0,
      total: codes.length,
      unit: 'items',
    })
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
            async (candidates) => {
              if (!candidates.length) return
              await context.assertActive()
              await db.transaction(async (tx) => {
                const responseId = await latestCatalogResponseId(
                  tx,
                  context.jobId,
                  'spotify',
                )
                for (const [index, candidate] of candidates.entries()) {
                  const origin = {
                    provider: 'spotify',
                    operation: 'spotify-code-search',
                    occurrenceKey: JSON.stringify([
                      context.jobId,
                      key,
                      index + 1,
                    ]),
                    subjectKind: options.kind,
                    subjectId: options.itemId,
                    jobId: context.jobId,
                    responseId,
                    page: 1,
                    position: index + 1,
                  } satisfies CatalogOrigin
                  if (options.kind === 'track') {
                    const { album, recording } =
                      spotifyTrackAndAlbumObservations(
                        {
                          ...candidate,
                          artistCredits: candidate.artistCredits ?? [],
                          spotifyTrackId: candidate.spotifyId,
                          spotifyUrl: candidate.url,
                          albumName: candidate.spotifyAlbumId
                            ? candidate.albumName
                            : null,
                        },
                        { ...origin, key: origin.occurrenceKey },
                      )
                    const albumId = album
                      ? await observeCatalogMedia(tx, album.media, {
                          ...origin,
                          relationshipRole: album.origin.relationshipRole,
                        })
                      : undefined
                    await observeCatalogMedia(
                      tx,
                      {
                        ...recording.media,
                        albumId,
                        albumName: candidate.albumName,
                      },
                      origin,
                    )
                    continue
                  }
                  await observeCatalogMedia(
                    tx,
                    {
                      kind: 'album',
                      title: candidate.title,
                      provider: 'spotify',
                      referenceType: 'spotify',
                      externalId: candidate.spotifyId,
                      artworkUrl: candidate.artworkUrl,
                      spotifyUrl: candidate.url,
                      releaseDate: parseOptionalDate(candidate.releaseDate),
                      albumName: candidate.albumName,
                      spotifyAlbumId: candidate.spotifyAlbumId,
                      durationSec: candidate.durationSec,
                      trackCount: candidate.trackCount ?? undefined,
                      credits: [
                        ...(candidate.artistCredits ?? []).map(
                          ({ id, name }) => ({ name, externalId: id }),
                        ),
                        ...candidate.artists
                          .filter(
                            (name) =>
                              !candidate.artistCredits?.some(
                                (credit) => credit.name === name,
                              ),
                          )
                          .map((name) => ({ name })),
                      ],
                    },
                    origin,
                  )
                }
              })
            },
          )
          let match: SpotifyCodeMatch | null
          if (result.kind === 'album') match = result.album
          else {
            const library = await libraryMembershipBySpotifyId(
              db,
              'track',
              result.tracks.map(({ spotifyId }) => spotifyId),
            )
            const chosen = chooseSpotifyTrack(
              key,
              result.tracks,
              new Set(library.visible.keys()),
            )
            match = chosen
              ? {
                  spotifyId: chosen.spotifyId,
                  url: chosen.url,
                  title: chosen.title,
                  artists: chosen.artists,
                  artistCredits: chosen.artistCredits,
                  albumName: chosen.albumName,
                  spotifyAlbumId: chosen.spotifyAlbumId,
                  artworkUrl: chosen.artworkUrl,
                  durationSec: chosen.durationSec,
                  trackCount: chosen.trackCount,
                }
              : null
          }
          await context.assertActive()
          await storeSpotifyCodeLookup({
            kind: options.kind,
            itemId: options.itemId,
            key,
            match,
            jobId: context.jobId,
          })
          searched += 1
          await context.activity('Searching Spotify for similar items', {
            done: searched,
            total: codes.length,
            unit: 'items',
          })
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
