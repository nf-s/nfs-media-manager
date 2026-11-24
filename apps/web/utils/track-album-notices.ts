import { spotifyIdPattern } from '@repo/schemas/playback'
import type { TrackListItem } from '@repo/schemas/tracks'
import { formatItemCount } from '@repo/ui/lib/format'
import { spotifyAlbumUrl, spotifyTrackUri } from './album-links'

/** Prefer the exact release over a library album linked by name. */
export function trackAlbumReference(
  item: Pick<
    TrackListItem,
    'album' | 'albumLinkStrategy' | 'spotifyTrackId' | 'spotifyMatch'
  > & { spotifyAlbumId?: string | null },
) {
  const release = item.spotifyAlbumId
  const externalId = release?.startsWith('https://')
    ? spotifyAlbumUrl(release)?.split('/').at(-1)
    : release?.replace(/^spotify:album:/, '')
  const exactId =
    externalId && spotifyIdPattern.test(externalId) ? externalId : null
  const localAlbum = item.album
  const matched =
    item.spotifyMatch !== 'unmatched' &&
    Boolean(spotifyTrackUri(item.spotifyTrackId))
  const listed =
    item.albumLinkStrategy === 'album-track-list' ||
    item.albumLinkStrategy === 'spotify-track'
  const useLocal =
    item.albumLinkStrategy === 'spotify-album' ||
    (exactId === null && (listed || !matched))
  const album = useLocal ? localAlbum : null
  return {
    exactId,
    album,
    openBySpotify:
      (!album || album.inLibrary === false) && Boolean(exactId || matched),
  }
}

/**
 * The words around the album link when the addition returned a library
 * album and the track is still not on it.
 */
export function describeUnlistedAlbum(albumName: string | null) {
  const after = ' is in the library but does not list this track.'
  return albumName
    ? { before: '“', title: albumName, after: `”${after}` }
    : { before: '', title: 'The album', after }
}

/** The words around the album link in a scrobbled album warning. */
export function describeScrobbledAlbum(scrobbles: number) {
  const plays = formatItemCount(scrobbles, { one: 'play', other: 'plays' })
  return {
    before: `${plays} of this track ${scrobbles === 1 ? 'is' : 'are'} counted on “`,
    after: '”, which does not list it.',
  }
}
