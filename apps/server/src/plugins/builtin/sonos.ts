import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

/**
 * Account-level provider: it belongs to neither media library and has no
 * per-item scrape. It reads and controls the account's Sonos rooms through
 * the Sonos cloud Control API.
 */
export const sonosPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'sonos',
    displayName: 'Sonos',
    description: 'Sonos rooms and what they play',
    mediaTypes: [],
    rateLimit: {
      maxConcurrent: 2,
      concurrentRequests: true,
      minTimeMs: 100,
      rateLimitCooldownMs: 60 * 1000,
      // A refused command must not pause the controls that still work.
      errorBackoffMs: 0,
    },
    secrets: [
      {
        key: 'clientId',
        label: 'Integration key',
        required: true,
        envVars: ['SONOS_CLIENT_ID'],
      },
      {
        key: 'clientSecret',
        label: 'Integration secret',
        required: true,
        envVars: ['SONOS_CLIENT_SECRET'],
      },
      {
        key: 'redirectUri',
        label: 'Redirect URI',
        required: true,
        helpText:
          'Exact HTTPS /api/v1/sonos/callback URI registered on the Sonos integration key.',
        envVars: ['SONOS_REDIRECT_URI'],
      },
    ],
  },
}
