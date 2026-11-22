import { providerIconUrl } from './provider-ratings'

/**
 * The local logo file of each provider and service, used as a one-colour
 * shape by `ProviderMark`. See `public/icons/logos/README.md`.
 */
const logos: Readonly<Record<string, string>> = {
  spotify: '/icons/services/spotify.svg',
  tidal: '/icons/logos/tidal.svg',
  lastfm: '/icons/logos/lastfm.png',
  musicbrainz: '/img/mb.png',
  discogs: '/icons/ratings/discogs.png',
  rym: '/icons/logos/rym.png',
  // Serply reads Rate Your Music.
  serply: '/icons/logos/rym.png',
  imdb: '/icons/ratings/imdb.svg',
  tmdb: '/icons/ratings/tmdb.svg',
  rottentomatoes: '/icons/ratings/rottentomatoes.svg',
  metacritic: '/icons/ratings/metacritic.svg',
  trakt: '/icons/ratings/trakt.svg',
  letterboxd: '/icons/logos/letterboxd.svg',
  youtube: '/icons/logos/youtube.svg',
}

/**
 * A provider's logo, or the icon a plugin supplies with its fields. Undefined
 * for a provider with neither, which `ProviderMark` shows as a globe.
 */
export function providerLogoUrl(provider: string, iconUrl?: string) {
  return logos[provider] ?? providerIconUrl(provider, iconUrl)
}
