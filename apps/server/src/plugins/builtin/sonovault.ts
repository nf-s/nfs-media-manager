import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import {
  SONOVAULT_DEFAULT_CREDIT_RESERVE,
  SONOVAULT_DEFAULT_MONTHLY_CREDITS,
  SONOVAULT_DEFAULT_REQUESTS_PER_MINUTE,
} from '@repo/schemas/sonovault'
import {
  SONOVAULT_MIN_SPACING_MS,
  sonovaultSettings,
  testSonovaultKey,
} from '@/lib/sonovault-api'

/**
 * Sonovault maps a track's ISRC or service ID to its IDs on other services.
 * Track lookups run as the `sonovault-track-lookup` task job and album
 * lookups, through one of the album's tracks, as `sonovault-album-lookup`.
 */
export const sonovaultPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'sonovault',
    displayName: 'Sonovault',
    description:
      'Track and album identifiers on other services, by Spotify ID or ISRC; paid lookups, one credit a track and two or three an album',
    siteUrl: 'https://sonovault.now',
    mediaTypes: ['album'],
    requireExplicitSelection: true,
    maxItemsPerJob: 1,
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: SONOVAULT_MIN_SPACING_MS,
      requestTimeoutMs: 60000,
      respectRateLimitHeaders: true,
      retryAfterIsAuthoritative: true,
      ietfRateLimitHeaders: true,
      rateLimitCooldownMs: 60000,
    },
    secrets: [
      {
        key: 'apiKey',
        label: 'API key',
        required: true,
        envVars: ['SONOVAULT_API_KEY'],
      },
      {
        key: 'requestsPerMinute',
        label: 'Requests per minute',
        required: false,
        helpText: `The plan's request limit. Default ${SONOVAULT_DEFAULT_REQUESTS_PER_MINUTE}; requests are never closer than 1.1 seconds.`,
      },
      {
        key: 'monthlyCredits',
        label: 'Monthly credits',
        required: false,
        helpText: `The plan's credits a month, one per track looked up. Default ${SONOVAULT_DEFAULT_MONTHLY_CREDITS}.`,
      },
      {
        key: 'creditReserve',
        label: 'Credit reserve',
        required: false,
        helpText: `A lookup run stops before the credits left fall below this. Default ${SONOVAULT_DEFAULT_CREDIT_RESERVE}.`,
      },
    ],
  },
  async testConnection({ secrets, request }) {
    await testSonovaultKey(request, sonovaultSettings(secrets).apiKey)
  },
  // The hosted dispatcher runs a provider's task jobs only when it has an
  // item scraper. Album lookups are task jobs, so album metadata selection
  // does not offer this provider and this is never called.
  async scrapeMediaItem() {
    throw new Error(
      'Sonovault album lookups run as sonovault-album-lookup jobs',
    )
  },
}
