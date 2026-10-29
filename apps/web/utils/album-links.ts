import type { AlbumListItem } from '@repo/schemas/media'
import { safeRatingHref } from './provider-ratings'

export function spotifyAlbumUrl(
  value: string | null | undefined,
): string | undefined {
  const href = safeRatingHref(value ?? undefined)
  if (!href) return undefined
  const url = new URL(href)
  const match = /^\/(?:intl-[a-z]{2}\/)?album\/([A-Za-z0-9]{22})\/?$/.exec(
    url.pathname,
  )
  return url.protocol === 'https:' &&
    url.hostname === 'open.spotify.com' &&
    !url.port &&
    match?.[1]
    ? `https://open.spotify.com/album/${match[1]}`
    : undefined
}

export function albumSpotifyDestination(
  item: Pick<AlbumListItem, 'spotifyUrl' | 'links' | 'providerReferences'>,
): string | undefined {
  for (const value of [
    item.spotifyUrl,
    ...item.links.map((link) => link.url),
  ]) {
    const url = spotifyAlbumUrl(value)
    if (url) return url
  }
  for (const ref of item.providerReferences) {
    if (ref.referenceType !== 'spotify') continue
    const id = ref.externalId.replace(/^spotify:album:/, '')
    if (/^[A-Za-z0-9]{22}$/.test(id))
      return `https://open.spotify.com/album/${id}`
    const url = spotifyAlbumUrl(ref.externalId)
    if (url) return url
  }
  return undefined
}
