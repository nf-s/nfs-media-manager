import {
  isProviderItemNotFoundError,
  type MediaProviderPlugin,
  type MediaPluginTestContext,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { normalizeMdblistPayload } from '@/lib/mdblist-normalizer'

const MDBLIST_API_URL = 'https://api.mdblist.com'
const MDBLIST_TEST_IMDB_ID = 'tt0133093'

function validateMovieIdentifier(referenceType: string, externalId: string) {
  if (
    (referenceType === 'imdb' && !/^tt\d+$/.test(externalId)) ||
    (referenceType === 'tmdb' && !/^[1-9]\d*$/.test(externalId)) ||
    (referenceType !== 'imdb' && referenceType !== 'tmdb')
  ) {
    throw new Error('Invalid MDBList lookup identifier.')
  }
}

function getMovieReferences(references: PluginReference[]) {
  const imdb = references.find((item) => item.referenceType === 'imdb')
  const tmdb = references.find((item) => item.referenceType === 'tmdb')
  const reference = imdb ?? tmdb

  if (!reference) {
    throw new Error('MDBList scraping requires an IMDb or TMDb reference.')
  }

  for (const item of [imdb, tmdb]) {
    if (item) validateMovieIdentifier(item.referenceType, item.externalId)
  }

  return {
    reference,
    fallback: imdb ? tmdb : undefined,
    expectedIds: { imdb: imdb?.externalId, tmdb: tmdb?.externalId },
  }
}

async function fetchMdblistMovie(
  { secrets, request }: MediaPluginTestContext,
  referenceType: string,
  externalId: string,
  expectedIds: Parameters<typeof normalizeMdblistPayload>[1] = referenceType ===
  'imdb'
    ? { imdb: externalId }
    : { tmdb: externalId },
) {
  const apiKey = secrets['apiKey']
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('MDBList API key is missing.')
  }

  validateMovieIdentifier(referenceType, externalId)

  const url = new URL(
    `${MDBLIST_API_URL}/${referenceType}/movie/${externalId}/`,
  )
  url.searchParams.set('apikey', apiKey)
  url.searchParams.set('append_to_response', 'keyword')

  const response = await request(url, undefined, { notFoundOn404: true })
  if (!response.ok) {
    throw new Error(`MDBList request failed with status ${response.status}.`)
  }

  return normalizeMdblistPayload(await response.json(), expectedIds)
}

export const mdblistPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'mdblist',
    displayName: 'MDBList',
    description: 'Film keywords with upstream provenance',
    mediaTypes: ['film'],
    identifierTypes: ['imdb', 'tmdb'],
    rateLimit: {
      maxConcurrent: 3,
      concurrentRequests: true,
      minTimeMs: 350,
      fixedWindow: { durationMs: 300000, reads: 1000, writes: 300 },
      requestBudget: { period: 'day', limit: 10000 },
      configurableRequestBudget: true,
      respectRateLimitHeaders: true,
      retryAfterIsAuthoritative: true,
      rateLimitCooldownMs: 300000,
    },
    secrets: [
      {
        key: 'apiKey',
        label: 'API Key',
        required: true,
        envVars: ['MDBLIST_API_KEY'],
        helpText:
          'Get an API key from MDBList Preferences. Stored keys override MDBLIST_API_KEY.',
      },
    ],
  },
  async testConnection(context): Promise<void> {
    await fetchMdblistMovie(context, 'imdb', MDBLIST_TEST_IMDB_ID)
  },
  async scrapeMediaItem(context) {
    if (context.mediaType !== 'film') {
      throw new Error('MDBList scraping only supports films.')
    }

    const { reference, fallback, expectedIds } = getMovieReferences(
      context.existingReferences,
    )
    await context.log('info', 'Fetching MDBList film keywords')
    try {
      return await fetchMdblistMovie(
        context,
        reference.referenceType,
        reference.externalId,
      )
    } catch (error) {
      if (!isProviderItemNotFoundError(error) || !fallback) throw error
    }

    return fetchMdblistMovie(
      context,
      fallback.referenceType,
      fallback.externalId,
      expectedIds,
    )
  },
}
