'use client'

import type { ReactNode, Ref, UIEventHandler } from 'react'
import {
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type PlaylistEntry,
  type PlaylistEntrySort,
} from '@repo/schemas/tracks'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatTrackDuration } from '@/utils/track-browse'
import { trackServiceLinks } from '@/utils/track-links'
import type { PlaybackSource } from '@/utils/playback'
import { TrackArtistLinks } from './creator-links'
import { DetailLink } from './detail-link'
import {
  AlbumReferencePlayButton,
  LibraryTrackInlinePlayButtons,
} from './play-controls'
import ServiceIconLinks from './service-icon-links'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  type SecondaryVirtualWindow,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

export type TrackEntryColumn = PlaylistEntrySort | 'externalId'
type EntryKind = PlaylistEntry['kind']
export type IndexedTrackEntry = {
  key: string
  entry: PlaylistEntry
  index: number
}

const entryColumns: (TableColumn & { key: TrackEntryColumn })[] = [
  { key: 'position', label: 'Position' },
  { key: 'title', label: 'Title', required: true },
  { key: 'artists', label: 'Artists' },
  { key: 'album', label: 'Album' },
  { key: 'duration', label: 'Duration' },
  { key: 'added', label: 'Added' },
  { key: 'releaseDate', label: 'Released', defaultVisible: false },
  { key: 'scrobbles', label: 'Scrobbles', defaultVisible: false },
  { key: 'lastListened', label: 'Last listened', defaultVisible: false },
  { key: 'kind', label: 'Type' },
  { key: 'source', label: 'Source', defaultVisible: false },
  { key: 'spotifyMatch', label: 'Spotify match', defaultVisible: false },
  { key: 'externalId', label: 'Spotify ID', defaultVisible: false },
]

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
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleDateString()}</time>
  ) : (
    '-'
  )
}

function TrackEntryCell({
  column,
  entry,
  source,
  playInTitle,
}: {
  column: TrackEntryColumn
  entry: PlaylistEntry
  source?: () => PlaybackSource
  playInTitle: boolean
}) {
  const track = entry.kind === 'track' ? entry.track : null
  const album = entry.kind === 'album' ? entry.album : null
  const albumName = track?.albumName ?? track?.album?.title
  switch (column) {
    case 'position':
      return track ? (
        <LibraryTrackInlinePlayButtons
          track={track}
          position={entry.position}
          source={source}
        />
      ) : (
        entry.position
      )
    case 'title':
      return track ? (
        <div className="secondary-cell-actions">
          {playInTitle && (
            <LibraryTrackInlinePlayButtons track={track} source={source} />
          )}
          <SecondaryCell text={track.title}>
            <DetailLink kind="track" id={track.id} className="table-title">
              {track.title}
            </DetailLink>
          </SecondaryCell>
          <ServiceIconLinks links={trackServiceLinks(track)} />
        </div>
      ) : album ? (
        <div className="secondary-cell-actions">
          <AlbumReferencePlayButton
            id={album.id}
            title={album.title}
            source={source}
          />
          <SecondaryCell text={album.title}>
            <DetailLink kind="album" id={album.id} className="table-title">
              {album.title}
            </DetailLink>
          </SecondaryCell>
          {album.spotifyUrl && (
            <ServiceIconLinks
              links={[
                {
                  provider: 'spotify',
                  label: 'Spotify',
                  url: album.spotifyUrl,
                },
              ]}
            />
          )}
        </div>
      ) : null
    case 'artists': {
      const text = (track?.artists ?? album?.artists ?? []).join(', ')
      return (
        <SecondaryCell text={text}>
          {track?.artists.length ? (
            <TrackArtistLinks track={track} />
          ) : (
            text || '-'
          )}
        </SecondaryCell>
      )
    }
    case 'album':
      return track?.album ? (
        <div className="secondary-cell-actions">
          <AlbumReferencePlayButton
            id={track.album.id}
            title={track.album.title}
          />
          <SecondaryCell text={albumName ?? undefined}>
            <DetailLink kind="album" id={track.album.id}>
              {albumName}
            </DetailLink>
          </SecondaryCell>
        </div>
      ) : (
        <SecondaryCell text={albumName ?? undefined}>
          {albumName ?? '-'}
        </SecondaryCell>
      )
    case 'duration':
      return formatTrackDuration(track?.durationSec ?? null)
    case 'added':
      return <DateCell value={entry.addedAt} />
    case 'releaseDate':
      return <DateCell value={track?.releaseDate ?? album?.releaseDate} />
    case 'scrobbles':
      return track?.scrobbles.toLocaleString() ?? '-'
    case 'lastListened':
      return <DateCell value={track?.lastListenedAt} />
    case 'kind':
      return track ? 'Track' : 'Album'
    case 'source': {
      const text = track?.sources
        .map((source) => trackSourceLabels[source])
        .join(', ')
      return <SecondaryCell text={text}>{text || '-'}</SecondaryCell>
    }
    case 'spotifyMatch':
      return track ? trackSpotifyMatchLabels[track.spotifyMatch] : '-'
    case 'externalId':
      return (
        <SecondaryCell text={track?.spotifyTrackId ?? undefined}>
          {track?.spotifyTrackId ?? '-'}
        </SecondaryCell>
      )
  }
}

