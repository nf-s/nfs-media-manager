'use client'

import { useMemo } from 'react'
import type { AlbumDetail } from '@repo/schemas/media'
import type { PlaylistEntry } from '@repo/schemas/tracks'
import { sortTableRows } from '@/utils/secondary-table'
import { parseBrowseView } from '@/utils/media-grid'
import { useVirtualRows } from '@/hooks/useVirtualTable'
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
import { useNestedMediaView } from './nested-media-view'

export default function AlbumTracksTable({ album }: { album: AlbumDetail }) {
  const detail = useDetailView()
  const [savedPresentation, setPresentation] =
    useNestedMediaView('album-tracks')
  const presentation = parseBrowseView(
    detail.params.get('view'),
    savedPresentation,
  )
  const view = albumTrackView(detail.params.get('albumTrackView'), album.id)
  const text = view.q.trim().toLocaleLowerCase()
  type TrackEntry = Extract<PlaylistEntry, { kind: 'track' }>
  const entries = useMemo(
    () =>
      album.tracks.map<TrackEntry>(({ position, track }) => ({
        kind: 'track',
        position,
        track,
        addedAt: track.dateAdded,
      })),
    [album.tracks],
  )
  const ordered = useMemo(
    () =>
      sortTableRows<TrackEntry, TrackEntryColumn>(
        text
          ? entries.filter((entry) => trackEntryMatches(entry, text))
          : entries,
        { key: view.sortBy, direction: view.direction },
        trackEntryValue,
      ),
    [entries, text, view.sortBy, view.direction],
  )
  const rows = useMemo(
    () =>
      ordered.map((entry, index) => ({
        entry,
        index,
        key: trackEntryKey(entry),
      })),
    [ordered],
  )
  const window = useVirtualRows({
    rows,
    identity: JSON.stringify(view),
    presentation: { view: presentation, mediaType: 'album' },
  })

  function viewParams(
    next: Partial<typeof view>,
    nextPresentation = presentation,
  ) {
    const params = new URLSearchParams(detail.params)
    params.set('albumTrackView', JSON.stringify({ ...view, ...next }))
    params.set('tab', 'tracks')
    params.set('view', nextPresentation)
    return params
  }
  return (
    <TrackEntriesTable
      scope="album"
      window={window}
      view={presentation}
      onViewChange={(next) => {
        setPresentation(next)
        detail.replace(viewParams({}, next))
      }}
      fallbackArtworkUrl={album.artworkUrl}
      search={view.q}
      onSearch={(q) => detail.replace(viewParams({ q }))}
      sortBy={view.sortBy}
      direction={view.direction}
      onSort={(sortBy, direction) =>
        detail.replace(viewParams({ sortBy, direction }))
      }
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
