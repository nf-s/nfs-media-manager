'use client'

import Link from 'next/link'
import { useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ListMusic, Pencil, Trash2 } from 'lucide-react'
import type {
  LibraryPlaylistDetail as Playlist,
  LibraryPlaylistEntriesPage,
} from '@repo/schemas/library-playlists'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import type { SubscriptionItem } from '@repo/schemas/subscriptions'
import type { TrackListItem } from '@repo/schemas/tracks'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import {
  fetchLibraryPlaylist,
  fetchLibraryPlaylistEntries,
  filterItemsLabel,
  libraryCreatorLabels,
  libraryItemsTitle,
  libraryPlaylistEntriesKey,
  libraryPlaylistFacts,
  libraryPlaylistFilterHref,
  libraryPlaylistKey,
  libraryPlaylistNouns,
  playableLibrary,
  repeatsNoticeText,
  type PlayableLibrary,
} from '@/utils/library-playlists'
import { createLibraryPlaylistPlaybackSource } from '@/utils/playback-source'
import {
  subscriptionArtworkUrl,
  subscriptionLibraryPages,
} from '@/utils/subscriptions'
import { CreatorDetailState } from './creator-detail-state'
import { DetailArt } from './detail-frame'
import { useDetailInspector } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { DetailMore } from './detail-more'
import { ItemMore } from './item-more'
import { useLibraryPlaylistActions } from './library-playlist-actions'
import { MediaThumb } from './media-artwork'
import { AlbumInlinePlayButton, LibraryTrackPlayButton } from './play-controls'
import { PlaylistNamePopover } from './playlist-name-popover'
import { useConfig } from './providers'
import { ReadButton } from './read-button'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
  type TableColumn,
} from './secondary-table'
import { SourcePlayButton } from './source-play-button'

const ENTRY_PAGE_SIZE = 100

/** One entry with its library's Browse row. */
export type LibraryPlaylistEntryRow = {
  id: string
  position: number
  addedAt: string
} & (
  | { library: 'albums'; item: AlbumListItem }
  | { library: 'tracks'; item: TrackListItem }
  | { library: 'films'; item: FilmListItem }
  | { library: 'subscriptions' | 'mixes'; item: SubscriptionItem }
)

/** The rows of an entries page, each carrying its library. */
export function libraryPlaylistEntryRows(
  page: LibraryPlaylistEntriesPage,
): LibraryPlaylistEntryRow[] {
  switch (page.library) {
    case 'albums':
      return page.items.map((entry) => ({ ...entry, library: page.library }))
    case 'tracks':
      return page.items.map((entry) => ({ ...entry, library: page.library }))
    case 'films':
      return page.items.map((entry) => ({ ...entry, library: page.library }))
    case 'subscriptions':
    case 'mixes': {
      const { library } = page
      return page.items.map((entry) => ({ ...entry, library }))
    }
  }
}

type PlaylistRef = Pick<Playlist, 'id' | 'name' | 'library' | 'entryCount'>

/** Where the player links back to: the playlist's detail. */
function usePlaylistHref(id: string) {
  const inspector = useDetailInspector()
  const target: DetailTarget = { kind: 'library-playlist', id }
  return inspector?.href(target) ?? detailPageHref(target)
}

/**
 * Play and Add to queue for a library playlist in Albums or Tracks: its
 * entries in position order. `compact` is the row pair; otherwise the
 * header's labelled buttons.
 */
