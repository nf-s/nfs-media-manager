import { and, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  PluginResultSchema,
  ProviderRequestError,
  isProviderItemNotFoundError,
  type MediaPluginTestContext,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  ManualMediaAddInputSchema,
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  type CatalogMembershipInput,
  type CatalogMembershipResult,
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
import { SPOTIFY_SIMILAR_LOOKUP_TASK } from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import {
  ProviderResponseStorageError,
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { ServerError } from '@/lib/error'
import { parseOptionalDate } from '@/lib/media-utils'
import { spotifyInteractiveSearchMetadata } from '@/lib/spotify-interactive-search'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  normalizeSpotifyAlbum,
  spotifyAlbumReadError,
  spotifyJson,
} from '@/lib/spotify-api'
import { AlbumImportCandidateSchema } from '@/lib/album-import-candidates'
import { spotifyClientToken } from '@/plugins/builtin/spotify'
import { searchTmdbMovies, tmdbPosterUrl } from '@/plugins/builtin/tmdb'
import { getScrapePlugin } from '@/plugins/registry'
import { mediaItem, providerSecret } from '@/schemas/db'
import { spotifyAlbumReleaseIds } from './album-library-tracks'
import { commitAlbumImportRecord, matchAlbumCandidates } from './album-imports'
import { observeFilmCandidate } from './film-catalog-observations'
import {
  observeCatalogMedia,
  promoteCatalogMediaInTransaction,
  type CatalogOrigin,
} from './catalog-discoveries'
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
  latestCatalogResponseId,
  observeSpotifySearchResults,
} from './music-catalog-observations'
import {
  lookupSpotifyCatalogTrack,
  normalizeSpotifyCatalogTrack,
  projectSpotifyCatalogAlbums,
  searchSpotifyCatalogAlbums,
  searchSpotifyCatalogTrackPage,
  searchSpotifyCatalogTracks,
  type SpotifySearchObservation,
} from './provider-search-task-replay'
import {
  appendProviderTaskReplayStep,
  type ProviderTaskReplayStep,
} from './provider-task-replay'
import { getProviderTransport } from './provider-transport'
import { recordSpotifyCatalogCodes } from './spotify-catalog-codes'
import { getSpotifyAccountStatus, spotifyAccountToken } from './spotify-oauth'
import { resolveSpotifyTrackIds } from './spotify-playlists'
import { readMediaProviderWithEvidence } from './interactive-media-provider-response'
import { IN_REQUEST_SLOT_WAIT_MS } from '@/lib/request-policy'

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

/** Throws a 422 when the provider is not loaded or lacks its credentials. */
export async function assertProviderConfigured(
  providerId: string,
  action: string,
) {
  await manualProvider(providerId, action)
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
  maxSlotWaitMs?: number,
): Promise<T> {
  const provider = await manualProvider(providerId, action)
  return runProviderOperation(provider, execute, assertActive, maxSlotWaitMs)
}

