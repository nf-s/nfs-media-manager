'use client'

import type { ReactNode } from 'react'
import type { EntryGap } from '@repo/schemas/coverage'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type PlaylistEntry,
  type PlaylistEntrySort,
} from '@repo/schemas/tracks'
import { Input } from '@repo/ui/components/ui/input'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { EMPTY_VALUE, formatCount, formatDate } from '@repo/ui/lib/format'
import { formatTrackDuration } from '@/utils/track-browse'
import { playlistAlbumSorts } from '@/utils/playlist-links'
import type { BrowseView } from '@/utils/media-grid'
import { useNestedGridDensity } from '@/hooks/useGridDensity'
import type { PlaybackSource } from '@/utils/playback'
import BrowseToolbar, {
  BrowseColumnFilterSection,
  BrowseColumnsSection,
} from './browse-toolbar'
import { TrackArtistLinks } from './creator-links'
import { DetailLink } from './detail-link'
import { TrackRowPlay, useTrackPlayback } from './detail-play'
import { AlbumReferencePlayButton } from './play-controls'
import { TrackAlbumTableValue } from './track-browse-cells'
import { TrackSpotifyMatchAction } from './track-spotify-match-action'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import {
  NestedMediaCard,
  NestedMediaCards,
  type NestedMediaWindow,
} from './nested-media-view'

export type TrackEntryColumn = PlaylistEntrySort | 'externalId'
type EntryKind = PlaylistEntry['kind']
export type IndexedTrackEntry = {
  key: string
  entry: PlaylistEntry
  index: number
  /** The entry's metadata gaps, while the list shows only entries with gaps. */
  gaps?: readonly EntryGap[]
}

/** The gap column and row selection of a list filtered to entries with gaps. */
export type TrackEntryGaps = {
  /** The column heading: Missing or Stale. */
  label: string
  selected: ReadonlySet<string>
  onSelect: (row: IndexedTrackEntry, selected: boolean) => void
}

function entryTitle(entry: PlaylistEntry) {
  return entry.kind === 'track' ? entry.track.title : entry.album.title
}

function GapPills({ gaps }: { gaps: readonly EntryGap[] }) {
  return (
    <Pills max={2}>
      {gaps.map((gap) => (
        <Pill key={gap.provider} tone="attention">
          {gap.displayName}
        </Pill>
      ))}
    </Pills>
  )
}

const entryColumns: (TableColumn & { key: TrackEntryColumn })[] = [
  { key: 'position', label: 'Position', width: 72 },
  { key: 'title', label: 'Title', width: 240, required: true, fill: true },
  { key: 'artists', label: 'Artists', width: 160 },
  { key: 'album', label: 'Album', width: 160 },
  { key: 'duration', label: 'Duration', width: 90 },
  { key: 'added', label: 'Added', width: 110 },
  {
    key: 'releaseDate',
    label: 'Released',
    width: 110,
    defaultVisible: false,
  },
  { key: 'scrobbles', label: 'Scrobbles', width: 90, defaultVisible: false },
  {
    key: 'lastListened',
    label: 'Last listened',
    width: 110,
    defaultVisible: false,
  },
  { key: 'kind', label: 'Type', width: 90 },
  { key: 'source', label: 'Source', width: 140, defaultVisible: false },
  {
    key: 'spotifyMatch',
    label: 'Spotify match',
    width: 140,
    defaultVisible: false,
  },
  {
    key: 'externalId',
    label: 'Spotify ID',
    width: 200,
    defaultVisible: false,
  },
]

const entryTables = {
  playlist: {
    table: 'Playlist tracks',
    search: 'Search playlist entries',
    key: 'playlist-entries',
    columns: entryColumns.filter(({ key }) => key !== 'externalId'),
  },
  album: {
    table: 'Album tracks',
    search: 'Search album tracks',
    key: 'album-tracks',
    columns: entryColumns.filter(({ key }) => key !== 'kind'),
  },
  'playlist-albums': {
    table: 'Playlist albums',
    search: 'Search playlist albums',
    key: 'playlist-albums',
    columns: entryColumns.filter(
      ({ key }) => key !== 'externalId' && playlistAlbumSorts.includes(key),
    ),
  },
}
/** Width of the row selection column in a list of entries with gaps. */
const selectionWidth = 36
/** Room for two gap pills and the count of the rest. */
const gapsWidth = 220

export function trackEntryKey(entry: PlaylistEntry) {
  return entry.kind === 'track'
    ? `track:${entry.position}:${entry.track.id}`
    : `album:${entry.position}:${entry.album.id}`
}

