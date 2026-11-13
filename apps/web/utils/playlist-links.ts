import type { BrowseFilter } from '@repo/schemas/browse'

function playlistFilterParams(name: string) {
  const filters: BrowseFilter[] = [
    { field: 'playlist', value: name, mode: 'required' },
  ]
  return new URLSearchParams({ filters: JSON.stringify(filters) })
}

/** The Tracks view filtered to one playlist. */
export function playlistTracksHref(name: string) {
  return `/tracks?${playlistFilterParams(name)}`
}

/** The Albums view filtered to albums with a track in one playlist. */
export function playlistAlbumsHref(name: string) {
  return `/albums?${playlistFilterParams(name)}`
}

export function trackHref(id: string) {
  return `/tracks/${encodeURIComponent(id)}`
}
