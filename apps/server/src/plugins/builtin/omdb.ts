import {
  JsonValueSchema,
  type MediaProviderPlugin,
  type PluginReference,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  isJsonRecord,
  normalizeOmdbPayload,
  readJsonString,
  type JsonRecord,
} from '@/lib/provider-normalizers'

const OMDB_API_URL = 'https://www.omdbapi.com/'
const OMDB_TEST_IMDB_ID = 'tt0133093'

function getImdbReference(references: PluginReference[]): string | null {
  const reference = references.find((item) => item.referenceType === 'imdb')
  return reference?.externalId ?? null
}

async function fetchOmdbPayload(
  apiKey: string,
  imdbId: string,
  request: MediaPluginTestContext['request'],
): Promise<JsonRecord> {
  if (!/^tt\d+$/.test(imdbId)) throw new Error('Invalid IMDb identifier')
  const url = new URL(OMDB_API_URL)
  url.searchParams.set('apikey', apiKey)
  url.searchParams.set('i', imdbId)

  const response = await request(url)

  if (!response.ok) {
    throw new Error(`OMDb request failed with status ${response.status}.`)
  }

  const parsedPayload = JsonValueSchema.parse(await response.json())

  if (!isJsonRecord(parsedPayload)) {
    throw new Error('OMDb returned a non-object payload.')
  }

  const apiResponse = readJsonString(parsedPayload, 'Response')

  if (apiResponse === 'False') {
    throw new Error('OMDb returned no result.')
  }

  return parsedPayload
}

export const omdbPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'omdb',
    displayName: 'OMDb',
    description: 'Film metadata and ratings',
    mediaTypes: ['film'],
    identifierTypes: ['imdb'],
    rateLimit: {
      maxConcurrent: 5,
      minTimeMs: 200,
    },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
  },
  async testConnection({ secrets, request }): Promise<void> {
    const apiKey = secrets['apiKey']

    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('OMDb API key is missing.')
    }

    await fetchOmdbPayload(apiKey, OMDB_TEST_IMDB_ID, request)
  },
  async scrapeMediaItem(context) {
    if (context.mediaType !== 'film') {
      throw new Error('OMDb scraping only supports films.')
    }

    const apiKey = context.secrets['apiKey']

    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('OMDb API key is missing.')
    }

    const imdbId = getImdbReference(context.existingReferences)

    if (!imdbId) {
      throw new Error('OMDb scraping requires an IMDb reference.')
    }

    await context.log('info', `Fetching OMDb payload for ${imdbId}`)

    const payload = await fetchOmdbPayload(apiKey, imdbId, context.request)
    return normalizeOmdbPayload(payload)
  },
}