export function trackEntryValue(entry: PlaylistEntry, key: TrackEntryColumn) {
  const item = entry.kind === 'track' ? entry.track : entry.album
  const track = entry.kind === 'track' ? entry.track : null
  const album = track?.albumName ?? track?.album?.title
  switch (key) {
    case 'position':
      return entry.position
    case 'title':
      return item.title
    case 'artists':
      return item.artists.join(', ')
    case 'album':
      return album
    case 'duration':
      return track?.durationSec
    case 'added':
      return entry.addedAt ? Date.parse(entry.addedAt) : null
    case 'releaseDate':
      return item.releaseDate
    case 'scrobbles':
      return track?.scrobbles
    case 'lastListened':
      return track?.lastListenedAt
    case 'kind':
      return entry.kind
    case 'source':
      return track?.sources
        .map((source) => trackSourceLabels[source])
        .join(', ')
    case 'spotifyMatch':
      return track ? trackSpotifyMatchLabels[track.spotifyMatch] : null
    case 'externalId':
      return track?.spotifyTrackId
  }
}

export function trackEntryMatches(entry: PlaylistEntry, text: string) {
  return [
    trackEntryValue(entry, 'title'),
    trackEntryValue(entry, 'artists'),
    trackEntryValue(entry, 'album'),
  ].some(
    (value) =>
      typeof value === 'string' && value.toLocaleLowerCase().includes(text),
  )
}

function DateCell({ value }: { value?: string | null }) {
  return value ? <time dateTime={value}>{formatDate(value)}</time> : EMPTY_VALUE
}

function TrackEntryCard({
  entry,
  view,
  source,
  fallbackArtworkUrl,
  groupedAlbums,
}: {
  entry: PlaylistEntry
  view: 'grid' | 'list'
  source?: () => PlaybackSource
  fallbackArtworkUrl?: string | null
  groupedAlbums: boolean
}) {
  const item = entry.kind === 'track' ? entry.track : entry.album
  return (
    <NestedMediaCard
      view={view}
      kind={entry.kind}
      id={item.id}
      title={item.title}
      titleAction={
        entry.kind === 'track' && (
          <TrackSpotifyMatchAction track={entry.track} />
        )
      }
      artworkUrl={item.artworkUrl ?? fallbackArtworkUrl ?? null}
      subtitle={
        entry.kind === 'track' ? (
          <TrackArtistLinks track={entry.track} />
        ) : (
          item.artists.join(', ')
        )
      }
      metadata={
        <>
          <span>#{entry.position}</span>
          {entry.kind === 'track' && entry.track.durationSec !== null && (
            <span> · {formatTrackDuration(entry.track.durationSec)}</span>
          )}
          {item.releaseDate && <span> · {item.releaseDate.slice(0, 4)}</span>}
        </>
      }
      actions={
        entry.kind === 'track' ? (
          <TrackRowPlay track={entry.track} source={source} />
        ) : (
          groupedAlbums && (
            <AlbumReferencePlayButton
              id={entry.album.id}
              title={entry.album.title}
            />
          )
        )
      }
    />
  )
}

