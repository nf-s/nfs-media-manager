'use client'

import { useMemo, useState } from 'react'
import type { AlbumDetail } from '@repo/schemas/media'
import type { PlaylistEntry } from '@repo/schemas/tracks'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
  TableState,
} from '@repo/ui/components/ui/table'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatTrackLength } from '@repo/ui/lib/format'
import { sortTableRows } from '@/utils/secondary-table'
import {
  albumTrackView,
  createAlbumPlaybackSource,
} from '@/utils/playback-source'
import type { PlaybackSource } from '@/utils/playback'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { TrackArtistLinks } from './creator-links'
import { TrackRowPlay, useTrackPlayback } from './detail-play'
import { trackEntryValue, type TrackEntryColumn } from './track-entries-table'

type TrackEntry = Extract<PlaylistEntry, { kind: 'track' }>
type Column = {
  key: TrackEntryColumn
  label: string
  end?: boolean
}

/** Tracks beyond this are behind Show all. */
export const ALBUM_TRACK_LIMIT = 20

/**
 * An album's track list counts as a compilation when its tracks credit
 * different artists, or an artist the album does not credit.
 */
export function albumIsCompilation(album: AlbumDetail) {
  const credited = new Set(
    album.credits
      .filter((credit) => credit.role === 'artist')
      .map((credit) => credit.name),
  )
  const lists = new Set(
    album.tracks.map(({ track }) => track.artists.join('\u0000')),
  )
  return (
    lists.size > 1 ||
    (credited.size > 0 &&
      album.tracks.some(({ track }) =>
        track.artists.some((name) => !credited.has(name)),
      ))
  )
}

function AlbumTrackRow({
  entry,
  columns,
  source,
}: {
  entry: TrackEntry
  columns: readonly Column[]
  source: () => PlaybackSource
}) {
  const { track } = entry
  const playback = useTrackPlayback(track)
  return (
    <TableRow data-state={playback.playing ? 'playing' : undefined}>
      {columns.map((column) => (
        <TableCell
          key={column.key}
          align={column.end ? 'end' : undefined}
          className={column.key === 'position' ? 'ds-muted' : undefined}
        >
          {column.key === 'position' ? (
            entry.position
          ) : column.key === 'title' ? (
            <span className="ds-cell-id">
              <DetailLink className="ds-cell-title" kind="track" id={track.id}>
                {track.title}
              </DetailLink>
              <TrackRowPlay track={track} source={source} />
            </span>
          ) : column.key === 'artists' ? (
            <TrackArtistLinks track={track} />
          ) : column.key === 'duration' ? (
            formatTrackLength(
              track.durationSec === null ? null : track.durationSec * 1000,
            )
          ) : (
            formatCount(track.scrobbles)
          )}
        </TableCell>
      ))}
    </TableRow>
  )
}

/**
 * An album's tracks in its Overview: number, title with the play pair,
 * duration and scrobbles, plus Artists on a compilation. Sorting stays in the
 * detail URL so a playback source returns to the same order.
 */
export default function AlbumTracksTable({ album }: { album: AlbumDetail }) {
  const detail = useDetailView()
  const [expanded, setExpanded] = useState(false)
  const view = albumTrackView(detail.params.get('albumTrackView'), album.id)
  const artists: Column = { key: 'artists', label: 'Artists' }
  const columns: Column[] = [
    { key: 'position', label: '#', end: true },
    { key: 'title', label: 'Title' },
    ...(albumIsCompilation(album) ? [artists] : []),
    { key: 'duration', label: 'Duration', end: true },
    { key: 'scrobbles', label: 'Scrobbles', end: true },
  ]
  const ordered = useMemo(
    () =>
      sortTableRows<TrackEntry, TrackEntryColumn>(
        album.tracks.map(({ position, track }) => ({
          kind: 'track',
          position,
          track,
          addedAt: track.dateAdded,
        })),
        { key: view.sortBy, direction: view.direction },
        trackEntryValue,
      ),
    [album.tracks, view.sortBy, view.direction],
  )
  const shown = expanded ? ordered : ordered.slice(0, ALBUM_TRACK_LIMIT)

  function viewParams(next: Partial<typeof view>) {
    const params = new URLSearchParams(detail.params)
    params.set('albumTrackView', JSON.stringify({ ...view, q: '', ...next }))
    return params
  }
  function sort(key: TrackEntryColumn) {
    detail.replace(
      viewParams({
        sortBy: key,
        direction:
          view.sortBy === key && view.direction === 'asc' ? 'desc' : 'asc',
      }),
    )
  }
  return (
    <>
      <Table aria-label="Album tracks">
        <TableHeader>
          <TableRow>
            {columns.map((column) => {
              const active = view.sortBy === column.key
              return (
                <TableHead
                  key={column.key}
                  align={column.end ? 'end' : undefined}
                  aria-sort={
                    active
                      ? view.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <TableSortButton
                    direction={active ? view.direction : undefined}
                    aria-label={
                      column.key === 'position' ? 'Track number' : undefined
                    }
                    onClick={() => sort(column.key)}
                  >
                    {column.label}
                  </TableSortButton>
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.length === 0 && (
            <TableState colSpan={columns.length}>
              No imported tracks.
            </TableState>
          )}
          {shown.map((entry) => (
            <AlbumTrackRow
              key={`${entry.position}:${entry.track.id}`}
              entry={entry}
              columns={columns}
              source={() =>
                createAlbumPlaybackSource(
                  album,
                  detail.href(viewParams({})),
                  ordered.slice(ordered.indexOf(entry)),
                )
              }
            />
          ))}
        </TableBody>
      </Table>
      {ordered.length > ALBUM_TRACK_LIMIT && (
        <div>
          <Button
            variant="link"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded
              ? 'Show fewer'
              : `Show all ${formatCount(ordered.length)}`}
          </Button>
        </div>
      )}
    </>
  )
}
