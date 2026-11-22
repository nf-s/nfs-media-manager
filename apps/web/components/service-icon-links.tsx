'use client'

import React from 'react'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import { safeRatingHref } from '../utils/provider-ratings'
import { providerLogoUrl } from '../utils/provider-logos'
import { albumSpotifyDestination } from '../utils/album-links'

function ServiceAnchor({
  link,
  compact = false,
  itemTitle,
}: {
  link: AlbumListItem['links'][number]
  compact?: boolean
  itemTitle?: string
}) {
  const label = itemTitle
    ? `Open on ${link.label}: ${itemTitle}`
    : `Open ${link.label}`
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} (new tab)`}
      aria-label={`${label} (opens in a new tab)`}
      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      }}
    >
      <ProviderMark
        name={link.label}
        src={providerLogoUrl(link.provider)}
        size={compact ? 'sm' : undefined}
        hidden
      />
    </a>
  )
}

export function AlbumSpotifyLink({
  item,
}: {
  item: Pick<AlbumListItem, 'spotifyUrl' | 'links' | 'providerReferences'>
}) {
  const url = albumSpotifyDestination(item)
  return url ? (
    <ServiceAnchor
      link={{ provider: 'spotify', label: 'Spotify', url }}
      compact
    />
  ) : null
}

const serviceSites = [
  { provider: 'spotify', label: 'Spotify', domains: ['open.spotify.com'] },
  { provider: 'tidal', label: 'TIDAL', domains: ['tidal.com'] },
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

/**
 * One link per service, in order, with the service's own name: an adapter
 * may supply destinations on several services, and a service may appear
 * under several providers.
 */
export function serviceLinks(
  candidates: readonly AlbumListItem['links'][number][],
  { hideSpotify = false }: { hideSpotify?: boolean } = {},
) {
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
    const key = service ? `service:${service.provider}` : `host:${host}`
    if (!unique.has(key)) unique.set(key, { ...link, provider, label, url })
  }
  return [...unique.values()]
}

export default function ServiceIconLinks({
  links,
  item,
  hideSpotify = false,
  itemTitle,
}: {
  links?: AlbumListItem['links']
  item?: AlbumListItem | FilmListItem
  hideSpotify?: boolean
  itemTitle?: string
}) {
  const spotify =
    item?.mediaType === 'album' ? albumSpotifyDestination(item) : undefined
  const unique = serviceLinks(
    [
      ...(spotify
        ? [{ provider: 'spotify', label: 'Spotify', url: spotify }]
        : []),
      ...(links ?? item?.links ?? []),
    ],
    { hideSpotify },
  )
  if (!unique.length) return null
  return (
    <span className="service-links" role="group" aria-label="Service links">
      {unique.map((link) => (
        <ServiceAnchor key={link.url} link={link} itemTitle={itemTitle} />
      ))}
    </span>
  )
}
