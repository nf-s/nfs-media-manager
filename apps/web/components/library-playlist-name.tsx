'use client'

import { useQueries } from '@tanstack/react-query'
import { useConfig } from './providers'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  fetchLibraryPlaylist,
  libraryPlaylistKey,
  playlistNotFound,
} from '@/utils/library-playlists'

/**
 * The names of library playlists by ID, read through the cached playlist
 * read that their details share: null for one that no longer exists,
 * undefined while it is not known.
 */
export function useLibraryPlaylistNames(ids: readonly string[]) {
  const { apiBaseUrl } = useConfig()
  const unique = [...new Set(ids)]
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: libraryPlaylistKey(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchLibraryPlaylist(apiBaseUrl, id, signal),
      ...clientQueryDefaults,
      retry: (count: number, error: unknown) =>
        !playlistNotFound(error) && count < 2,
      // A removed playlist stays removed until a change refreshes it.
      retryOnMount: false,
    })),
  })
  const names = new Map<string, string | null>()
  unique.forEach((id, index) => {
    const result = results[index]
    if (result?.data) names.set(id, result.data.name)
    else if (result?.isError && playlistNotFound(result.error))
      names.set(id, null)
  })
  return (id: string): string | null | undefined => names.get(id)
}
