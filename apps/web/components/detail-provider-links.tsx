'use client'

import type { BrowseField, BrowseValues } from '@repo/schemas/browse'
import type { AlbumListItem } from '@repo/schemas/media'
import { getDetailProviderLinks } from '../utils/provider-ratings'
import { albumSpotifyDestination } from '../utils/album-links'
import ServiceIconLinks from './service-icon-links'
import ProviderRatings from './provider-ratings'

export default function DetailProviderLinks({
  fields,
  values,
  links,
  spotifyUrl,
  references,
  hideSpotify = false,
}: {
  fields: BrowseField[]
  values: BrowseValues
  links: AlbumListItem['links']
  spotifyUrl?: string | null
  references?: AlbumListItem['providerReferences']
  hideSpotify?: boolean
}) {
  const content = getDetailProviderLinks(
    fields,
    values,
    links,
    albumSpotifyDestination({
      spotifyUrl: spotifyUrl ?? null,
      links,
      providerReferences: references ?? [],
    }),
    references,
  )
  if (!content.ratings.length && !content.links.length && !content.trailerUrl)
    return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ProviderRatings
        ratings={content.ratings}
        context="detail"
        trailerUrl={content.trailerUrl}
      />
      <ServiceIconLinks links={content.links} hideSpotify={hideSpotify} />
    </div>
  )
}
