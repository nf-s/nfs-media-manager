'use client'

import type { AlbumDetail } from '@repo/schemas/media'
import type { PlaylistEntry } from '@repo/schemas/tracks'
import { sortTableRows } from '@/utils/secondary-table'
import {
  albumTrackView,
  createAlbumPlaybackSource,
} from '@/utils/playback-source'
import { useDetailView } from './detail-inspector-context'
import {
  TrackEntriesTable,
  trackEntryKey,
  trackEntryMatches,
  trackEntryValue,
  type TrackEntryColumn,
} from './track-entries-table'

export default function AlbumTracksTable({ album }: { album: AlbumDetail }) {
  const detail = useDetailView()
  const view = albumTrackView(detail.params.get('albumTrackView'), album.id)
  const text = view.q.trim().toLocaleLowerCase()
  type TrackEntry = Extract<PlaylistEntry, { kind: 'track' }>
  const entries = album.tracks.map<TrackEntry>(({ position, track }) => ({
    kind: 'track',
    position,
    track,
    addedAt: track.dateAdded,
  }))
  const ordered = sortTableRows<TrackEntry, TrackEntryColumn>(
    text ? entries.filter((entry) => trackEntryMatches(entry, text)) : entries,
    { key: view.sortBy, direction: view.direction },
    trackEntryValue,
  )
  const rows = ordered.map((entry, index) => ({
    entry,
    index,
    key: trackEntryKey(entry),
  }))

  function viewParams(next: Partial<typeof view>) {
    const params = new URLSearchParams(detail.params)
    params.set('albumTrackView', JSON.stringify({ ...view, ...next }))
    params.set('tab', 'tracks')
    return params
  }
  function onSort(sortBy: TrackEntryColumn) {
    detail.replace(
      viewParams({
        sortBy,
        direction:
          sortBy === view.sortBy && view.direction === 'asc' ? 'desc' : 'asc',
      }),
    )
  }

  return (
    <TrackEntriesTable
      scope="album"
      rows={rows}
      search={view.q}
      onSearch={(q) => detail.replace(viewParams({ q }))}
      sortBy={view.sortBy}
      direction={view.direction}
      onSort={onSort}
      count={
        text
          ? `${rows.length.toLocaleString()} of ${entries.length.toLocaleString()} tracks`
          : `${rows.length.toLocaleString()} tracks`
      }
      empty={text ? 'No matching tracks.' : 'No imported tracks.'}
      source={({ index }) =>
        createAlbumPlaybackSource(
          album,
          detail.href(viewParams({})),
          ordered.slice(index),
        )
      }
    />
  )
}
