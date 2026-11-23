import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import {
  TidalIdSchema,
  TIDAL_SIMILAR_LIMIT,
  normalizeSimilarGenres,
  type TidalSimilarItem,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { albumNameKey } from '@/lib/album-import-candidates'
import { db } from '@/lib/db'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import {
  confirmSonovaultRelease,
  positionedReleaseTracks,
} from '@/lib/sonovault-album-match'
import {
  findSonovaultReleasesByBarcode,
  getSonovaultRelease,
  sonovaultGatedPlugin,
  sonovaultSettings,
  SONOVAULT_API_BASE,
  SonovaultReleaseSchema,
  type SonovaultRelease,
  type SonovaultRequest,
} from '@/lib/sonovault-api'
import { UpcSchema } from '@/lib/spotify-api'
import { providerResponse } from '@/schemas/db'
import type { TaskJobContext } from './jobs'
import { providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import {
  nextTaskResponseOrdinal,
  saveProviderResponseCapture,
} from './provider-response-history'
import {
  parseSimilarSonovaultResponse,
  readSimilarSonovaultResponses,
} from './similar-sonovault-responses'
import { reportedSonovaultCredits } from './sonovault-track-lookup'
import { upcKey } from './spotify-code-search'

const PROVIDER = 'sonovault'
const ALBUMS_PER_READ = 2
// Barcode lookup, release detail, and edition-specific tracklist if needed.
const MAX_CALLS_PER_ALBUM = 3

export const SimilarAlbumResponsesSchema = z
  .array(
    z.object({
      tidalId: TidalIdSchema,
      barcode: UpcSchema,
      responseId: z.string(),
    }),
  )
  .max(TIDAL_SIMILAR_LIMIT)
type AlbumResponse = z.infer<typeof SimilarAlbumResponsesSchema>[number]
type AlbumCheck = { suggestion: TidalSuggestion; barcode: string }

function albumChecks(suggestions: readonly TidalSuggestion[]): AlbumCheck[] {
  return suggestions.flatMap((suggestion) => {
    const barcode = UpcSchema.safeParse(suggestion.code?.trim())
    return barcode.success && upcKey(barcode.data) !== '0'
      ? [{ suggestion, barcode: barcode.data }]
      : []
  })
}

function matchingEdition(release: SonovaultRelease, check: AlbumCheck) {
  const match = confirmSonovaultRelease(release, {
    upc: check.barcode,
    spotifyAlbumId: null,
    musicbrainzReleaseGroups: [],
    trackCount: 0,
  })
  const edition = match?.edition
  return edition &&
    edition.official !== false &&
    albumNameKey(edition.title ?? release.title) ===
      albumNameKey(check.suggestion.title)
    ? edition.id
    : null
}

async function lookupEdition(
  request: SonovaultRequest,
  apiKey: string,
  check: AlbumCheck,
) {
  try {
    const found = await findSonovaultReleasesByBarcode(
      request,
      apiKey,
      check.barcode,
    )
    const [candidate] = found.results
    if (
      !candidate ||
      found.results.length !== 1 ||
      upcKey(found.upc) !== upcKey(check.barcode)
    )
      return
    const release = await getSonovaultRelease(request, apiKey, candidate.id)
    if (release.id !== candidate.id) return
    const edition = matchingEdition(release, check)
    if (edition !== null && edition !== release.edition)
      await getSonovaultRelease(request, apiKey, release.id, edition)
  } catch (error) {
    if (!isProviderItemNotFoundError(error)) throw error
  }
}

export async function readSimilarSonovaultAlbums(
  database: Pick<typeof db, 'select'>,
  suggestions: readonly TidalSuggestion[],
  previous: readonly AlbumResponse[],
) {
  const byTidal = new Map(
    previous.map((response) => [response.tidalId, response]),
  )
  const rows = await readSimilarSonovaultResponses(
    database,
    previous.map(({ responseId }) => responseId),
  )
  const byResponse = new Map(rows.map((row) => [row.id, row]))
  return new Map(
    albumChecks(suggestions).flatMap((check) => {
      const { tidalId } = check.suggestion
      const ref = byTidal.get(tidalId)
      if (!ref || upcKey(ref.barcode) !== upcKey(check.barcode)) return []
      const row = byResponse.get(ref.responseId)
      if (!row) return []
      const release =
        row.status === 200
          ? parseSimilarSonovaultResponse(SonovaultReleaseSchema, row.text)
          : null
      const memberIds =
        release &&
        release.edition !== null &&
        row.requestUrl === `${SONOVAULT_API_BASE}/v1/releases/${release.id}` &&
        release.edition === matchingEdition(release, check)
          ? new Set(
              positionedReleaseTracks(release).map(
                ({ externalId }) => externalId,
              ),
            )
          : new Set<string>()
      const genres = normalizeSimilarGenres(
        (release?.tracks ?? []).flatMap((track) =>
          memberIds.has(String(track.id)) &&
          track.disc_number !== null &&
          track.track_number !== null
            ? [...track.genre, ...track.subgenre]
            : [],
        ),
      )
      return [[tidalId, { ref, jobId: row.jobId, genres }]]
    }),
  )
}

/** Enrich a small number of unfamiliar editions during the saved Similar read. */
export async function lookupSimilarAlbumGenres(
  context: TaskJobContext,
  suggestions: readonly TidalSimilarItem[],
  previous: readonly AlbumResponse[],
) {
  const cached = await readSimilarSonovaultAlbums(db, suggestions, previous)
  const refs = [...cached.values()].map(({ ref }) => ref)
  const unfamiliar = suggestions.filter(
    (item) =>
      !item.library && !item.genres.length && !item.spotify?.genres?.length,
  )
  const pending = albumChecks(unfamiliar)
    .filter(({ suggestion }) => !cached.has(suggestion.tidalId))
    .slice(0, ALBUMS_PER_READ)
  const completed = new Map<number, AlbumCheck>()
  const now = new Date()
  let remainingBefore: number | null = null
  let creditsUsed = 0
  let message: string | null = null
  if (pending.length) {
    try {
      await providerOperation(
        PROVIDER,
        async ({ secrets }, plugin) => {
          const settings = sonovaultSettings(secrets)
          const report = await reportedSonovaultCredits(db, now)
          remainingBefore = report?.current
            ? report.remaining
            : settings.monthlyCredits
          const recorderStart = await nextTaskResponseOrdinal(context.jobId)
          let lastOrdinal = recorderStart - 1
          const recorder = createProviderResponseRecorder(
            async (capture) => {
              await saveProviderResponseCapture({
                jobId: context.jobId,
                provider: PROVIDER,
                jobProvider: 'tidal',
                attempt: 1,
                capture,
              })
              lastOrdinal = capture.ordinal
              if (
                capture.response.status === 200 ||
                capture.response.status === 404
              )
                creditsUsed += 1
            },
            providerResponseSecretValues({ apiKey: settings.apiKey }),
            undefined,
            undefined,
            undefined,
            { firstOrdinal: recorderStart },
          )
          const request = createProviderRequest(
            sonovaultGatedPlugin(plugin, settings),
            context.assertActive,
            {
              ...(context.maxSlotWaitMs === undefined
                ? {}
                : { maxSlotWaitMs: context.maxSlotWaitMs }),
              beginResponseCapture: recorder('task'),
            },
          )
          for (const check of pending) {
            if (
              remainingBefore - creditsUsed - MAX_CALLS_PER_ALBUM <
              settings.creditReserve
            ) {
              message = 'Sonovault album lookup reached the credit reserve.'
              break
            }
            const before = lastOrdinal
            await lookupEdition(request, settings.apiKey, check)
            recorder.assertStored()
            if (lastOrdinal > before) completed.set(lastOrdinal, check)
          }
        },
        context.assertActive,
        'looking up Similar album genres',
      )
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : 'Sonovault album lookup failed.'
    }
  }
  const rows = completed.size
    ? await db
        .select({ id: providerResponse.id, ordinal: providerResponse.ordinal })
        .from(providerResponse)
        .where(
          and(
            eq(providerResponse.jobId, context.jobId),
            eq(providerResponse.provider, PROVIDER),
            inArray(providerResponse.ordinal, [...completed.keys()]),
          ),
        )
    : []
  for (const row of rows) {
    const check = completed.get(row.ordinal)
    if (check)
      refs.push({
        tidalId: check.suggestion.tidalId,
        barcode: check.barcode,
        responseId: row.id,
      })
  }
  return {
    message,
    options: {
      sonovaultAlbumResponses: refs,
      ...(remainingBefore !== null && creditsUsed > 0
        ? {
            creditsUsed,
            creditsRemaining: Math.max(0, remainingBefore - creditsUsed),
            creditsReportedAt: new Date().toISOString(),
          }
        : {}),
    },
  }
}