export function LibraryPlaylistPlayButton({
  playlist,
  library,
  compact = true,
  more,
}: {
  playlist: Pick<Playlist, 'id' | 'name' | 'entryCount'>
  library: PlayableLibrary
  compact?: boolean
  more?: ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const href = usePlaylistHref(playlist.id)
  const count = playlist.entryCount ?? 0
  return (
    <SourcePlayButton
      title={playlist.name}
      feedbackKey={`library-playlist:${playlist.id}`}
      count={count}
      emptyReason={`No ${libraryPlaylistNouns[library].other}.`}
      compact={compact}
      more={more}
      loadSource={async () =>
        createLibraryPlaylistPlaybackSource({
          apiBaseUrl,
          id: playlist.id,
          library,
          href,
          label: playlist.name,
          total: count,
          startIndex: 0,
        })
      }
    />
  )
}

/**
 * PL-52: a library playlist in the inspector or on its page. `onDeleted`
 * follows Delete playlist, as when its page goes back to Playlists.
 */
export function LibraryPlaylistDetail({
  id,
  onDeleted,
}: {
  id: string
  onDeleted?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const query = useQuery({
    queryKey: libraryPlaylistKey(id),
    queryFn: ({ signal }) => fetchLibraryPlaylist(apiBaseUrl, id, signal),
  })
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={() => query.refetch()}
        subject="playlist"
      />
    )
  return (
    <LibraryPlaylistView
      playlist={query.data}
      stale={query.isRefetchError}
      retry={() => query.refetch()}
      onDeleted={onDeleted}
    />
  )
}

/** The loaded playlist: header, the repeats notice and its entries. */
export function LibraryPlaylistView({
  playlist,
  stale = false,
  retry = async () => undefined,
  onDeleted,
}: {
  playlist: Playlist
  stale?: boolean
  retry?: () => Promise<unknown>
  onDeleted?: () => void
}) {
  const itemsTitle = libraryItemsTitle(playlist.library)
  const browseTitle =
    playlist.library === 'subscriptions'
      ? subscriptionLibraryPages.subscriptions.name
      : itemsTitle
  return (
    <article className="dtl-detail">
      {stale && <CreatorDetailState stale retry={retry} subject="playlist" />}
      <LibraryPlaylistHeader playlist={playlist} onDeleted={onDeleted} />
      {playlist.repeatCount > 0 && (
        // A new count, as after Undo, starts the button afresh.
        <RepeatsNotice key={playlist.updatedAt} playlist={playlist} />
      )}
      <Section
        title={itemsTitle}
        aside={
          playlist.entryCount ? (
            <Button asChild size="xs" variant="link">
              <Link
                href={libraryPlaylistFilterHref(playlist.library, playlist.id)}
                prefetch={false}
              >
                {`Show in ${browseTitle}`}
              </Link>
            </Button>
          ) : undefined
        }
        flush
      >
        {playlist.entryCount ? (
          <LibraryPlaylistEntries playlist={playlist} />
        ) : (
          <State size="sm" title="Empty playlist">
            {`Add ${libraryPlaylistNouns[playlist.library].other} from Browse.`}
          </State>
        )}
      </Section>
    </article>
  )
}

/** PL-53: how many entries repeat an item, with Remove repeats. */
function RepeatsNotice({ playlist }: { playlist: Playlist }) {
  const actions = useLibraryPlaylistActions()
  const repeats = useMutation({
    mutationFn: () => actions.removeRepeats(playlist),
  })
  return (
    <Notice
      action={
        <span className="ds-actions">
          <Button
            size="xs"
            disabled={repeats.isPending}
            feedback={mutationFeedback(repeats, {
              pending: 'Removing…',
              success: 'Removed',
              error: 'Could not remove · retry',
            })}
            onClick={() => repeats.mutate()}
          >
            Remove repeats
          </Button>
        </span>
      }
    >
      {repeatsNoticeText(playlist.library, playlist.repeatCount)}
    </Notice>
  )
}

const icon = {
  rename: <Pencil className="ds-i" data-size="sm" aria-hidden />,
  delete: <Trash2 className="ds-i" data-size="sm" aria-hidden />,
}

function LibraryPlaylistHeader({
  playlist,
  onDeleted,
}: {
  playlist: Playlist
  onDeleted?: () => void
}) {
  const actions = useLibraryPlaylistActions()
  const anchor = useRef<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const library = playableLibrary(playlist.library)
  return (
    <>
      <DetailHeader
        art={
          <DetailArt
            src={null}
            fallback={<ListMusic className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Playlist"
        title={playlist.name}
        facts={libraryPlaylistFacts(playlist)}
        play={
          library && (
            <LibraryPlaylistPlayButton
              playlist={playlist}
              library={library}
              compact={false}
            />
          )
        }
        actions={
          <>
            <Button asChild size="md">
              <Link
                href={libraryPlaylistFilterHref(playlist.library, playlist.id)}
                prefetch={false}
              >
                {filterItemsLabel(playlist.library)}
              </Link>
            </Button>
            <DetailActionsSpacer />
            <DetailMore
              crumb={{ title: playlist.name }}
              items={[
                {
                  label: 'Rename',
                  icon: icon.rename,
                  onSelect: (button) => {
                    anchor.current = button
                    setRenaming(true)
                  },
                },
                {
                  label: 'Delete playlist',
                  icon: icon.delete,
                  onSelect: () => void actions.remove(playlist, onDeleted),
                },
              ]}
            />
          </>
        }
      />
      {renaming && (
        <PlaylistNamePopover
          mode="rename"
          anchor={anchor}
          initialName={playlist.name}
          showOnMount
          sheet
          onSubmit={(name) => actions.rename(playlist, name)}
          onOpenChange={(open) => {
            if (!open) setRenaming(false)
          }}
        />
      )}
    </>
  )
}

const entryColumns: readonly TableColumn[] = [
  { key: 'position', label: 'Position', width: 56 },
  { key: 'title', label: 'Title', width: 260, fill: true },
  { key: 'creator', label: 'Creator', width: 150 },
  { key: 'added', label: 'Added to playlist', width: 110 },
]

/** The entries: position, title with the play group, creator, date added. */
function LibraryPlaylistEntries({ playlist }: { playlist: Playlist }) {
  const { apiBaseUrl } = useConfig()
  const total = playlist.entryCount ?? 0
  const label = libraryItemsTitle(playlist.library)
  const entries = useVirtualTable({
    queryKey: [
      ...libraryPlaylistEntriesKey(playlist.id),
      total,
      playlist.updatedAt,
    ],
    pageSize: ENTRY_PAGE_SIZE,
    fitDetail: true,
    loadPage: async (page, size, signal) => {
      const result = await fetchLibraryPlaylistEntries(
        apiBaseUrl,
        playlist.id,
        page,
        size,
        signal,
      )
      return {
        items: libraryPlaylistEntryRows(result),
        hasMore: result.hasMore,
        totalCount: total,
      }
    },
  })
  const widths = useTableWidths(
    `library-playlist-${playlist.library}`,
    entryColumns,
  )
  const layout = widths.layout(entryColumns.map((column) => column.key))
  return (
    <>
      {entries.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={entries.retry}>
              Retry
            </ReadButton>
          }
        >
          {`Could not load ${libraryPlaylistNouns[playlist.library].other}.`}
        </Notice>
      )}
      <SecondaryTableScroll
        ref={entries.scroller}
        onScroll={entries.onScroll}
        className="dtl-entries"
        role="region"
        aria-label={label}
        data-inspector-scroll=""
        aria-busy={entries.isFetching}
      >
        <table
          className="ds-table"
          aria-label={label}
          aria-rowcount={total + 1}
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              <TableHead align="end" resizer={widths.resizer('position')}>
                <span aria-hidden="true">#</span>
                <span className="sr-only">Position</span>
              </TableHead>
              <TableHead resizer={widths.resizer('title')}>Title</TableHead>
              <TableHead resizer={widths.resizer('creator')}>
                {libraryCreatorLabels[playlist.library]}
              </TableHead>
              <TableHead resizer={widths.resizer('added')}>
                Added to playlist
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.hasTotal && entries.total === 0 && (
              <TableState colSpan={entryColumns.length}>
                {`No ${libraryPlaylistNouns[playlist.library].other}.`}
              </TableState>
            )}
            <SecondaryVirtualRows
              window={entries}
              colSpan={entryColumns.length}
              renderRow={(entry, index) => (
                <TableRow
                  key={entry.id}
                  aria-rowindex={index + 2}
                  style={{ height: entries.rowHeight }}
                >
                  <TableCell align="end" className="ds-muted">
                    {formatCount(entry.position)}
                  </TableCell>
                  <TableCell>
                    <EntryTitle
                      playlist={playlist}
                      entry={entry}
                      index={index}
                    />
                  </TableCell>
                  <TableCell>
                    <SecondaryCell text={entryCreator(entry) || undefined}>
                      {entryCreator(entry) || EMPTY_VALUE}
                    </SecondaryCell>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <time
                      dateTime={entry.addedAt}
                      title={formatDateTime(entry.addedAt)}
                    >
                      {formatDate(entry.addedAt)}
                    </time>
                  </TableCell>
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </>
  )
}

/** The creator column: artists, directors, channel or show. */
export function entryCreator(entry: LibraryPlaylistEntryRow) {
  switch (entry.library) {
    case 'tracks':
      return entry.item.artists.join(', ')
    case 'albums':
    case 'films': {
      const role = entry.library === 'albums' ? 'artist' : 'director'
      return entry.item.credits
        .filter((credit) => credit.role === role)
        .map((credit) => credit.name)
        .join(', ')
    }
    case 'subscriptions':
    case 'mixes':
      return entry.item.sourceTitle
  }
}

/** The entry's artwork and title, which opens the item, then its controls. */
function EntryTitle({
  playlist,
  entry,
  index,
}: {
  playlist: PlaylistRef
  entry: LibraryPlaylistEntryRow
  index: number
}) {
  const { apiBaseUrl } = useConfig()
  const actions = useLibraryPlaylistActions()
  const href = usePlaylistHref(playlist.id)
  const { item } = entry
  const more = (
    <ItemMore
      library={entry.library}
      item={{ id: item.id, title: item.title }}
      playlist={{
        kind: 'library',
        id: playlist.id,
        onRemove: () =>
          void actions.removeEntry(playlist, {
            id: entry.id,
            title: item.title,
          }),
      }}
      place={
        entry.library === 'albums' || entry.library === 'tracks'
          ? undefined
          : 'row'
      }
    />
  )
  const source = (library: PlayableLibrary) => () =>
    createLibraryPlaylistPlaybackSource({
      apiBaseUrl,
      id: playlist.id,
      library,
      href,
      label: playlist.name,
      total: playlist.entryCount ?? 0,
      startIndex: index,
      initialItem: entry.library === library ? entry.item : undefined,
    })
  const title = (kind: 'album' | 'track' | 'film' | 'subscription' | 'mix') => (
    <SecondaryCell text={item.title}>
      <DetailLink kind={kind} id={item.id} className="ds-cell-title">
        {item.title}
      </DetailLink>
    </SecondaryCell>
  )
  switch (entry.library) {
    case 'tracks':
      return (
        <span className="ds-cell-id">
          <MediaThumb kind="track" src={entry.item.artworkUrl} />
          {title('track')}
          <LibraryTrackPlayButton
            track={entry.item}
            source={source('tracks')}
            more={more}
          />
        </span>
      )
    case 'albums':
      return (
        <span className="ds-cell-id">
          <MediaThumb kind="album" src={entry.item.artworkUrl} />
          {title('album')}
          <AlbumInlinePlayButton
            album={entry.item}
            source={source('albums')}
            more={more}
          />
        </span>
      )
    case 'films':
      return (
        <span className="ds-cell-id">
          <MediaThumb kind="film" src={entry.item.artworkUrl} />
          {title('film')}
          {more}
        </span>
      )
    case 'subscriptions':
    case 'mixes':
      return (
        <span className="ds-cell-id">
          <MediaThumb
            kind={entry.library === 'mixes' ? 'album' : 'video'}
            src={subscriptionArtworkUrl(entry.item)}
          />
          {title(entry.library === 'mixes' ? 'mix' : 'subscription')}
          {more}
        </span>
      )
  }
}
