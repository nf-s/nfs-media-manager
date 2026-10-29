import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { mdblistPlugin } from '@/plugins/builtin/mdblist'
import { omdbPlugin } from '@/plugins/builtin/omdb'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { discogsPlugin } from '@/plugins/builtin/discogs'
import { serplyPlugin } from '@/plugins/builtin/serply'

const builtinScrapePlugins = [
  omdbPlugin,
  tmdbPlugin,
  mdblistPlugin,
  spotifyPlugin,
  musicbrainzPlugin,
  lastfmPlugin,
  discogsPlugin,
  serplyPlugin,
] satisfies MediaProviderPlugin[]

export function getBuiltinScrapePlugin(
  providerId: string,
): MediaProviderPlugin | null {
  return (
    builtinScrapePlugins.find((plugin) => plugin.manifest.id === providerId) ??
    null
  )
}

export function listBuiltinScrapePlugins(): MediaProviderPlugin[] {
  return builtinScrapePlugins
}
