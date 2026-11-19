import type {
  MediaProviderPlugin,
  MediaPluginManifest,
} from '@repo/media-plugin-sdk'
import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import { mdblistPlugin } from '@/plugins/builtin/mdblist'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { discogsPlugin } from '@/plugins/builtin/discogs'
import { serplyPlugin } from '@/plugins/builtin/serply'
import { youtubePlugin } from '@/plugins/builtin/youtube'
import { sonosPlugin } from '@/plugins/builtin/sonos'
import { mixStationPlugins } from '@/plugins/builtin/mix-stations'

export interface ProviderCatalogEntry extends MediaPluginManifest {
  surface: 'provider' | 'import'
  /** Fills the Subscriptions library; listed in its Providers. */
  subscriptions: boolean
  /** Fills the Mixes library; listed in its Providers. */
  mixes: boolean
  supportsScrape: boolean
  supportsArtistEnrichment?: boolean
  supportsLegacyImport: boolean
  pluginPath: string | null
}

const builtinProviders = [
  {
    ...serplyPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    ...mdblistPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    ...spotifyPlugin.manifest,
    surface: 'provider',
    subscriptions: true,
    mixes: false,
    supportsScrape: true,
    supportsArtistEnrichment: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...musicbrainzPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsArtistEnrichment: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...discogsPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsArtistEnrichment: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...lastfmPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsArtistEnrichment: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...youtubePlugin.manifest,
    surface: 'provider',
    subscriptions: true,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    ...sonosPlugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  ...Object.values(mixStationPlugins).map(
    (plugin): ProviderCatalogEntry => ({
      ...plugin.manifest,
      surface: 'provider',
      subscriptions: false,
      mixes: true,
      supportsScrape: false,
      supportsLegacyImport: false,
      pluginPath: null,
    }),
  ),
  {
    id: 'metacritic',
    displayName: 'Metacritic',
    description: 'Verified album match corrections',
    surface: 'import',
    mediaTypes: ['album'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    secrets: [],
    subscriptions: false,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    id: 'google-custom-search',
    displayName: 'Google Custom Search (legacy)',
    description:
      'Retained Google search metadata; legacy import only, scraping retired',
    surface: 'import',
    mediaTypes: ['album'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    secrets: [],
    subscriptions: false,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'tmdb',
    identifierTypes: ['tmdb', 'imdb'],
    displayName: 'TMDb',
    description: 'Film metadata',
    siteUrl: 'https://www.themoviedb.org',
    surface: 'provider',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'omdb',
    identifierTypes: ['imdb'],
    displayName: 'OMDb',
    description: 'Film metadata and ratings',
    siteUrl: 'https://www.omdbapi.com',
    surface: 'provider',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 5, minTimeMs: 200 },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
    subscriptions: false,
    mixes: false,
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'nfo',
    displayName: 'Kodi NFO',
    description: 'Local file metadata import',
    surface: 'import',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    secrets: [],
    subscriptions: false,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'imdb-personal',
    displayName: 'IMDb Personal Exports',
    description: 'Ratings and watchlist CSV imports',
    surface: 'import',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    secrets: [],
    subscriptions: false,
    mixes: false,
    supportsScrape: false,
    supportsLegacyImport: true,
    pluginPath: null,
  },
] satisfies ProviderCatalogEntry[]

export function getBuiltinProviderCatalog(): ProviderCatalogEntry[] {
  return builtinProviders
}

export function createCatalogEntryFromPlugin(
  plugin: MediaProviderPlugin,
  pluginPath: string | null,
): ProviderCatalogEntry {
  return {
    ...plugin.manifest,
    surface: 'provider',
    subscriptions: false,
    mixes: false,
    supportsScrape: typeof plugin.scrapeMediaItem === 'function',
    supportsArtistEnrichment:
      typeof plugin.scrapeArtist === 'function' ||
      (pluginPath === null &&
        ArtistProfileProviderSchema.safeParse(plugin.manifest.id).success),
    supportsLegacyImport: typeof plugin.importLegacyRecord === 'function',
    pluginPath,
  }
}
