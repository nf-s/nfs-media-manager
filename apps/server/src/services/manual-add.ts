import { eq } from 'drizzle-orm'
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
  SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED,
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchMarketSchema,
} from '@repo/schemas/spotify-track-search'
import { LASTFM_SPOTIFY_SEARCH_TASK } from '@repo/schemas/lastfm'
import { db } from '@/lib/db'
import {
  ProviderResponseStorageError,
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import { normalizeSpotifyAlbum, spotifyJson } from '@/lib/spotify-api'
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
import {
  existingManualTrack,
  findManualTrackMatches,
  storeManualTrack,
} from './spotify-track-recordings'
import { saveProviderResponseCapture } from './provider-response-history'
import {
  normalizeSpotifyCatalogTrack,
  projectSpotifyCatalogAlbums,
  searchSpotifyCatalogAlbums,
  searchSpotifyCatalogTrackPage,
  searchSpotifyCatalogTracks,
} from './provider-search-task-replay'
import {
  appendProviderTaskReplayStep,
  type ProviderTaskReplayStep,
} from './provider-task-replay'
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
    if (
      error instanceof ServerError ||
      error instanceof ProviderResponseStorageError
    )
      throw error
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

function spotifyMarket(secrets: Record<string, string>): { market?: string } {
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
    message: hasClientCredentials
      ? SPOTIFY_TRACK_SEARCH_MARKET_REQUIRED
      : 'Configure Spotify Client ID and Client secret in Providers or connect a Spotify account to search tracks.',
  })
}

export async function prepareSpotifyCatalogTrackSearch(
  userId: string | null,
  market?: string,
) {
  await spotifyTrackSearchAccess(userId, market)
}

async function catalogJobRequest(
  jobId: string,
  task: typeof LASTFM_SPOTIFY_SEARCH_TASK | typeof SPOTIFY_TRACK_SEARCH_TASK,
  step: ProviderTaskReplayStep,
  plugin: MediaProviderPlugin,
  secrets: Record<string, string>,
  assertActive?: () => Promise<void>,
) {
  await appendProviderTaskReplayStep(jobId, 'spotify', task, step)
  const recorder = createProviderResponseRecorder(
    (capture) =>
      saveProviderResponseCapture({
        jobId,
        provider: 'spotify',
        attempt: 1,
        capture,
      }),
    providerResponseSecretValues(secrets),
  )
  return createProviderRequest(plugin, assertActive, {
    beginResponseCapture: recorder('task'),
  })
}

export async function searchSpotifyTrackCandidates(
  query: string,
  userId: string | null,
  assertActive: () => Promise<void>,
  market?: string,
  jobId?: string,
) {
  const { provider, params, account } = await spotifyTrackSearchAccess(
    userId,
    market,
  )
  return runProviderOperation(
    provider,
    async ({ secrets, request }, plugin) => {
      const token = account
        ? await spotifyAccountToken(account, request)
        : await spotifyClientToken(secrets, request)
      const input = { ...params, query }
      const lookup = jobId
        ? await catalogJobRequest(
            jobId,
            SPOTIFY_TRACK_SEARCH_TASK,
            {
              operation: 'track-search',
              args: input,
            },
            plugin,
            secrets,
            assertActive,
          )
        : request
      return searchSpotifyCatalogTracks(lookup, token, input)
    },
    assertActive,
  )
}

async function manualSpotifyTrackOperation<T>(
  userId: string | null,
  operation: (
    request: MediaPluginTestContext['request'],
    token: string,
    market: { market?: string },
  ) => Promise<T>,
) {
  const { provider, params, account } = await spotifyTrackSearchAccess(userId)
  return runProviderOperation(provider, async ({ secrets, request }) => {
    const token = account
      ? await spotifyAccountToken(account, request)
      : await spotifyClientToken(secrets, request)
    return operation(request, token, params)
  })
}

async function searchManualSpotifyTracks(
  query: string,
  page: number,
  userId: string | null,
) {
  const result = await manualSpotifyTrackOperation(
    userId,
    (request, token, market) =>
      searchSpotifyCatalogTrackPage(request, token, { ...market, query, page }),
  )
  const matches = await findManualTrackMatches(
    result.items.map((track) => track.spotifyTrackId),
  )
  return ManualMediaSearchResultSchema.parse({
    items: result.items.map((track) => {
      const match = matches.get(track.spotifyTrackId)
      return {
        externalId: track.spotifyTrackId,
        title: track.title,
        subtitle: [track.artists.join(', '), track.albumName]
          .filter(Boolean)
          .join(' · '),
        releaseDate: track.releaseDate,
        artworkUrl: track.artworkUrl,
        url: track.spotifyUrl,
        mediaItemId: match?.hidden ? null : (match?.id ?? null),
      }
    }),
    page,
    hasMore: result.hasMore,
  })
}

async function addManualSpotifyTrack(spotifyId: string, userId: string | null) {
  const match = (await findManualTrackMatches([spotifyId])).get(spotifyId)
  const existing = existingManualTrack(match)
  if (existing) return existing

  const track = await manualSpotifyTrackOperation(
    userId,
    async (request, token, market) => {
      const candidate = normalizeSpotifyCatalogTrack(
        await spotifyJson(request, token, `tracks/${spotifyId}`, market),
      )
      if (candidate?.spotifyTrackId !== spotifyId)
        throw new Error('Provider metadata does not match the selected item')
      return candidate
    },
  )
  return storeManualTrack(track)
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
  {
    assertActive,
    jobId,
    userId = null,
  }: {
    assertActive?: () => Promise<void>
    jobId?: string
    userId?: string | null
  } = {},
) {
  const options = ManualMediaSearchInputSchema.parse(input)
  if (options.mediaType === 'track')
    return searchManualSpotifyTracks(options.q, options.page, userId)
  if (options.mediaType === 'album') {
    const page = await providerOperation(
      'spotify',
      async ({ secrets, request }, plugin) => {
        const market = spotifyMarket(secrets)
        const token = await spotifyClientToken(secrets, request)
        const input = { ...market, query: options.q, page: options.page }
        const lookup = jobId
          ? await catalogJobRequest(
              jobId,
              LASTFM_SPOTIFY_SEARCH_TASK,
              {
                operation: 'album-search',
                args: input,
              },
              plugin,
              secrets,
              assertActive,
            )
          : request
        return searchSpotifyCatalogAlbums(lookup, token, input)
      },
      assertActive,
    )
    const result = projectSpotifyCatalogAlbums(page, options.page)
    const candidates = page.items.map((item) =>
      AlbumImportCandidateSchema.parse({
        provider: 'spotify',
        source: 'https://open.spotify.com/album/' + item.id,
        result: normalizeSpotifyAlbum(item),
      }),
    )
    const matches = await matchAlbumCandidates(candidates)
    return {
      ...result,
      items: result.items.map((item, index) => ({
        ...item,
        mediaItemId: matches[index]?.error
          ? null
          : (matches[index]?.id ?? null),
      })),
    }
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
  userId: string | null = null,
): Promise<ManualMediaAddResult> {
  const options = ManualMediaAddInputSchema.parse(input)
  if (options.mediaType === 'track')
    return addManualSpotifyTrack(options.externalId, userId)
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
