import { z } from 'zod'
import {
  JsonValueSchema,
  type MediaProviderPlugin,
  type PluginReference,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  isJsonRecord,
  normalizeTmdbPayload,
  readJsonArray,
  readJsonString,
  type JsonRecord,
} from '@/lib/provider-normalizers'

const TMDB_API_URL = 'https://api.themoviedb.org/3'
const TMDB_TEST_MOVIE_ID = '550'

const TmdbSearchSchema = z.object({
  page: z.number().int().positive(),
  total_pages: z.number().int().nonnegative(),
  total_results: z.number().int().nonnegative().optional(),
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

/** One page of TMDb's film search, as Add film and Find match show it. */
export async function searchTmdbMovies(
  { secrets, request }: MediaPluginTestContext,
  query: string,
  page: number,
) {
  const url = new URL(`${TMDB_API_URL}/search/movie`)
  url.search = new URLSearchParams({
    api_key: secrets['apiKey'] ?? '',
    query,
    page: String(page),
    include_adult: 'false',
  }).toString()
  const response = await request(url)
  if (!response.ok)
    throw new Error(`TMDb search failed (HTTP ${response.status})`)
  return TmdbSearchSchema.parse(await response.json())
}

export function tmdbPosterUrl(path: string | null | undefined) {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : undefined
}

function getTmdbReference(references: PluginReference[]): string | null {
  const reference = references.find((item) => item.referenceType === 'tmdb')
  return reference?.externalId ?? null
}

function getImdbReference(references: PluginReference[]): string | null {
  const reference = references.find((item) => item.referenceType === 'imdb')
  return reference?.externalId ?? null
}

async function fetchTmdbJson(
  url: URL,
  request: MediaPluginTestContext['request'],
): Promise<JsonRecord> {
  const response = await request(url)

  if (!response.ok) {
    throw new Error(`TMDb request failed with status ${response.status}.`)
  }

  const parsedPayload = JsonValueSchema.parse(await response.json())

  if (!isJsonRecord(parsedPayload)) {
    throw new Error('TMDb returned a non-object payload.')
  }

  const keywords = parsedPayload['keywords']
  if (
    parsedPayload['success'] === false ||
    (isJsonRecord(keywords) && keywords['success'] === false)
  ) {
    throw new Error('TMDb returned a service error.')
  }

  return parsedPayload
}

async function fetchTmdbMovieDetails(
  apiKey: string,
  movieId: string,
  request: MediaPluginTestContext['request'],
  imdbId: string | null = null,
): Promise<JsonRecord> {
  if (!/^\d+$/.test(movieId)) throw new Error('Invalid TMDb identifier')
  const url = new URL(`${TMDB_API_URL}/movie/${movieId}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('append_to_response', 'credits,keywords')

  const payload = await fetchTmdbJson(url, request)
  const returnedImdb = readJsonString(payload, 'imdb_id')
  if (
    readJsonString(payload, 'id') !== movieId ||
    (imdbId && returnedImdb && returnedImdb !== imdbId)
  )
    throw new Error('TMDb response does not match the requested film.')
  return payload
}

async function resolveTmdbMovieIdFromImdbId(
  apiKey: string,
  imdbId: string,
  request: MediaPluginTestContext['request'],
): Promise<string> {
  if (!/^tt\d+$/.test(imdbId)) throw new Error('Invalid IMDb identifier')
  const url = new URL(`${TMDB_API_URL}/find/${imdbId}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('external_source', 'imdb_id')

  const payload = await fetchTmdbJson(url, request)
  const results = readJsonArray(payload, 'movie_results')

  for (const item of results) {
    if (!isJsonRecord(item)) {
      continue
    }

    const id = readJsonString(item, 'id')

    if (id) {
      return id
    }

    const numericId = item['id']

    if (typeof numericId === 'number' && Number.isInteger(numericId)) {
      return String(numericId)
    }
  }

  throw new Error(`TMDb did not return a film for IMDb id ${imdbId}.`)
}

export const tmdbPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'tmdb',
    displayName: 'TMDb',
    description: 'Film metadata',
    siteUrl: 'https://www.themoviedb.org',
    mediaTypes: ['film'],
    identifierTypes: ['tmdb', 'imdb'],
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 2000,
    },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
  },
  async testConnection({ secrets, request }): Promise<void> {
    const apiKey = secrets['apiKey']

    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('TMDb API key is missing.')
    }

    await fetchTmdbMovieDetails(apiKey, TMDB_TEST_MOVIE_ID, request)
  },
  async searchMatchCandidates(context) {
    if (context.mediaType !== 'film')
      throw new Error('TMDb scraping only supports films.')
    const page = await searchTmdbMovies(
      context,
      context.query ?? context.media.title,
      1,
    )
    return page.results.map((item) => ({
      referenceType: 'tmdb',
      externalId: String(item.id),
      title: item.title,
      subtitle:
        item.original_title && item.original_title !== item.title
          ? item.original_title
          : undefined,
      releaseDate: item.release_date || undefined,
      artworkUrl: tmdbPosterUrl(item.poster_path),
      url: `https://www.themoviedb.org/movie/${item.id}`,
    }))
  },
  async scrapeMediaItem(context) {
    if (context.mediaType !== 'film') {
      throw new Error('TMDb scraping only supports films.')
    }

    const apiKey = context.secrets['apiKey']

    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('TMDb API key is missing.')
    }

    const knownTmdbId = getTmdbReference(context.existingReferences)
    const imdbId = getImdbReference(context.existingReferences)

    let tmdbId = knownTmdbId

    if (!tmdbId) {
      if (!imdbId) {
        throw new Error('TMDb scraping requires a TMDb or IMDb reference.')
      }

      await context.log('info', `Resolving TMDb id from IMDb ${imdbId}`)
      tmdbId = await resolveTmdbMovieIdFromImdbId(
        apiKey,
        imdbId,
        context.request,
      )
    }

    await context.log('info', `Fetching TMDb payload for ${tmdbId}`)

    const payload = await fetchTmdbMovieDetails(
      apiKey,
      tmdbId,
      context.request,
      imdbId,
    )
    return normalizeTmdbPayload(payload)
  },
}
