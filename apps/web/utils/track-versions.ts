import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  AlbumUnlistedNamesSchema,
  TrackPartsSchema,
  type TrackPartVersion,
} from '@repo/schemas/track-versions'
import { formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'

/**
 * Under the track's own key, so a track change refreshes it with the track.
 * A removed track's parts are not fetched again: they are under its key.
 */
export const trackPartsKey = (trackId: string) => ['track', trackId, 'parts']

/** Under the album's own key, so a track or album change refreshes it. */
export const albumUnlistedNamesKey = (albumId: string) => [
  'album',
  albumId,
  'unlisted-names',
]

/** The versions of the track's record and the scrobbled names each owns. */
export function loadTrackParts(
  apiBaseUrl: string,
  trackId: string,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/${encodeURIComponent(trackId)}/parts`,
    TrackPartsSchema,
    { signal },
  )
}

/** Names scrobbled under the album whose track is not on its track list. */
export function loadAlbumUnlistedNames(
  apiBaseUrl: string,
  albumId: string,
  signal?: AbortSignal,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/albums/${encodeURIComponent(albumId)}/unlisted-names`,
    AlbumUnlistedNamesSchema,
    { signal },
  )
}

export type TrackVersionAction = 'shown' | 'separate'

/**
 * `shown` shows the record's row as this version; `separate` gives the
 * version its own row again. Both are recorded changes that can be undone.
 */
export function changeTrackVersion(
  apiBaseUrl: string,
  action: TrackVersionAction,
  trackId: string,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/library-changes/track-versions/${action}`,
    LibraryChangeSchema,
    { method: 'POST', body: JSON.stringify({ trackId }) },
  )
}

/** The album a version is on, or the album name it was given. */
export function trackPartAlbum(version: TrackPartVersion) {
  return version.album?.title ?? version.albumName
}

/** What a record is made of: `2 versions · 3 names`. */
export function describeTrackParts({
  versions,
  names,
}: {
  versions: readonly unknown[]
  names: readonly unknown[]
}) {
  return [
    versions.length
      ? formatItemCount(versions.length, { one: 'version', other: 'versions' })
      : null,
    names.length
      ? formatItemCount(names.length, { one: 'name', other: 'names' })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
