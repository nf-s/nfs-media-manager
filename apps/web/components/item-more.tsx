'use client'

import { useRef, useState } from 'react'
import { ListMusic, Maximize2, X } from 'lucide-react'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'
import { RowMoreMenu, type DetailMenuItem } from './action-menu'
import { useDetailInspector } from './detail-inspector-context'
import { LibraryPlaylistPicker } from './library-playlist-picker'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import { itemSubject, libraryDetailKinds } from '@/utils/library-playlists'

/**
 * The playlist a row is listed in. A library playlist's entry can be removed
 * (`onRemove`, which removes it and reports the result); an imported
 * playlist's cannot.
 */
export type ItemMorePlaylist =
  | { kind: 'imported' }
  | { kind: 'library'; id: string; onRemove: () => void }

const icon = {
  add: <ListMusic className="ds-i" data-size="sm" aria-hidden />,
  remove: <X className="ds-i" data-size="sm" aria-hidden />,
  open: <Maximize2 className="ds-i" data-size="sm" aria-hidden />,
}

/**
 * An item's More menu: Add to playlist… and Open details; inside a playlist
 * Add to another playlist… and, for a library playlist, Remove from this
 * playlist. `open` is the Open details action, or its page when there is no
 * inspector.
 */
export function itemMoreMenuItems({
  playlist,
  onAdd,
  open,
}: {
  playlist?: ItemMorePlaylist
  onAdd: (anchor: HTMLElement) => void
  open: ((anchor: HTMLElement) => void) | string
}): DetailMenuItem[] {
  return [
    {
      label: playlist ? 'Add to another playlist…' : 'Add to playlist…',
      icon: icon.add,
      onSelect: onAdd,
    },
    ...(playlist?.kind === 'library'
      ? [
          {
            label: 'Remove from this playlist',
            icon: icon.remove,
            onSelect: playlist.onRemove,
          },
        ]
      : []),
    typeof open === 'string'
      ? { label: 'Open details', icon: icon.open, href: open }
      : { label: 'Open details', icon: icon.open, onSelect: open },
  ]
}

/**
 * More actions for one library item, after Play and Add to queue (or alone
 * with `place`, for an item that cannot be played). Add to playlist…
 * replaces the menu with the picker, opened from the same button, and the
 * group stays shown while it is open.
 */
export function ItemMore({
  library,
  item,
  playlist,
  place,
  variant,
}: {
  library: LibraryPlaylistLibrary
  item: { id: string; title: string }
  playlist?: ItemMorePlaylist
  place?: 'tile' | 'row'
  variant?: 'ghost'
}) {
  const inspector = useDetailInspector()
  const anchor = useRef<HTMLElement | null>(null)
  const [picking, setPicking] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const target: DetailTarget = {
    kind: libraryDetailKinds[library],
    id: item.id,
  }
  const items = itemMoreMenuItems({
    playlist,
    onAdd: (button) => {
      anchor.current = button
      setPicking(true)
    },
    open: inspector
      ? (button) => inspector.open(target, button)
      : detailPageHref(target),
  })
  return (
    <>
      <RowMoreMenu
        title={item.title}
        items={items}
        place={place}
        expanded={pickerOpen}
        variant={variant}
      />
      {picking && (
        <LibraryPlaylistPicker
          subject={itemSubject(library, item)}
          anchor={anchor}
          sheet
          showOnMount
          excludePlaylistId={
            playlist?.kind === 'library' ? playlist.id : undefined
          }
          onOpenChange={(open) => {
            setPickerOpen(open)
            if (!open) setPicking(false)
          }}
        />
      )}
    </>
  )
}

/**
 * More for an item of a library list, as a play control's `more`; an item
 * outside the library has none.
 */
export function libraryItemMore(
  library: LibraryPlaylistLibrary,
  item: { id: string; title: string; inLibrary?: boolean },
  playlist?: ItemMorePlaylist,
) {
  return item.inLibrary === false ? undefined : (
    <ItemMore
      library={library}
      item={{ id: item.id, title: item.title }}
      playlist={playlist}
    />
  )
}
