import { ManualMediaAddInputSchema } from '@repo/schemas/manual-add'
import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'
import { formatItemCount } from '@repo/ui/lib/format'

/** The label and search for a release reported without a library track link. */
export function recordedTrackAlbum(
  item: Pick<TrackListItem, 'album' | 'albumName' | 'artists'>,
) {
  if (item.album) return null
  const name = item.albumName?.trim()
  return name
    ? { name, query: [item.artists[0], name].filter(Boolean).join(' ') }
    : null
}

/** An unlinked release that can be added by Spotify ID or looked up by name. */
export function missingTrackAlbum(
  item: Pick<TrackDetail, 'album' | 'albumName' | 'artists' | 'spotifyAlbumId'>,
):
  | {
      kind: 'id'
      spotifyAlbumId: string
      name: string
      query: string | undefined
      message: string
    }
  | { kind: 'search'; name: string; query: string; message: string }
  | null {
  if (item.album) return null
  const recorded = recordedTrackAlbum(item)
  const message = recorded
    ? `“${recorded.name}” has no linked library album.`
    : 'This track has no linked library album.'
  const exact = ManualMediaAddInputSchema.safeParse({
    mediaType: 'album',
    externalId: item.spotifyAlbumId,
  })
  if (exact.success)
    return {
      kind: 'id',
      spotifyAlbumId: exact.data.externalId,
      name: recorded?.name ?? 'Spotify release',
      query: recorded?.query,
      message,
    }
  return recorded ? { kind: 'search', ...recorded, message } : null
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
