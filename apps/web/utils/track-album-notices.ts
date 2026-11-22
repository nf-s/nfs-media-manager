import type { TrackDetail } from '@repo/schemas/tracks'
import { formatItemCount } from '@repo/ui/lib/format'

/** The Spotify album to add, when the track has one and no library album. */
export function missingTrackAlbum(
  item: Pick<TrackDetail, 'album' | 'albumName' | 'spotifyAlbumId'>,
) {
  if (item.album || !item.spotifyAlbumId) return null
  return {
    spotifyAlbumId: item.spotifyAlbumId,
    message: item.albumName
      ? `“${item.albumName}” is not in the library.`
      : 'The album is not in the library.',
  }
}

/** The words around the album link in a scrobbled album warning. */
export function describeScrobbledAlbum(scrobbles: number) {
  const plays = formatItemCount(scrobbles, { one: 'play', other: 'plays' })
  return {
    before: `${plays} of this track ${scrobbles === 1 ? 'is' : 'are'} counted on “`,
    after: '”, which does not list it.',
  }
}
