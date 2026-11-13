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
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  SpotifyAlbumSchema,
  normalizeSpotifyAlbum,
  spotifyJson,
} from '@/lib/spotify-api'
import { AlbumImportCandidateSchema } from '@/lib/album-import-candidates'
import { spotifyClientToken } from '@/plugins/builtin/spotify'
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

const TmdbSearchSchema = z.object({
  page: z.number().int().positive(),
  total_pages: z.number().int().nonnegative(),
  results: z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        title: z.string().min(1),
        original_title: z.string().optional(),
        release_date: z
          .string()
          .regex(/^(?:\d{4}-\d{2}-\d{2})?$/)
          .optional(),
        poster_path: z
          .string()
          .regex(/^\/[A-Za-z0-9._-]+$/)
          .nullable()
          .optional(),
      }),
    )
    .max(20),
})

async function manualProvider(providerId: 'spotify' | 'tmdb') {
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
  if (
    plugin.manifest.secrets.some(
      (field) => field.required && !secrets[field.key]?.trim(),
    )
  ) {
    throw new ServerError({
      statusCode: 422,
      message: `Configure ${plugin.manifest.displayName} credentials in Providers before searching or adding items.`,
    })
  }
  return { plugin, secrets }
}

export async function prepareManualMediaSearch(mediaType: 'album' | 'film') {
  await manualProvider(mediaType === 'album' ? 'spotify' : 'tmdb')
}

async function providerOperation<T>(
  providerId: 'spotify' | 'tmdb',
  execute: (
    context: MediaPluginTestContext,
    plugin: MediaProviderPlugin,
  ) => Promise<T>,
  assertActive?: () => Promise<void>,
): Promise<T> {
  const { plugin, secrets } = await manualProvider(providerId)
  try {
    await assertActive?.()
    const result = await execute(
      { secrets, request: createProviderRequest(plugin, assertActive) },
      plugin,
    )
    await assertActive?.()
    await recordProviderSuccess(providerId)
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
  if (market && !/^[A-Z]{2}$/.test(market)) {
    throw new ServerError({
      statusCode: 422,
      message: 'Spotify market must be a two-letter uppercase country code.',
    })
  }
  return market ? { market } : {}
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
      hasMore:
        options.page < 50 &&
        page.items.length > 0 &&
        page.offset + page.items.length < page.total,
    })
  }
  const page = await providerOperation('tmdb', async ({ secrets, request }) => {
    const url = new URL('https://api.themoviedb.org/3/search/movie')
    url.search = new URLSearchParams({
      api_key: secrets['apiKey'] ?? '',
      query: options.q,
      page: String(options.page),
      include_adult: 'false',
    }).toString()
    const response = await request(url)
    if (!response.ok)
      throw new Error(`TMDb search failed (HTTP ${response.status})`)
    return TmdbSearchSchema.parse(await response.json())
  })
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
      artworkUrl: item.poster_path
        ? `https://image.tmdb.org/t/p/w185${item.poster_path}`
        : null,
      url: `https://www.themoviedb.org/movie/${item.id}`,
      mediaItemId: matches[index]?.error ? null : (matches[index]?.id ?? null),
    })),
    page: options.page,
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
