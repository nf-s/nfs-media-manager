import { z } from 'zod'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import { spotifyIdPattern } from '@repo/schemas/playback'
import {
  AlbumRymUrlSchema,
  LastFmUrlSchema,
  isBlockedFilmReference,
} from '@repo/schemas/provider-identification'
import { albumSpotifyDestination } from './album-links'
import { referenceRatingHref, safeRatingHref } from './provider-ratings'

function albumReferenceLink(ref: AlbumListItem['providerReferences'][number]) {
  const { provider, referenceType, externalId } = ref
  if (
    provider === 'discogs' &&
    (referenceType === 'master' || referenceType === 'release') &&
    /^[1-9]\d*$/.test(externalId)
  )
    return `https://www.discogs.com/${referenceType}/${externalId}`
  if (
    provider === 'musicbrainz' &&
    (referenceType === 'release-group' || referenceType === 'release') &&
    z.string().uuid().safeParse(externalId).success
  )
    return `https://musicbrainz.org/${referenceType}/${externalId}`
  if (
    provider === 'tidal' &&
    referenceType === 'album' &&
    /^[1-9]\d*$/.test(externalId)
  )
    return `https://tidal.com/browse/album/${externalId}`
  if (
    provider === 'spotify' &&
    referenceType === 'album' &&
    spotifyIdPattern.test(externalId)
  )
    return `https://open.spotify.com/album/${externalId}`
  if (referenceType === 'rym-url')
    return AlbumRymUrlSchema.safeParse(externalId).data
  if (provider === 'lastfm' && referenceType === 'url')
    return LastFmUrlSchema.safeParse(externalId).data
}

export function mediaBrowseLinkCandidates(
  item:
    | Pick<
        AlbumListItem,
        'mediaType' | 'spotifyUrl' | 'links' | 'providerReferences'
      >
    | Pick<FilmListItem, 'mediaType' | 'links' | 'providerReferences'>,
) {
  const references = [...item.providerReferences].sort(
    (left, right) => Number(right.isPrimary) - Number(left.isPrimary),
  )
  if (item.mediaType === 'album') {
    const spotify = albumSpotifyDestination(item)
    return [
      ...references.flatMap((ref) => {
        const url = albumReferenceLink(ref)
        return url ? [{ provider: ref.provider, label: ref.provider, url }] : []
      }),
      ...(spotify
        ? [{ provider: 'spotify', label: 'Spotify', url: spotify }]
        : []),
      ...item.links.filter((link) => {
        const href = safeRatingHref(link.url)
        return href && new URL(href).hostname !== 'open.spotify.com'
      }),
    ]
  }
  const hasMdblist = references.some((ref) => ref.provider === 'mdblist')
  function filmReferenceLinks(ref: FilmListItem['providerReferences'][number]) {
    const url = referenceRatingHref(ref)
    if (!url) return []
    const links = [
      { provider: ref.referenceType, label: ref.referenceType, url },
    ]
    if (hasMdblist && ref.referenceType === 'imdb')
      links.push({
        provider: 'mdblist',
        label: 'MDBList',
        url: `https://mdblist.com/movie/${ref.externalId}`,
      })
    return links
  }
  const candidates = [
    ...references
      .filter((ref) => !isBlockedFilmReference(ref))
      .flatMap(filmReferenceLinks),
    ...item.links,
  ]
  const blocked = references.filter(isBlockedFilmReference)
  if (!blocked.length) return candidates
  // A rejected identity can also survive as a saved link or another adapter's reference.
  const blockedPages = new Set(
    blocked.flatMap(filmReferenceLinks).map(({ url }) => filmPageIdentity(url)),
  )
  return candidates.filter(
    ({ url }) => !blockedPages.has(filmPageIdentity(url)),
  )
}

function filmPageIdentity(value: string) {
  const href = safeRatingHref(value)
  if (!href) return undefined
  const { hostname, pathname } = new URL(href)
  const match = /^\/(title|movie|movies)\/(tt\d+|\d+)(?:[-/]|$)/.exec(pathname)
  return match
    ? hostname.replace(/^www\./, '') + '/' + match[1] + '/' + match[2]
    : undefined
}
