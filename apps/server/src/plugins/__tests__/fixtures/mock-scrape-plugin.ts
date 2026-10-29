import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

const mockScrapePlugin: MediaProviderPlugin = {
  manifest: {
    id: 'mock-scraper',
    displayName: 'Mock Scraper',
    description: 'Fixture plugin for registry tests',
    mediaTypes: ['album', 'film'],
    rateLimit: {
      maxConcurrent: 1,
      minTimeMs: 250,
    },
    secrets: [
      {
        key: 'token',
        label: 'Token',
        required: true,
      },
    ],
    browseFields: [
      {
        key: 'plugin.mock-scraper.score',
        label: 'Fixture score',
        type: 'number',
        filterable: true,
        rating: {
          provider: 'mock-scraper',
          shortLabel: 'Fixture',
          scale: 100,
          votesKey: 'plugin.mock-scraper.votes',
        },
      },
    ],
  },
  async testConnection() {
    return
  },
  async scrapeMediaItem() {
    return {
      payload: {
        ok: true,
      },
      normalized: {
        references: [],
        links: [],
        tags: [],
        credits: [],
        tracks: [],
        playlists: [],
      },
    }
  },
  async importLegacyRecord() {
    return null
  },
}

export default mockScrapePlugin