export function TrackEntriesTable({
  scope,
  window,
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
  kindFilter,
  scroller,
  onScroll,
}: {
  scope: 'album' | 'playlist'
  window: SecondaryVirtualWindow<IndexedTrackEntry | null> & { total: number }
  sortBy: TrackEntryColumn
  direction: 'asc' | 'desc'
  onSort: (key: TrackEntryColumn) => void
  search: string
  onSearch: (q: string) => void
  count?: string
  pending?: boolean
  empty: ReactNode
  error?: ReactNode
  source?: (row: IndexedTrackEntry) => PlaybackSource
  kindFilter?: { value: EntryKind[]; onChange: (kinds: EntryKind[]) => void }
  scroller?: Ref<HTMLDivElement>
  onScroll?: UIEventHandler<HTMLDivElement>
}) {
  const playlist = scope === 'playlist'
  const labels = playlist
    ? { table: 'Playlist tracks', search: 'Search playlist entries' }
    : { table: 'Album tracks', search: 'Search album tracks' }
  const available = entryColumns.filter(({ key }) =>
    playlist ? key !== 'externalId' : key !== 'kind',
  )
  const columns = useTableColumns(
    playlist ? 'playlist-entries' : 'album-tracks',
    available,
  )
  const visible = available.filter(({ key }) => columns.visible(key))
  const numeric = ['position', 'duration', 'scrobbles']
  return (
    <>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label={labels.search}
            placeholder="Search titles, artists or albums"
            value={search}
            maxLength={200}
            onChange={(event) => onSearch(event.target.value)}
          />
        }
        count={count}
        columns={columns.controls}
      />
      {error && (
        <div role="alert" className="quiet">
          {error}
        </div>
      )}
      <SecondaryTableScroll
        ref={scroller}
        onScroll={onScroll}
        className={playlist ? 'min-h-0 flex-1' : 'max-h-[min(420px,50dvh)]'}
        role="region"
        aria-label={labels.table}
        aria-busy={pending}
        data-inspector-scroll=""
      >
        <table
          className="compact-table"
          aria-label={labels.table}
          aria-rowcount={pending ? undefined : window.total + 1}
        >
          <TableHeader>
            <TableRow>
              {visible.map(({ key, label }) => (
                <SecondaryTableHead
                  key={key}
                  sortKey={key}
                  label={label}
                  sortBy={sortBy}
                  direction={direction}
                  onSort={onSort}
                  className={numeric.includes(key) ? 'numeric' : undefined}
                  filter={
                    key === 'kind' && kindFilter ? (
                      <SecondaryColumnFilter
                        label="Type"
                        options={[
                          { value: 'track', label: 'Tracks' },
                          { value: 'album', label: 'Albums' },
                        ]}
                        {...kindFilter}
                      />
                    ) : undefined
                  }
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!window.total && !pending && !error && (
              <TableState colSpan={columns.count}>{empty}</TableState>
            )}
            <SecondaryVirtualRows
              window={window}
              colSpan={columns.count}
              renderRow={(row, index) =>
                row ? (
                  <TableRow
                    key={row.key}
                    className="group"
                    aria-rowindex={index + 2}
                  >
                    {visible.map(({ key }) => (
                      <TableCell
                        key={key}
                        className={
                          numeric.includes(key) ? 'numeric' : undefined
                        }
                      >
                        <TrackEntryCell
                          column={key}
                          entry={row.entry}
                          source={source ? () => source(row) : undefined}
                          playInTitle={!columns.visible('position')}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ) : (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columns.count}
                      style={{ height: window.rowHeight, padding: 0 }}
                    />
                  </tr>
                )
              }
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </>
  )
}