function TrackEntryCell({
  column,
  entry,
  source,
  groupedAlbums,
}: {
  column: TrackEntryColumn
  entry: PlaylistEntry
  source?: () => PlaybackSource
  groupedAlbums: boolean
}) {
  const track = entry.kind === 'track' ? entry.track : null
  const album = entry.kind === 'album' ? entry.album : null
  const albumName = track?.albumName ?? track?.album?.title
  switch (column) {
    case 'position':
      return entry.position
    case 'title':
      return track ? (
        <span className="ds-cell-id">
          <DetailLink kind="track" id={track.id} className="ds-cell-title">
            {track.title}
          </DetailLink>
          <TrackSpotifyMatchAction track={track} />
          {track.inLibrary === false && (
            <span className="ds-muted">Outside library</span>
          )}
          <TrackRowPlay track={track} source={source} />
        </span>
      ) : album ? (
        <span className="ds-cell-id">
          <DetailLink kind="album" id={album.id} className="ds-cell-title">
            {album.title}
          </DetailLink>
          {groupedAlbums && (
            <AlbumReferencePlayButton id={album.id} title={album.title} />
          )}
        </span>
      ) : null
    case 'artists': {
      const text = (track?.artists ?? album?.artists ?? []).join(', ')
      return (
        <SecondaryCell text={text}>
          {track?.artists.length ? (
            <TrackArtistLinks track={track} />
          ) : (
            text || EMPTY_VALUE
          )}
        </SecondaryCell>
      )
    }
    case 'album':
      return (
        <SecondaryCell text={albumName ?? undefined}>
          {track ? <TrackAlbumTableValue track={track} /> : EMPTY_VALUE}
        </SecondaryCell>
      )
    case 'duration':
      return formatTrackDuration(track?.durationSec ?? null)
    case 'added':
      return <DateCell value={entry.addedAt} />
    case 'releaseDate':
      return <DateCell value={track?.releaseDate ?? album?.releaseDate} />
    case 'scrobbles':
      return track ? formatCount(track.scrobbles) : EMPTY_VALUE
    case 'lastListened':
      return <DateCell value={track?.lastListenedAt} />
    case 'kind':
      return track ? 'Track' : 'Album'
    case 'source': {
      const text = track?.sources
        .map((source) => trackSourceLabels[source])
        .join(', ')
      return <SecondaryCell text={text}>{text || EMPTY_VALUE}</SecondaryCell>
    }
    case 'spotifyMatch':
      return track ? trackSpotifyMatchLabels[track.spotifyMatch] : EMPTY_VALUE
    case 'externalId':
      return (
        <SecondaryCell text={track?.spotifyTrackId ?? undefined}>
          {track?.spotifyTrackId ?? EMPTY_VALUE}
        </SecondaryCell>
      )
  }
}

/** A table row that shows when the player is on its track. */
function EntryRow({
  entry,
  index,
  selected,
  children,
}: {
  entry: PlaylistEntry
  index: number
  selected?: boolean
  children: ReactNode
}) {
  return entry.kind === 'track' ? (
    <TrackEntryRow entry={entry} index={index} selected={selected}>
      {children}
    </TrackEntryRow>
  ) : (
    <TableRow aria-rowindex={index + 2} selected={selected}>
      {children}
    </TableRow>
  )
}

function TrackEntryRow({
  entry,
  index,
  selected,
  children,
}: {
  entry: Extract<PlaylistEntry, { kind: 'track' }>
  index: number
  selected?: boolean
  children: ReactNode
}) {
  const playback = useTrackPlayback(entry.track)
  return (
    <TableRow
      aria-rowindex={index + 2}
      selected={selected}
      data-state={playback.playing ? 'playing' : undefined}
    >
      {children}
    </TableRow>
  )
}

