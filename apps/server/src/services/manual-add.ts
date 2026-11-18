import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  PluginResultSchema,
  ProviderRequestError,
  type MediaPluginTestContext,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  ManualMediaAddInputSchema,
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  type ManualMediaAddInput,
  type ManualMediaAddResult,
  type ManualMediaSearchInput,
} from '@repo/schemas/manual-add'
import {
  SPOTIFY_TRACK_SEARCH_LIMIT,
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchMarketSchema,
} from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  SpotifyAlbumSchema,
  normalizeSpotifyAlbum,
  normalizeSpotifyTrackEntry,
  spotifyJson,
} from '@/lib/spotify-api'
import { AlbumImportCandidateSchema } from '@/lib/album-import-candidates'
import { spotifyClientToken } from '@/plugins/builtin/spotify'
import { searchTmdbMovies, tmdbPosterUrl } from '@/plugins/builtin/tmdb'
import { getScrapePlugin } from '@/plugins/registry'
import { providerSecret } from '@/schemas/db'
import { commitAlbumImportRecord, matchAlbumCandidates } from './album-imports'
import {
  commitFilmImportRecord,
  matchFilmCandidates,
  type FilmImportCandidate,
} from './file-imports'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'
import { getProviderTransport } from './provider-transport'
import { getSpotifyAccountStatus, spotifyAccountToken } from './spotify-oauth'

/**
 * A provider and its stored credentials for a request made outside a job.
 * A provider whose local worker is connected may hold its credentials there.
 */
async function manualProvider(
  providerId: string,
  action: string,
  { requireCredentials = true } = {},
) {
  const plugin = await getScrapePlugin(providerId)
  if (!plugin)
    throw new ServerError({
      statusCode: 422,
      message: 'Provider is unavailable',
    })
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, providerId))
  const secrets = resolveProviderSecrets(
    providerId,
    rows,
    plugin.manifest.secrets,
  )
  const worker = plugin.manifest.localWorker
    ? await getProviderTransport(plugin).catch((error: unknown) => {
        if (
          !plugin.manifest.localWorkerRequired ||
          !(error instanceof ProviderRequestError)
        )
          throw error
        throw new ServerError({ statusCode: 422, message: error.message })
      })
    : null
  if (
    requireCredentials &&
    !worker &&
    plugin.manifest.secrets.some(
      (field) => field.required && !secrets[field.key]?.trim(),
    )
  ) {
    throw new ServerError({
      statusCode: 422,
      message: `Configure ${plugin.manifest.displayName} credentials in Providers before ${action}.`,
    })
  }
  return { plugin, secrets }
}

export async function prepareManualMediaSearch(mediaType: 'album' | 'film') {
  await manualProvider(
    mediaType === 'album' ? 'spotify' : 'tmdb',
    'searching or adding items',
  )
}

/**
 * Runs provider requests outside a job through the provider's request policy,
 * recording the outcome. Policy refusals and provider errors become 422s.
 */
export async function providerOperation<T>(
  providerId: string,
  execute: (
    context: MediaPluginTestContext,
    plugin: MediaProviderPlugin,
  ) => Promise<T>,
  assertActive?: () => Promise<void>,
  action = 'searching or adding items',
): Promise<T> {
  const provider = await manualProvider(providerId, action)
  return runProviderOperation(provider, execute, assertActive)
}

async function runProviderOperation<T>(
  { plugin, secrets }: Awaited<ReturnType<typeof manualProvider>>,
  execute: (
    context: MediaPluginTestContext,
    plugin: MediaProviderPlugin,
  ) => Promise<T>,
  assertActive?: () => Promise<void>,
): Promise<T> {
  try {
    await assertActive?.()
    const result = await execute(
      { secrets, request: createProviderRequest(plugin, assertActive) },
      plugin,
    )
    await assertActive?.()
    await recordProviderSuccess(plugin.manifest.id)
    return result
  } catch (error) {
    await assertActive?.()
    if (error instanceof ServerError) throw error
    await recordProviderFailure(plugin, error)
    throw new ServerError({
      statusCode: 422,
      message:
        error instanceof ProviderRequestError
          ? error.message
          : `${plugin.manifest.displayName} request failed or returned invalid data. Review provider status before retrying.`,
    })
  }
}

function spotifyMarket(
  secrets: Record<string, string>,
): Record<string, string> {
  const market = secrets['market']
  if (market && !SpotifyTrackSearchMarketSchema.safeParse(market).success) {
    throw new ServerError({
      statusCode: 422,
      message: 'Spotify market must be a two-letter uppercase country code.',
    })
  }
  return market ? { market } : {}
}

