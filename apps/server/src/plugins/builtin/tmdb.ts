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
): Promise<JsonRecord> {
  if (!/^\d+$/.test(movieId)) throw new Error('Invalid TMDb identifier')
  const url = new URL(`${TMDB_API_URL}/movie/${movieId}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('append_to_response', 'credits,keywords')

  return fetchTmdbJson(url, request)
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

    const payload = await fetchTmdbMovieDetails(apiKey, tmdbId, context.request)
    return normalizeTmdbPayload(payload)
  },
}
