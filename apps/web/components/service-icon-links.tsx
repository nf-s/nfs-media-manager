'use client'

import React from 'react'
import { Globe2 } from 'lucide-react'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import { providerIconUrl, safeRatingHref } from '../utils/provider-ratings'
import { albumSpotifyDestination } from '../utils/album-links'

function ServiceIcon({ provider }: { provider: string }) {
  const serviceIcons: Record<string, string> = {
    spotify: '/icons/services/spotify.svg',
    lastfm: '/img/lastfm.png',
    musicbrainz: '/img/mb.png',
  }
  const icon = serviceIcons[provider] ?? providerIconUrl(provider)
  if (icon)
    return (
      <img
        src={icon}
        width={16}
        height={16}
        alt=""
        className="object-contain"
      />
    )
  return <Globe2 size={16} aria-hidden="true" />
}

const serviceSites = [
  { provider: 'spotify', label: 'Spotify', domains: ['open.spotify.com'] },
  { provider: 'lastfm', label: 'Last.fm', domains: ['last.fm'] },
  {
    provider: 'musicbrainz',
    label: 'MusicBrainz',
    domains: ['musicbrainz.org'],
  },
  {
    provider: 'rym',
    label: 'RYM',
    domains: ['rateyourmusic.com', 'sonemic.com'],
  },
  { provider: 'metacritic', label: 'Metacritic', domains: ['metacritic.com'] },
  { provider: 'discogs', label: 'Discogs', domains: ['discogs.com'] },
  { provider: 'imdb', label: 'IMDb', domains: ['imdb.com'] },
  { provider: 'tmdb', label: 'TMDb', domains: ['themoviedb.org'] },
  { provider: 'letterboxd', label: 'Letterboxd', domains: ['letterboxd.com'] },
  { provider: 'trakt', label: 'Trakt', domains: ['trakt.tv'] },
  {
    provider: 'rottentomatoes',
    label: 'Rotten Tomatoes',
    domains: ['rottentomatoes.com'],
  },
  {
    provider: 'youtube',
    label: 'YouTube',
    domains: ['youtube.com', 'youtu.be'],
  },
]

export default function ServiceIconLinks({
  links,
  item,
  hideSpotify = false,
}: {
  links?: AlbumListItem['links']
  item?: AlbumListItem | FilmListItem
  hideSpotify?: boolean
}) {
  const spotify =
    item?.mediaType === 'album' ? albumSpotifyDestination(item) : undefined
  const candidates = [
    ...(spotify
      ? [{ provider: 'spotify', label: 'Spotify', url: spotify }]
      : []),
    ...(links ?? item?.links ?? []),
  ]
  const unique = new Map<string, AlbumListItem['links'][number]>()
  for (const link of candidates) {
    const url = safeRatingHref(link.url)
    if (!url) continue
    const host = new URL(url).hostname
    const service = serviceSites.find((site) =>
      site.domains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      ),
    )
    const provider = service?.provider ?? link.provider
    if (hideSpotify && service?.provider === 'spotify') continue
    const label = service?.label ?? link.label
    // One adapter may supply destinations on several independent services.
    const key = service ? `service:${service.provider}` : `host:${host}`
    if (!unique.has(key)) unique.set(key, { ...link, provider, label, url })
  }
  if (!unique.size) return null
  return (
    <span className="service-links" role="group" aria-label="Service links">
      {[...unique].map(([key, link]) => (
        <a
          key={key}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${link.label} (new tab)`}
          aria-label={`Open ${link.label} (opens in a new tab)`}
          className={`inline-flex items-center justify-center min-w-5 min-h-5 focus-visible:outline focus-visible:outline-2 ${link.provider === 'spotify' ? 'spotify-link' : ''}`}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ServiceIcon provider={link.provider} />
        </a>
      ))}
    </span>
  )
}