async function spotifyTrackSearchAccess(
  userId: string | null,
  market?: string,
) {
  const explicitMarket = SpotifyTrackSearchMarketSchema.optional().parse(market)
  const provider = await manualProvider('spotify', 'searching tracks', {
    requireCredentials: false,
  })
  const { secrets } = provider
  const params = spotifyMarket(secrets)
  const hasClientCredentials =
    Boolean(secrets.clientId?.trim()) && Boolean(secrets.clientSecret?.trim())
  if (params.market && hasClientCredentials)
    return { provider, params, account: null }
  if (userId && (await getSpotifyAccountStatus(userId)).connected)
    return { provider, params, account: userId }
  if (explicitMarket && hasClientCredentials)
    return { provider, params: { market: explicitMarket }, account: null }
  throw new ServerError({
    statusCode: 422,
    message:
      params.market || explicitMarket
        ? 'Configure Spotify Client ID and Client secret in Providers or connect a Spotify account to search tracks.'
        : 'Set Spotify Market in Providers or connect a Spotify account before searching tracks.',
  })
}

export async function prepareSpotifyCatalogTrackSearch(
  userId: string | null,
  market?: string,
) {
  await spotifyTrackSearchAccess(userId, market)
}

const UnavailableSpotifyCatalogTrackSchema = z.union([
  z.object({ is_playable: z.literal(false) }),
  z.object({ restrictions: z.object({ reason: z.string().trim().min(1) }) }),
])

export async function searchSpotifyTrackCandidates(
  query: string,
  userId: string | null,
  assertActive: () => Promise<void>,
  market?: string,
) {
  const { provider, params, account } = await spotifyTrackSearchAccess(
    userId,
    market,
  )
  return runProviderOperation(
    provider,
    async ({ secrets, request }) => {
      const token = account
        ? await spotifyAccountToken(account, request)
        : await spotifyClientToken(secrets, request)
      const { tracks } = z
        .object({
          tracks: z.object({
            items: z.array(z.unknown()).max(SPOTIFY_TRACK_SEARCH_LIMIT),
            offset: z.literal(0),
          }),
        })
        .parse(
          await spotifyJson(request, token, 'search', {
            ...params,
            q: query,
            type: 'track',
            limit: String(SPOTIFY_TRACK_SEARCH_LIMIT),
          }),
        )
      const seen = new Set<string>()
      return tracks.items.flatMap((item) => {
        if (UnavailableSpotifyCatalogTrackSchema.safeParse(item).success)
          return []
        const { track } = normalizeSpotifyTrackEntry({ item })
        if (!track || seen.has(track.spotifyTrackId)) return []
        const candidate = SpotifyTrackSearchCandidateSchema.safeParse({
          ...track,
          spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
        })
        if (!candidate.success) return []
        seen.add(track.spotifyTrackId)
        return [candidate.data]
      })
    },
    assertActive,
  )
}

function filmCandidate(
  externalId: string,
  title?: string,
): FilmImportCandidate {
  return {
    provider: 'tmdb',
    source: `https://www.themoviedb.org/movie/${externalId}`,
    result: PluginResultSchema.parse({
      payload: {},
      normalized: {
        mediaPatch: { title },
        references: [{ referenceType: 'tmdb', externalId, isPrimary: true }],
      },
    }),
  }
}

