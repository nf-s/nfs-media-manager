'use client'

import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ListMusic } from 'lucide-react'
import type {
  LibraryPlaylistLibrary,
  LibraryPlaylistSummary,
} from '@repo/schemas/library-playlists'
import { Thumb } from '@repo/ui/components/ds/artwork'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Button } from '@repo/ui/components/ui/button'
import type { DetailMenuItem } from './action-menu'
import { DetailLink } from './detail-link'
import { LibraryPlaylistPicker } from './library-playlist-picker'
import { useConfig } from './providers'
import { ReadButton } from './read-button'
import {
  fetchLibraryPlaylistMemberships,
  itemSubject,
  libraryItemCount,
  libraryPlaylistMembershipsKey,
} from '@/utils/library-playlists'

type Item = { id: string; title: string }

/**
 * PL-25: Add to playlist for one item's details: the header button (the
 * playlist icon, then a chevron) and **Add to playlist…** for its More menu,
 * each opening the picker on the button that chose it.
 */
export function useItemAddToPlaylist(
  library: LibraryPlaylistLibrary,
  item: Item,
) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [fromMenu, setFromMenu] = useState(false)
  const subject = itemSubject(library, item)
  const menuItem: DetailMenuItem = {
    label: 'Add to playlist…',
    icon: <ListMusic className="ds-i" data-size="sm" aria-hidden />,
    onSelect: (anchor) => {
      menuAnchor.current = anchor
      setFromMenu(true)
    },
  }
  const action = (
    <>
      <Button
        ref={button}
        size="md"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
      >
        <ListMusic className="ds-i" data-size="sm" aria-hidden />
        Add to playlist
        <ChevronDown className="ds-i" data-size="sm" aria-hidden />
      </Button>
      <LibraryPlaylistPicker
        id={id}
        subject={subject}
        anchor={button}
        onOpenChange={setOpen}
      />
      {fromMenu && (
        <LibraryPlaylistPicker
          subject={subject}
          anchor={menuAnchor}
          sheet
          showOnMount
          onOpenChange={(next) => {
            if (!next) setFromMenu(false)
          }}
        />
      )}
    </>
  )
  return { action, menuItem }
}

/** PL-16: the library playlists that hold an item. */
export function useLibraryPlaylistMemberships(
  library: LibraryPlaylistLibrary,
  itemId: string,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: libraryPlaylistMembershipsKey(library, itemId),
    queryFn: ({ signal }) =>
      fetchLibraryPlaylistMemberships(apiBaseUrl, library, itemId, signal),
  })
}

/** "Library · 18 tracks" under a playlist that holds an item. */
export function membershipLine(playlist: LibraryPlaylistSummary) {
  return `Library · ${libraryItemCount(playlist.library, playlist.entryCount ?? 0)}`
}

/** One row per playlist: its name, which opens it, and "Library · 18 tracks". */
export function LibraryPlaylistMembershipRows({
  playlists,
}: {
  playlists: readonly LibraryPlaylistSummary[]
}) {
  return playlists.map((playlist) => (
    <ListRow
      key={playlist.id}
      thumb={
        <Thumb size={40}>
          <ListMusic className="ds-i" aria-hidden="true" />
        </Thumb>
      }
      title={
        <RowTitle>
          <DetailLink kind="library-playlist" id={playlist.id}>
            {playlist.name}
          </DetailLink>
        </RowTitle>
      }
      by={membershipLine(playlist)}
    />
  ))
}

/** A failed read of the playlists that hold an item, with Retry. */
export function MembershipsError({ retry }: { retry: () => Promise<unknown> }) {
  return (
    <Notice
      tone="danger"
      action={
        <ReadButton size="xs" read={retry}>
          Retry
        </ReadButton>
      }
    >
      Could not load playlists.
    </Notice>
  )
}

/**
 * The Playlists section of details that list no imported playlists: the
 * library playlists that hold the item, or "In no playlist".
 */
export function ItemPlaylistsSection({
  library,
  itemId,
}: {
  library: LibraryPlaylistLibrary
  itemId: string
}) {
  const memberships = useLibraryPlaylistMemberships(library, itemId)
  const playlists = memberships.data ?? []
  return (
    <Section title="Playlists">
      {memberships.isPending && <Skeleton />}
      {memberships.isError && (
        <MembershipsError retry={() => memberships.refetch()} />
      )}
      {memberships.isSuccess &&
        (playlists.length ? (
          <List compact>
            <LibraryPlaylistMembershipRows playlists={playlists} />
          </List>
        ) : (
          <State size="sm" title="In no playlist" />
        ))}
    </Section>
  )
}
