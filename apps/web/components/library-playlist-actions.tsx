'use client'

import { useQueryClient } from '@tanstack/react-query'
import type {
  LibraryPlaylistLibrary,
  LibraryPlaylistType,
} from '@repo/schemas/library-playlists'
import { useConfig } from './providers'
import { useReportResult } from './result-line'
import { useDetailInspector } from './detail-inspector-context'
import {
  createdPlaylistText,
  createLibraryPlaylist,
  deletedPlaylistText,
  deleteLibraryPlaylist,
  invalidateLibraryPlaylists,
  removedRepeatsText,
  removedResultText,
  removeLibraryPlaylistEntries,
  renameLibraryPlaylist,
  restoreLibraryPlaylist,
  restoreLibraryPlaylistEntries,
} from '@/utils/library-playlists'

type Playlist = {
  id: string
  name: string
  library: LibraryPlaylistLibrary
  type?: LibraryPlaylistType
}

const quote = (text: string) => `“${text}”`

/**
 * The changes made to a library playlist from its detail, its rows' menus
 * and the Playlists page. Each refreshes what lists playlists and reports on
 * the result line with Undo; a failure is reported there too. Rename and
 * create throw, so the name popover can show a taken name.
 */
export function useLibraryPlaylistActions() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const report = useReportResult()
  const inspector = useDetailInspector()
  const refresh = (id: string) => invalidateLibraryPlaylists(client, id)
  return {
    async rename(playlist: Playlist, name: string) {
      await renameLibraryPlaylist(apiBaseUrl, playlist.id, name)
      await refresh(playlist.id)
    },
    /** New playlist on the Playlists page: an empty playlist in `library`. */
    async create(library: LibraryPlaylistLibrary, name: string) {
      const { playlist } = await createLibraryPlaylist(apiBaseUrl, {
        type: 'playlist',
        library,
        name,
      })
      await refresh(playlist.id)
      report({
        text: createdPlaylistText(playlist.name),
        playlist: { id: playlist.id, library },
        undo: async () => {
          await deleteLibraryPlaylist(apiBaseUrl, playlist.id)
          await refresh(playlist.id)
        },
      })
    },
    /** Deletes, closing its detail if that is open; `onDeleted` follows. */
    async remove(playlist: Playlist, onDeleted?: () => void) {
      try {
        await deleteLibraryPlaylist(apiBaseUrl, playlist.id)
      } catch {
        report({ text: `Could not delete ${quote(playlist.name)}.` })
        return
      }
      const open = inspector?.active
      if (open?.kind === 'library-playlist' && open.id === playlist.id)
        inspector?.close()
      onDeleted?.()
      void refresh(playlist.id)
      report({
        text: deletedPlaylistText(playlist.name),
        undo: async () => {
          await restoreLibraryPlaylist(apiBaseUrl, playlist.id)
          await refresh(playlist.id)
        },
      })
    },
    /** Remove from this playlist, for one entry. */
    async removeEntry(
      playlist: Playlist,
      entry: { id: string; title: string },
    ) {
      const text = removedResultText(entry.title, playlist.name)
      try {
        const { batchId } = await removeLibraryPlaylistEntries(
          apiBaseUrl,
          playlist.id,
          { entryIds: [entry.id] },
        )
        void refresh(playlist.id)
        report({
          text,
          undo: async () => {
            await restoreLibraryPlaylistEntries(
              apiBaseUrl,
              playlist.id,
              batchId,
            )
            await refresh(playlist.id)
          },
        })
      } catch {
        report({ text: `Could not remove ${quote(entry.title)}.` })
      }
    },
    /** Remove repeats: keeps the first entry of each item. */
    async removeRepeats(playlist: Playlist) {
      const { removed, batchId } = await removeLibraryPlaylistEntries(
        apiBaseUrl,
        playlist.id,
        { repeats: true },
      )
      void refresh(playlist.id)
      report({
        text: removedRepeatsText(removed, playlist.name),
        undo: async () => {
          await restoreLibraryPlaylistEntries(apiBaseUrl, playlist.id, batchId)
          await refresh(playlist.id)
        },
      })
    },
  }
}
