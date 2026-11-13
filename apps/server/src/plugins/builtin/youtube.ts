import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

/**
 * Account-level provider: it belongs to neither media library and has no
 * per-item scrape. The subscription sync runs as a task job through its
 * request gate, cooldowns and daily budget.
 */
export const youtubePlugin: MediaProviderPlugin = {
  manifest: {
    id: 'youtube',
    displayName: 'YouTube',
    description: 'Subscribed channels and their videos',
    mediaTypes: [],
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 100,
      // Each list request costs one unit of the default 10,000-unit daily quota.
      requestBudget: { period: 'day', limit: 9000 },
      configurableRequestBudget: true,
      // The quota resets at midnight Pacific time; look again hourly.
      rateLimitCooldownMs: 60 * 60 * 1000,
    },
    secrets: [
      {
        key: 'clientId',
        label: 'OAuth client ID',
        required: true,
        envVars: ['YOUTUBE_CLIENT_ID'],
      },
      {
        key: 'clientSecret',
        label: 'OAuth client secret',
        required: true,
        envVars: ['YOUTUBE_CLIENT_SECRET'],
      },
      {
        key: 'redirectUri',
        label: 'OAuth redirect URI',
        required: true,
        helpText:
          'Exact HTTPS /api/v1/youtube/callback URI registered on the Google OAuth client; HTTP only on localhost.',
        envVars: ['YOUTUBE_REDIRECT_URI'],
      },
    ],
  },
}