async function runProviderOperation<T>(
  { plugin, secrets }: Awaited<ReturnType<typeof manualProvider>>,
  execute: (
    context: MediaPluginTestContext,
    plugin: MediaProviderPlugin,
  ) => Promise<T>,
  assertActive?: () => Promise<void>,
  maxSlotWaitMs?: number,
): Promise<T> {
  try {
    await assertActive?.()
    const result = await execute(
      {
        secrets,
        request:
          maxSlotWaitMs === undefined
            ? createProviderRequest(plugin, assertActive)
            : createProviderRequest(plugin, assertActive, { maxSlotWaitMs }),
      },
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
      cause: error,
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

/**
 * Runs a Spotify catalog task's searches with the access track search uses.
 * Each search is a replay step whose responses are stored on the job.
 */
export async function runSpotifyCatalogSearches<T>(
  userId: string | null,
  jobId: string,
  task: typeof SPOTIFY_SIMILAR_LOOKUP_TASK,
  assertActive: () => Promise<void>,
  execute: (search: {
    token: string
    market?: string
    request: (
      step: ProviderTaskReplayStep,
    ) => Promise<MediaPluginTestContext['request']>
  }) => Promise<T>,
): Promise<T> {
  const { provider, params, account } = await spotifyTrackSearchAccess(userId)
  return runProviderOperation(
    provider,
    async ({ secrets, request }, plugin) => {
      const token = account
        ? await spotifyAccountToken(account, request)
        : await spotifyClientToken(secrets, request)
      // One recorder numbers every search's responses in order.
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
      const recorded = createProviderRequest(plugin, assertActive, {
        beginResponseCapture: recorder('task'),
      })
      const result = await execute({
        token,
        ...params,
        request: async (step) => {
          await appendProviderTaskReplayStep(jobId, 'spotify', task, step)
          return recorded
        },
      })
      recorder.assertStored()
      return result
    },
    assertActive,
  )
}

export async function searchSpotifyTrackCandidates(
  query: string,
  userId: string | null,
  assertActive: () => Promise<void>,
  market?: string,
  jobId?: string,
  observe?: (observations: SpotifySearchObservation[]) => void,
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
      return searchSpotifyCatalogTracks(lookup, token, input, observe)
    },
    assertActive,
  )
}

export async function searchSpotifyTrackCandidatesInRequest(
  trackId: string,
  query: string,
  userId: string,
  market?: string,
) {
  const { provider, params, account } = await spotifyTrackSearchAccess(
    userId,
    market,
  )
  try {
    return await runProviderOperation(
      provider,
      async ({ secrets, request }, plugin) => {
        const token = account
          ? await spotifyAccountToken(account, request)
          : await spotifyClientToken(secrets, request)
        const { result, responses } = await readMediaProviderWithEvidence(
          {
            mediaItemId: trackId,
            plugin,
            secrets,
            maxSlotWaitMs: IN_REQUEST_SLOT_WAIT_MS,
            normalizedData: spotifyInteractiveSearchMetadata(userId),
          },
          (lookup) =>
            searchSpotifyCatalogTrackPage(lookup, token, { ...params, query }),
        )
        const evidence = responses.find(
          ({ requestUrl, status }) =>
            requestUrl === 'https://api.spotify.com/v1/search' &&
            status !== null &&
            status >= 200 &&
            status < 300,
        )
        if (!evidence) throw new ProviderResponseStorageError()
        return { ...result, evidence }
      },
      undefined,
      IN_REQUEST_SLOT_WAIT_MS,
    )
  } catch (error) {
    if (
      error instanceof ServerError &&
      error.cause instanceof ProviderRequestError &&
      ['cooldown', 'rate-limit', 'access-denied'].includes(error.cause.code)
    )
      throw new ServerError({ statusCode: 429, message: error.message })
    throw error
  }
}

/**
 * Reads one catalog track by Spotify ID within a track search job, with the
 * access and response storage of a search.
 */
export async function lookupSpotifyTrackCandidates(
  spotifyTrackId: string,
  userId: string | null,
  assertActive: () => Promise<void>,
  market: string | undefined,
  jobId: string,
  observe?: (observations: SpotifySearchObservation[]) => void,
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
      const input = {
        spotifyTrackId,
        ...(params.market ? { market: params.market } : {}),
      }
      const lookup = await catalogJobRequest(
        jobId,
        SPOTIFY_TRACK_SEARCH_TASK,
        { operation: 'track-lookup', args: input },
        plugin,
        secrets,
        assertActive,
      )
      return lookupSpotifyCatalogTrack(lookup, token, input, observe)
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
    result.items.flatMap(({ spotifyTrackId, linkedFromId }) =>
      linkedFromId ? [spotifyTrackId, linkedFromId] : [spotifyTrackId],
    ),
  )
  function matchFor(track: (typeof result.items)[number]) {
    const exact = matches.get(track.spotifyTrackId)
    const linked = track.linkedFromId
      ? matches.get(track.linkedFromId)
      : undefined
    const candidates = [exact, linked]
    return (
      candidates.find((match) => match?.inLibrary && !match.hidden) ??
      candidates.find((match) => match?.hidden) ??
      exact ??
      linked
    )
  }
  const albumRecordings = await resolveSpotifyTrackIds(
    db,
    result.items.filter((track) => {
      const match = matchFor(track)
      return !match?.inLibrary && !match?.hidden
    }),
    { choosingOneCandidate: true, memberTargets: true },
  )
  const key = nanoid()
  const observed = await db.transaction((tx) =>
    observeSpotifySearchResults(tx, result.observations, {
      operation: 'catalog-search',
      key,
      page,
    }),
  )
  return ManualMediaSearchResultSchema.parse({
    items: result.items.map((track) => {
      const match = matchFor(track)
      return {
        externalId: track.spotifyTrackId,
        title: track.title,
        subtitle: [track.artists.join(', '), track.albumName]
          .filter(Boolean)
          .join(' · '),
        releaseDate: track.releaseDate,
        artworkUrl: track.artworkUrl,
        url: track.spotifyUrl,
        mediaItemId: match?.hidden
          ? null
          : match?.inLibrary
            ? match.id
            : (albumRecordings.get(track.spotifyTrackId) ?? null),
        catalogMediaItemId: observed.get(track.spotifyTrackId),
        ...(match?.hidden ? { membershipAmbiguous: true } : {}),
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
  if (match)
    return db.transaction((tx) =>
      promoteCatalogMediaInTransaction(tx, match.id, userId ?? undefined),
    )

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

async function libraryMatches(
  matches: readonly { id: string | null; error: string | null }[],
) {
  const ids = [
    ...new Set(
      matches.flatMap((match) => (match.id && !match.error ? [match.id] : [])),
    ),
  ]
  if (!ids.length) return new Set<string>()
  const rows = await db
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .where(
      and(
        eq(mediaItem.inLibrary, true),
        inArray(mediaItem.id, ids),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  return new Set(rows.map(({ id }) => id))
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
    subjectId,
    userId = null,
  }: {
    assertActive?: () => Promise<void>
    jobId?: string
    subjectId?: string
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
    const key = jobId ?? nanoid()
    // Resolve membership before writing catalog summaries for the same IDs.
    const observed = () =>
      db.transaction(async (tx) => {
        const responseId = jobId
          ? await latestCatalogResponseId(tx, jobId, 'spotify')
          : undefined
        const ids: string[] = []
        for (const [index, item] of page.items.entries()) {
          const origin: CatalogOrigin = {
            provider: 'spotify',
            operation: 'catalog-search',
            occurrenceKey: JSON.stringify([key, options.page, index + 1]),
            jobId,
            subjectKind: subjectId ? 'lastfm-album' : undefined,
            subjectId,
            responseId,
            page: options.page,
            position: index + 1,
          }
          const id = await observeCatalogMedia(
            tx,
            {
              kind: 'album',
              title: item.name,
              provider: 'spotify',
              referenceType: 'spotify',
              externalId: item.id,
              artworkUrl: item.images[0]?.url,
              releaseDate: parseOptionalDate(item.release_date) ?? undefined,
              trackCount: item.total_tracks,
              spotifyUrl: `https://open.spotify.com/album/${item.id}`,
              credits: item.artists.map(({ id, name }) => ({
                externalId: id,
                name,
              })),
            },
            origin,
          )
          ids.push(id)
          await recordSpotifyCatalogCodes(tx, [
            {
              mediaItemId: id,
              kind: 'album',
              value: item.external_ids?.upc,
              origin,
            },
          ])
        }
        return ids
      })
    if (options.exactMembership) {
      const matches = await findCatalogAlbumMembership(
        result.items.map((item) => item.externalId),
      )
      const ids = await observed()
      return ManualMediaSearchResultSchema.parse({
        ...result,
        items: result.items.map((item, index) => {
          const match = matches.get(item.externalId)
          const ambiguous = match?.hidden || match?.id === null
          return {
            ...item,
            mediaItemId: !ambiguous && match?.inLibrary ? match.id : null,
            catalogMediaItemId: ids[index],
            ...(ambiguous ? { membershipAmbiguous: true } : {}),
          }
        }),
      })
    }
    const candidates = page.items.map((item) =>
      AlbumImportCandidateSchema.parse({
        provider: 'spotify',
        source: 'https://open.spotify.com/album/' + item.id,
        result: normalizeSpotifyAlbum(item),
      }),
    )
    const matches = await matchAlbumCandidates(candidates)
    const library = await libraryMatches(matches)
    const ids = await observed()
    return {
      ...result,
      items: result.items.map((item, index) => ({
        ...item,
        mediaItemId: library.has(matches[index]?.id ?? '')
          ? (matches[index]?.id ?? null)
          : null,
        catalogMediaItemId: ids[index],
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
  const library = await libraryMatches(matches)
  const key = nanoid()
  const observed = await db.transaction(async (tx) => {
    const ids: (string | undefined)[] = []
    for (const [index, item] of page.results.entries())
      ids.push(
        await observeFilmCandidate(
          tx,
          {
            title: item.title,
            referenceType: 'tmdb',
            externalId: String(item.id),
            releaseDate: item.release_date,
            artworkUrl: tmdbPosterUrl(item.poster_path),
          },
          {
            provider: 'tmdb',
            operation: 'catalog-search',
            occurrenceKey: JSON.stringify([key, options.page, index + 1]),
            page: options.page,
            position: index + 1,
          },
        ),
      )
    return ids
  })
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
      mediaItemId: library.has(matches[index]?.id ?? '')
        ? (matches[index]?.id ?? null)
        : null,
      catalogMediaItemId: observed[index],
      ...(matches[index]?.error ? { membershipAmbiguous: true } : {}),
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

/** Resolve catalog IDs against stored identities without requesting provider data. */
export async function readCatalogMembership({
  items,
}: CatalogMembershipInput): Promise<CatalogMembershipResult> {
  const trackIds = items
    .filter((item) => item.mediaType === 'track')
    .map((item) => item.externalId)
  const albumIds = items
    .filter((item) => item.mediaType === 'album')
    .map((item) => item.externalId)
  const [tracks, albums] = await Promise.all([
    findManualTrackMatches(trackIds),
    findCatalogAlbumMembership(albumIds),
  ])
  const albumRecordings = await resolveSpotifyTrackIds(
    db,
    items.flatMap((item) =>
      item.mediaType === 'track' &&
      item.recording &&
      !tracks.get(item.externalId)?.inLibrary &&
      !tracks.get(item.externalId)?.hidden
        ? [{ ...item.recording, spotifyTrackId: item.externalId }]
        : [],
    ),
    { choosingOneCandidate: true, memberTargets: true },
  )
  return {
    items: items.map((item) => {
      const match =
        item.mediaType === 'track'
          ? tracks.get(item.externalId)
          : albums.get(item.externalId)
      const ambiguous =
        match !== undefined && (match.hidden || match.id === null)
      const recording =
        item.mediaType === 'track' && item.recording
          ? albumRecordings.get(item.externalId)
          : undefined
      return {
        mediaType: item.mediaType,
        externalId: item.externalId,
        mediaItemId: ambiguous
          ? null
          : match?.inLibrary
            ? match.id
            : (recording ?? null),
        ambiguous,
      }
    }),
  }
}

async function findCatalogAlbumMembership(
  albumIds: string[],
  forAddition = false,
) {
  const matches = new Map<
    string,
    { id: string | null; hidden: boolean; inLibrary: boolean }
  >()
  if (!albumIds.length) return matches
  // A library member takes precedence over observations when reading membership.
  // The write guard checks the full set before promoting an outside record.
  const result = await db.execute(sql`
    select spotify_id,
      case when count(*) = 1 then min(album_id) end as library_id,
      bool_or(hidden) as hidden, bool_or(in_library) as in_library
    from (
      select release.spotify_id, release.album_id, mi.in_library,
        mi.metadata->>'legacyHidden' is not distinct from 'true' as hidden,
        bool_or(mi.in_library) over (partition by release.spotify_id) as has_member
      from (${spotifyAlbumReleaseIds()}) release
      join media_item mi on mi.id = release.album_id
      where release.spotify_id = any(${sql.param(albumIds)}::text[])
    ) release_matches
    ${forAddition ? sql`` : sql`where in_library = has_member`}
    group by spotify_id
  `)
  const rows = z
    .array(
      z.object({
        spotify_id: z.string(),
        library_id: z.string().nullable(),
        hidden: z.boolean(),
        in_library: z.boolean(),
      }),
    )
    .parse(result.rows)
  for (const row of rows)
    matches.set(row.spotify_id, {
      id: row.library_id,
      hidden: row.hidden,
      inLibrary: row.in_library,
    })
  return matches
}

const SPOTIFY_RELEASE_WITHDRAWN =
  'Spotify no longer has this release. Choose another release with Add album in Albums.'

/**
 * Has Spotify's answer that the chosen album does not exist reported as a
 * missing item, which is not a provider failure, in place of a failed request.
 */
function withdrawnReleaseRequest(
  request: MediaPluginTestContext['request'],
  spotifyAlbumId: string,
): MediaPluginTestContext['request'] {
  return (input, init, requestOptions) =>
    request(
      input,
      init,
      new URL(input).pathname === `/v1/albums/${spotifyAlbumId}`
        ? { ...requestOptions, notFoundOn404: true }
        : requestOptions,
    )
}

export async function addManualMedia(
  input: ManualMediaAddInput,
  userId: string | null = null,
): Promise<ManualMediaAddResult> {
  const options = ManualMediaAddInputSchema.parse(input)
  if (options.mediaType === 'track')
    return addManualSpotifyTrack(options.externalId, userId)
  if (options.mediaType === 'album') {
    const match = (
      await findCatalogAlbumMembership([options.externalId], true)
    ).get(options.externalId)
    if (match?.hidden || match?.id === null)
      throw new ServerError({
        statusCode: 409,
        message:
          'Ambiguous album identity. Resolve existing matches before importing.',
      })
    if (match?.id) {
      const { addStoredSpotifyAlbum } =
        await import('./spotify-album-reference')
      return addStoredSpotifyAlbum(
        match.id,
        options.externalId,
        userId ?? undefined,
      )
    }
  }
  const provider = options.mediaType === 'album' ? 'spotify' : 'tmdb'
  const referenceType = options.mediaType === 'album' ? 'album' : 'tmdb'
  const reference = {
    referenceType,
    externalId: options.externalId,
    isPrimary: true,
    metadata: { sourceProvider: provider },
  }
  const [match] =
    options.mediaType === 'film'
      ? await matchFilmCandidates([filmCandidate(options.externalId)])
      : []
  if (match?.error)
    throw new ServerError({ statusCode: 409, message: match.error })
  if (match?.id && match.inLibrary)
    return { mediaItemId: match.id, created: false }

  const result = await providerOperation(
    provider,
    async (context, plugin) => {
      if (!plugin.scrapeMediaItem)
        throw new Error('Provider does not support metadata lookup')
      const result = PluginResultSchema.parse(
        await plugin
          .scrapeMediaItem({
            ...context,
            request:
              options.mediaType === 'album'
                ? withdrawnReleaseRequest(context.request, options.externalId)
                : context.request,
            mediaItemId: 'manual-add',
            mediaType: options.mediaType,
            existingReferences: [reference],
            log: async () => {},
          })
          .catch((error: unknown) => {
            if (
              options.mediaType !== 'album' ||
              !isProviderItemNotFoundError(error)
            )
              throw error
            throw new ServerError({
              statusCode: 422,
              message: SPOTIFY_RELEASE_WITHDRAWN,
            })
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
    },
    undefined,
    'searching or adding items',
    options.mediaType === 'album' ? IN_REQUEST_SLOT_WAIT_MS : undefined,
  ).catch((error: unknown) => {
    throw options.mediaType === 'album' ? spotifyAlbumReadError(error) : error
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
      {
        snapshotSource: 'manual-add',
        exactRelease: true,
        ownerId: userId ?? undefined,
      },
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
    {
      newOnly: true,
      snapshotSource: 'manual-add',
      ownerId: userId ?? undefined,
    },
  )
  return { mediaItemId: outcome.id, created: outcome.action === 'new' }
}
