'use client'

import type { BrowseField, BrowseValues } from '@repo/schemas/browse'
import type { AlbumListItem } from '@repo/schemas/media'
import {
  getDetailProviderLinks,
  isCompactRating,
} from '../utils/provider-ratings'
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
  context = 'detail',
  highlightKey,
}: {
  fields: BrowseField[]
  values: BrowseValues
  links: AlbumListItem['links']
  spotifyUrl?: string | null
  references?: AlbumListItem['providerReferences']
  hideSpotify?: boolean
  context?: 'detail' | 'poster' | 'table'
  highlightKey?: string
}) {
  const content = getDetailProviderLinks(
    context === 'detail'
      ? fields
      : fields.filter(
          (field) => field.rating && isCompactRating({ display: field.rating }),
        ),
    values,
    links,
    albumSpotifyDestination({
      spotifyUrl: spotifyUrl ?? null,
      links,
      providerReferences: references ?? [],
    }),
    references,
  )
  const serviceLinks = hideSpotify
    ? content.links.filter(({ url }) => {
        const host = new URL(url).hostname
        return (
          host !== 'open.spotify.com' && !host.endsWith('.open.spotify.com')
        )
      })
    : content.links
  return (
    <ProviderRatings
      ratings={content.ratings}
      context={context}
      trailerUrl={content.trailerUrl}
      highlightKey={highlightKey}
    >
      {serviceLinks.length > 0 && <ServiceIconLinks links={serviceLinks} />}
    </ProviderRatings>
  )
}
