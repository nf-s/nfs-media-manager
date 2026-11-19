import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import type { MixStation } from '@repo/schemas/subscriptions'

/**
 * Radio stations whose archives fill the Mixes library. Each is a provider of
 * its own with no media types, no credentials and no per-item scrape: its sync
 * runs as a task job through the provider's request gate. The stations publish
 * no API for this, so every request reads what the station's own website
 * reads, one at a time and no faster than one a second.
 */
const stationRateLimit = {
  maxConcurrent: 1,
  minTimeMs: 1000,
  rateLimitCooldownMs: 60 * 60 * 1000,
}

export const rinsePlugin: MediaProviderPlugin = {
  manifest: {
    id: 'rinse',
    displayName: 'Rinse FM',
    description: 'Shows and archived episodes from Rinse FM and its channels',
    siteUrl: 'https://www.rinse.fm',
    mediaTypes: [],
    rateLimit: stationRateLimit,
    secrets: [],
  },
}

export const ntsPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'nts',
    displayName: 'NTS',
    description: 'Shows and archived episodes from NTS Radio',
    siteUrl: 'https://www.nts.live',
    mediaTypes: [],
    rateLimit: stationRateLimit,
    secrets: [],
  },
}

export const lotRadioPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'lotradio',
    displayName: 'The Lot Radio',
    description: 'Shows and archived sessions from The Lot Radio',
    siteUrl: 'https://www.thelotradio.com',
    mediaTypes: [],
    rateLimit: stationRateLimit,
    secrets: [],
  },
}

export const mixStationPlugins: Record<MixStation, MediaProviderPlugin> = {
  rinse: rinsePlugin,
  nts: ntsPlugin,
  lotradio: lotRadioPlugin,
}
