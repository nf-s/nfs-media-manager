import type {
  MediaProviderPlugin,
  MediaPluginManifest,
} from '@repo/media-plugin-sdk'
import { mdblistPlugin } from '@/plugins/builtin/mdblist'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { discogsPlugin } from '@/plugins/builtin/discogs'
import { serplyPlugin } from '@/plugins/builtin/serply'

export interface ProviderCatalogEntry extends MediaPluginManifest {
  surface: 'provider' | 'import'
  supportsScrape: boolean
  supportsLegacyImport: boolean
  pluginPath: string | null
}

const builtinProviders = [
  {
    ...serplyPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    ...mdblistPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: false,
    pluginPath: null,
  },
  {
    ...spotifyPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...musicbrainzPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...discogsPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    ...lastfmPlugin.manifest,
    surface: 'provider',
    supportsScrape: true,
    supportsLegacyImport: true,
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
    supportsScrape: false,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'tmdb',
    identifierTypes: ['tmdb', 'imdb'],
    displayName: 'TMDb',
    description: 'Film metadata',
    surface: 'provider',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
    supportsScrape: true,
    supportsLegacyImport: true,
    pluginPath: null,
  },
  {
    id: 'omdb',
    identifierTypes: ['imdb'],
    displayName: 'OMDb',
    description: 'Film metadata and ratings',
    surface: 'provider',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 5, minTimeMs: 200 },
    secrets: [{ key: 'apiKey', label: 'API Key', required: true }],
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
    supportsScrape: typeof plugin.scrapeMediaItem === 'function',
    supportsLegacyImport: typeof plugin.importLegacyRecord === 'function',
    pluginPath,
  }
}
