'use client'

import React from 'react'
import { BrowseActions } from '@repo/ui/components/ds/play'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import type { BrowseField } from '@repo/schemas/browse'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import { safeRatingHref } from '../utils/provider-ratings'
import { providerLogoUrl } from '../utils/provider-logos'
import { albumSpotifyDestination } from '../utils/album-links'

function ServiceAnchor({
  link,
  compact = false,
  itemTitle,
  iconUrl,
}: {
  link: AlbumListItem['links'][number]
  compact?: boolean
  itemTitle?: string
  iconUrl?: string
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
        src={providerLogoUrl(link.provider, iconUrl)}
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
  { provider: 'mdblist', label: 'MDBList', domains: ['mdblist.com'] },
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
  {
    hideSpotify = false,
    providers,
  }: { hideSpotify?: boolean; providers?: readonly string[] } = {},
) {
  const selected =
    providers && new Set(providers.map((id) => providerSites[id] ?? id))
  const unique = new Map<string, AlbumListItem['links'][number]>()
  for (const link of candidates) {
    const url = safeRatingHref(link.url)
    if (!url) continue
    const { hostname: host, pathname } = new URL(url)
    if (selected && pathname === '/') continue
    const service = serviceSites.find((site) =>
      site.domains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      ),
    )
    const explicit =
      selected?.has(link.provider) &&
      !serviceSites.some((site) => site.provider === link.provider)
    const provider = explicit
      ? link.provider
      : (service?.provider ?? link.provider)
    if (selected && (!selected.has(provider) || (!service && !explicit)))
      continue
    if (hideSpotify && service?.provider === 'spotify') continue
    const label = explicit ? link.label : (service?.label ?? link.label)
    const key = selected || service ? `service:${provider}` : `host:${host}`
    if (!unique.has(key)) unique.set(key, { ...link, provider, label, url })
  }
  return selected
    ? [...selected].flatMap((id) => unique.get(`service:${id}`) ?? [])
    : [...unique.values()]
}

/** Browse filters name the adapter; the shortcut opens its public destination. */
const providerSites: Readonly<Record<string, string>> = {
  serply: 'rym',
  omdb: 'imdb',
  'imdb-ratings': 'imdb',
  'imdb-watchlist': 'imdb',
  'youtube-trailer': 'youtube',
  mb: 'musicbrainz',
  mc: 'metacritic',
}

export function FilteredProviderLinks({
  providers,
  links,
  itemTitle,
  place,
  fields,
}: {
  providers: readonly string[]
  links: AlbumListItem['links']
  itemTitle: string
  place?: 'tile' | 'row'
  fields?: readonly BrowseField[]
}) {
  if (!providers.length) return null
  const icons = serviceLinks(links, { providers }).map((link) => (
    <ServiceAnchor
      key={link.url}
      link={link}
      compact
      itemTitle={itemTitle}
      iconUrl={
        fields?.find((field) => field.rating?.provider === link.provider)
          ?.rating?.iconUrl
      }
    />
  ))
  if (!icons.length) return null
  return place ? (
    <BrowseActions place={place}>{icons}</BrowseActions>
  ) : (
    <>{icons}</>
  )
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
