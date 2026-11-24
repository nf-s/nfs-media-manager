'use client'

import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AlbumDetail } from '@repo/schemas/media'
import type { PlaylistEntry } from '@repo/schemas/tracks'
import type { AlbumUnlistedName } from '@repo/schemas/track-versions'
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
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatTrackLength } from '@repo/ui/lib/format'
import { tableHeaderHeight, tableRowHeight } from '@/hooks/useVirtualTable'
import { observeDetailListSpace } from '@/utils/detail-list-space'
import { sortTableRows } from '@/utils/secondary-table'
import {
  albumTrackView,
  createAlbumPlaybackSource,
} from '@/utils/playback-source'
import type { PlaybackSource } from '@/utils/playback'
import {
  albumUnlistedNamesKey,
  loadAlbumUnlistedNames,
} from '@/utils/track-versions'
import { useDetailView } from './detail-inspector-context'
import { useTableWidths } from './secondary-table'
import { DetailLink } from './detail-link'
import { TrackArtistLinks } from './creator-links'
import { TrackRowPlay, useTrackPlayback } from './detail-play'
import {
  RowSelectAll,
  RowSelectRow,
  rowSelectionWidth,
  useRowSelection,
  type RowSelection,
} from './merge-bar'
import { useConfig } from './providers'
import { trackEntryValue, type TrackEntryColumn } from './track-entries-table'
import { TrackSpotifyMatchAction } from './track-spotify-match-action'
import { TrackMergeBar } from './track-merge-bar'

type TrackEntry = Extract<PlaylistEntry, { kind: 'track' }>
type Column = {
  key: TrackEntryColumn
  label: string
  width: number
  end?: boolean
  fill?: boolean
}

/** A long album shows at least this many tracks before Show all. */
export const ALBUM_TRACK_LIMIT = 20

export function albumTrackPreviewLimit(height: number) {
  const rows = Math.floor((height - tableHeaderHeight) / tableRowHeight)
  return Math.max(ALBUM_TRACK_LIMIT, rows)
}

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
  selection,
}: {
  entry: TrackEntry
  columns: readonly Column[]
  source: () => PlaybackSource
  selection: RowSelection
}) {
  const { track } = entry
  const playback = useTrackPlayback(track)
  return (
    <TableRow
      data-state={playback.playing ? 'playing' : undefined}
      selected={selection.has(track.id)}
    >
      <TableCell>
        <RowSelectRow selection={selection} id={track.id} title={track.title} />
      </TableCell>
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
              <TrackSpotifyMatchAction track={track} />
              {track.inLibrary === false && (
                <span className="ds-muted">Outside library</span>
              )}
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
 * A name scrobbled under the album whose track is not on its track list.
 * Selecting it selects the track that owns it.
 */
function UnlistedNameRow({
  name,
  columns,
  selection,
}: {
  name: AlbumUnlistedName
  columns: readonly Column[]
  selection: RowSelection
}) {
  const title = `${name.trackName} by ${name.artistName}`
  return (
    <TableRow selected={selection.has(name.trackId)}>
      <TableCell>
        <RowSelectRow selection={selection} id={name.trackId} title={title} />
      </TableCell>
      {columns.map((column) => (
        <TableCell key={column.key} align={column.end ? 'end' : undefined}>
          {column.key === 'title' ? (
            <span className="ds-cell-id">
              <DetailLink
                className="ds-cell-title"
                kind="track"
                id={name.trackId}
                title={title}
              >
                {name.trackName}
              </DetailLink>
            </span>
          ) : column.key === 'artists' ? (
            name.artistName
          ) : column.key === 'scrobbles' ? (
            formatCount(name.scrobbles)
          ) : column.key === 'duration' ? (
            <EmptyValue />
          ) : null}
        </TableCell>
      ))}
    </TableRow>
  )
}

/**
 * An album's tracks in its Overview: number, title with the play pair,
 * duration and scrobbles, plus Artists on a compilation. Sorting stays in the
 * detail URL so a playback source returns to the same order. Once the whole
 * list shows, the names scrobbled under the album that are not on its track
 * list follow under a group row. Rows are selected to merge them.
 */
export default function AlbumTracksTable({ album }: { album: AlbumDetail }) {
  const { apiBaseUrl } = useConfig()
  const detail = useDetailView()
  const [expanded, setExpanded] = useState(false)
  const view = albumTrackView(detail.params.get('albumTrackView'), album.id)
  const artists: Column = { key: 'artists', label: 'Artists', width: 140 }
  const columns: Column[] = [
    { key: 'position', label: '#', width: 56, end: true },
    { key: 'title', label: 'Title', width: 200, fill: true },
    ...(albumIsCompilation(album) ? [artists] : []),
    { key: 'duration', label: 'Duration', width: 90, end: true },
    { key: 'scrobbles', label: 'Scrobbles', width: 90, end: true },
  ]
  const widths = useTableWidths('album-overview-tracks', columns)
  const layout = widths.layout([
    rowSelectionWidth,
    ...columns.map((column) => column.key),
  ])
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
  const [previewLimit, setPreviewLimit] = useState(ALBUM_TRACK_LIMIT)
  const longAlbum = ordered.length > ALBUM_TRACK_LIMIT
  const measurePreview = useCallback(
    (table: HTMLTableElement | null) => {
      if (!table || !longAlbum) return
      return observeDetailListSpace(table, (height) => {
        setPreviewLimit(albumTrackPreviewLimit(height))
      })
    },
    [longAlbum],
  )
  const shown = expanded ? ordered : ordered.slice(0, previewLimit)
  const unlisted = useQuery({
    queryKey: albumUnlistedNamesKey(album.id),
    queryFn: ({ signal }) =>
      loadAlbumUnlistedNames(apiBaseUrl, album.id, signal),
  })
  const loose =
    shown.length === ordered.length ? (unlisted.data?.names ?? []) : []
  const rowIds = [
    ...new Set([
      ...shown.map((entry) => entry.track.id),
      ...loose.map((name) => name.trackId),
    ]),
  ]
  const selection = useRowSelection(rowIds)
  const colSpan = columns.length + 1

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
      <Table ref={measurePreview} aria-label="Album tracks" {...layout.table}>
        {layout.colgroup}
        <TableHeader>
          <TableRow>
            <TableHead>
              <RowSelectAll
                selection={selection}
                label="Select album tracks"
                disabled={!rowIds.length}
              />
            </TableHead>
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
                  resizer={widths.resizer(column.key)}
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
            <TableState colSpan={colSpan}>No imported tracks.</TableState>
          )}
          {shown.map((entry) => (
            <AlbumTrackRow
              key={`${entry.position}:${entry.track.id}`}
              entry={entry}
              columns={columns}
              selection={selection}
              source={() =>
                createAlbumPlaybackSource(
                  album,
                  detail.href(viewParams({})),
                  ordered.slice(ordered.indexOf(entry)),
                )
              }
            />
          ))}
          {loose.length > 0 && (
            <TableRow group>
              <TableCell colSpan={colSpan}>
                Scrobbled under this album, not on its track list
              </TableCell>
            </TableRow>
          )}
          {loose.map((name) => (
            <UnlistedNameRow
              key={JSON.stringify([name.artistKey, name.trackKey])}
              name={name}
              columns={columns}
              selection={selection}
            />
          ))}
        </TableBody>
      </Table>
      <TrackMergeBar selection={selection} total={rowIds.length} />
      {ordered.length > previewLimit && (
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