export async function searchManualMedia(
  input: ManualMediaSearchInput,
  assertActive?: () => Promise<void>,
) {
  const options = ManualMediaSearchInputSchema.parse(input)
  if (options.mediaType === 'album') {
    const page = await providerOperation(
      'spotify',
      async ({ secrets, request }) => {
        const market = spotifyMarket(secrets)
        const token = await spotifyClientToken(secrets, request)
        return z
          .object({
            albums: z.object({
              items: z.array(SpotifyAlbumSchema).max(10),
              total: z.number().int().nonnegative(),
              offset: z.number().int().nonnegative(),
            }),
          })
          .parse(
            await spotifyJson(request, token, 'search', {
              ...market,
              q: options.q,
              type: 'album',
              limit: '10',
              offset: String((options.page - 1) * 10),
            }),
          ).albums
      },
      assertActive,
    )
    if (page.offset !== (options.page - 1) * 10) {
      throw new ServerError({
        statusCode: 422,
        message: 'Spotify returned an unexpected search page.',
      })
    }
    const candidates = page.items.map((item) =>
      AlbumImportCandidateSchema.parse({
        provider: 'spotify',
        source: `https://open.spotify.com/album/${item.id}`,
        result: normalizeSpotifyAlbum(item),
      }),
    )
    const matches = await matchAlbumCandidates(candidates)
    return ManualMediaSearchResultSchema.parse({
      items: page.items.map((item, index) => ({
        externalId: item.id,
        title: item.name,
        subtitle: item.artists.map((artist) => artist.name).join(', '),
        releaseDate: item.release_date ?? null,
        artworkUrl: item.images[0]?.url ?? null,
        url: `https://open.spotify.com/album/${item.id}`,
        mediaItemId: matches[index]?.error
          ? null
          : (matches[index]?.id ?? null),
      })),
      page: options.page,
      totalCount: Math.min(page.total, 500),
      hasMore:
        options.page < 50 &&
        page.items.length > 0 &&
        page.offset + page.items.length < page.total,
    })
  }
  const page = await providerOperation('tmdb', (context) =>
    searchTmdbMovies(context, options.q, options.page),
  )
  if (page.page !== options.page) {
    throw new ServerError({
      statusCode: 422,
      message: 'TMDb returned an unexpected search page.',
    })
  }
  const matches = await matchFilmCandidates(
    page.results.map((item) => filmCandidate(String(item.id), item.title)),
  )
  return ManualMediaSearchResultSchema.parse({
    items: page.results.map((item, index) => ({
      externalId: String(item.id),
      title: item.title,
      subtitle:
        item.original_title && item.original_title !== item.title
          ? item.original_title
          : null,
      releaseDate: item.release_date || null,
      artworkUrl: tmdbPosterUrl(item.poster_path) ?? null,
      url: `https://www.themoviedb.org/movie/${item.id}`,
      mediaItemId: matches[index]?.error ? null : (matches[index]?.id ?? null),
    })),
    page: options.page,
    ...(page.total_results === undefined
      ? {}
      : { totalCount: Math.min(page.total_results, 1000) }),
    hasMore:
      options.page < 50 &&
      page.results.length > 0 &&
      options.page < page.total_pages,
  })
}

export async function addManualMedia(
  input: ManualMediaAddInput,
): Promise<ManualMediaAddResult> {
  const options = ManualMediaAddInputSchema.parse(input)
  const provider = options.mediaType === 'album' ? 'spotify' : 'tmdb'
  const referenceType = options.mediaType === 'album' ? 'album' : 'tmdb'
  const reference = {
    referenceType,
    externalId: options.externalId,
    isPrimary: true,
    metadata: { sourceProvider: provider },
  }
  const preliminary = PluginResultSchema.parse({
    payload: {},
    normalized: { references: [reference] },
  })
  const [match] =
    options.mediaType === 'album'
      ? await matchAlbumCandidates([
          AlbumImportCandidateSchema.parse({
            provider,
            source: 'manual-add',
            result: preliminary,
          }),
        ])
      : await matchFilmCandidates([filmCandidate(options.externalId)])
  if (match?.error)
    throw new ServerError({ statusCode: 409, message: match.error })
  if (match?.id) return { mediaItemId: match.id, created: false }

  const result = await providerOperation(provider, async (context, plugin) => {
    if (!plugin.scrapeMediaItem)
      throw new Error('Provider does not support metadata lookup')
    const result = PluginResultSchema.parse(
      await plugin.scrapeMediaItem({
        ...context,
        mediaItemId: 'manual-add',
        mediaType: options.mediaType,
        existingReferences: [reference],
        log: async () => {},
      }),
    )
    if (
      !result.normalized.mediaPatch?.title?.trim() ||
      !result.normalized.references.some(
        (item) =>
          item.referenceType === referenceType &&
          item.externalId === options.externalId,
      )
    )
      throw new Error('Provider metadata does not match the selected item')
    return result
  })
  const addedAt = new Date().toISOString()
  if (options.mediaType === 'album') {
    const candidate = AlbumImportCandidateSchema.parse({
      provider: 'spotify',
      source: `https://open.spotify.com/album/${options.externalId}`,
      result: {
        ...result,
        normalized: {
          ...result.normalized,
          albumPatch: { ...result.normalized.albumPatch, dateAdded: addedAt },
        },
      },
    })
    const outcome = await commitAlbumImportRecord(
      { ...candidate, action: 'new' },
      undefined,
      { snapshotSource: 'manual-add' },
    )
    return { mediaItemId: outcome.id, created: outcome.created }
  }
  const outcome = await commitFilmImportRecord(
    {
      provider: 'tmdb',
      source: `https://www.themoviedb.org/movie/${options.externalId}`,
      result: {
        ...result,
        normalized: {
          ...result.normalized,
          filmPatch: {
            ...result.normalized.filmPatch,
            dateAdded: addedAt,
            dateAddedSource: 'Manual addition',
          },
        },
      },
    },
    { newOnly: true, snapshotSource: 'manual-add' },
  )
  return { mediaItemId: outcome.id, created: outcome.action === 'new' }
}
