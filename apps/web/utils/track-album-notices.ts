import type { TrackDetail } from '@repo/schemas/tracks'
import { formatItemCount } from '@repo/ui/lib/format'

/** A release that can be added by Spotify ID or looked up from the recorded name. */
export function missingTrackAlbum(
  item: Pick<TrackDetail, 'album' | 'albumName' | 'artists' | 'spotifyAlbumId'>,
):
  | { kind: 'id'; spotifyAlbumId: string; message: string }
  | { kind: 'search'; query: string; message: string }
  | null {
  if (item.album) return null
  const albumName = item.albumName?.trim()
  if (item.spotifyAlbumId)
    return {
      kind: 'id',
      spotifyAlbumId: item.spotifyAlbumId,
      message: albumName
        ? `“${albumName}” is not in the library.`
        : 'The album is not in the library.',
    }
  if (!albumName) return null
  return {
    kind: 'search',
    query: [item.artists[0], albumName].filter(Boolean).join(' '),
    message: `“${albumName}” has no linked library album.`,
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