export function TrackEntriesTable({
  scope,
  window,
  view,
  onViewChange,
  sortBy,
  direction,
  onSort,
  search,
  onSearch,
  count,
  pending,
  empty,
  error,
  source,
  fallbackArtworkUrl,
  kindFilter,
  gaps,
}: {
  scope: keyof typeof entryTables
  window: NestedMediaWindow<IndexedTrackEntry> & { padBottom: number }
  view: BrowseView
  /** Absent while the list is fixed to one view; the switch is not shown. */
  onViewChange?: (view: BrowseView) => void
  sortBy: TrackEntryColumn
  direction: 'asc' | 'desc'
  onSort: (key: TrackEntryColumn, direction: 'asc' | 'desc') => void
  search: string
  onSearch: (q: string) => void
  count?: string
  pending?: boolean
  empty: ReactNode
  error?: ReactNode
  source?: (row: IndexedTrackEntry) => PlaybackSource
  fallbackArtworkUrl?: string | null
  kindFilter?: { value: EntryKind[]; onChange: (kinds: EntryKind[]) => void }
  /**
   * Adds row selection and the gap column; the list holds only entries with
   * gaps. The caller fixes the view to the table, the only view with selection.
   */
  gaps?: TrackEntryGaps
}) {
  const groupedAlbums = scope === 'playlist-albums'
  const config = entryTables[scope]
  const available = config.columns
  const columns = useTableColumns(config.key, available)
  const visible = available.filter(({ key }) => columns.visible(key))
  const numeric = ['position', 'duration', 'scrobbles']
  const scrollClassName = 'dtl-entries'
  const typeFilter = kindFilter && {
    label: 'Type',
    options: [
      { value: 'track', label: 'Tracks' },
      { value: 'album', label: 'Albums' },
    ] satisfies { value: EntryKind; label: string }[],
    ...kindFilter,
  }
  const columnOptions = view === 'table' ? columns.options : null
  // The window's geometry reads the same stored density (`useVirtualTable`).
  const [density, setDensity] = useNestedGridDensity('album')
  const colSpan = columns.count + (gaps ? 2 : 0)
  const layout = columns.layout([
    ...(gaps ? [selectionWidth] : []),
    ...visible.map(({ key }) => key),
    ...(gaps ? [gapsWidth] : []),
  ])
  return (
    <>
      <BrowseToolbar
        search={
          <Input
            type="search"
            aria-label={config.search}
            placeholder={
              groupedAlbums
                ? 'Search album titles or artists'
                : 'Search titles, artists or albums'
            }
            value={search}
            maxLength={200}
            onChange={(event) => onSearch(event.target.value)}
          />
        }
        sort={{
          key: sortBy,
          direction,
          options: available,
          onChange: (key) => onSort(key, 'asc'),
          onDirectionChange: (next) => onSort(sortBy, next),
        }}
        view={view}
        onViewChange={onViewChange}
        density={{ value: density, onChange: setDensity }}
        filterCount={kindFilter?.value.length}
        filters={
          (typeFilter || columnOptions) && (
            <>
              <BrowseColumnsSection>{columnOptions}</BrowseColumnsSection>
              {typeFilter && <BrowseColumnFilterSection {...typeFilter} />}
            </>
          )
        }
        count={count}
        compact
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {view !== 'table' ? (
        <NestedMediaCards
          window={window}
          view={view}
          mediaType="album"
          label={config.table}
          className={scrollClassName}
          busy={pending}
          empty={!error ? empty : undefined}
          renderItem={(row) => (
            <TrackEntryCard
              entry={row.entry}
              view={view}
              source={source ? () => source(row) : undefined}
              fallbackArtworkUrl={fallbackArtworkUrl}
              groupedAlbums={groupedAlbums}
            />
          )}
        />
      ) : (
        <SecondaryTableScroll
          ref={window.scroller}
          onScroll={window.onScroll}
          className={scrollClassName}
          role="region"
          aria-label={config.table}
          aria-busy={pending}
          data-inspector-scroll=""
        >
          <table
            className="ds-table"
            aria-label={config.table}
            aria-rowcount={pending ? undefined : window.total + 1}
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                {gaps && (
                  <TableHead>
                    <span className="sr-only">Select</span>
                  </TableHead>
                )}
                {visible.map(({ key, label }) => (
                  <SecondaryTableHead
                    key={key}
                    sortKey={key}
                    label={label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={(key) =>
                      onSort(
                        key,
                        key === sortBy && direction === 'asc' ? 'desc' : 'asc',
                      )
                    }
                    align={numeric.includes(key) ? 'end' : undefined}
                    filter={
                      key === 'kind' &&
                      typeFilter && <SecondaryColumnFilter {...typeFilter} />
                    }
                    resizer={columns.resizer(key)}
                  />
                ))}
                {gaps && <TableHead>{gaps.label}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!window.total && !pending && !error && (
                <TableState colSpan={colSpan}>{empty}</TableState>
              )}
              <SecondaryVirtualRows
                window={window}
                colSpan={colSpan}
                renderRow={(row, index) =>
                  row ? (
                    <EntryRow
                      key={row.key}
                      entry={row.entry}
                      index={index}
                      selected={gaps?.selected.has(row.key)}
                    >
                      {gaps && (
                        <TableCell>
                          <input
                            type="checkbox"
                            className="ds-check"
                            aria-label={`Select ${entryTitle(row.entry)}`}
                            checked={gaps.selected.has(row.key)}
                            onChange={(event) =>
                              gaps.onSelect(row, event.target.checked)
                            }
                          />
                        </TableCell>
                      )}
                      {visible.map(({ key }) => (
                        <TableCell
                          key={key}
                          align={numeric.includes(key) ? 'end' : undefined}
                          className={
                            key === 'position' ? 'ds-muted' : undefined
                          }
                        >
                          <TrackEntryCell
                            column={key}
                            entry={row.entry}
                            groupedAlbums={groupedAlbums}
                            source={source ? () => source(row) : undefined}
                          />
                        </TableCell>
                      ))}
                      {gaps && (
                        <TableCell>
                          <GapPills gaps={row.gaps ?? []} />
                        </TableCell>
                      )}
                    </EntryRow>
                  ) : (
                    <tr aria-hidden="true">
                      <td
                        colSpan={colSpan}
                        style={{ height: window.rowHeight, padding: 0 }}
                      />
                    </tr>
                  )
                }
              />
            </TableBody>
          </table>
        </SecondaryTableScroll>
      )}
    </>
  )
}
