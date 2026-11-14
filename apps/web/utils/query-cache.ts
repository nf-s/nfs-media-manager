import type { QueryClient } from '@tanstack/react-query'
import { invalidatePlaylists } from './playlist-sync'

export const clientCacheStaleTime = 4 * 60 * 60 * 1000
export const clientCacheGcTime = 24 * 60 * 60 * 1000

export const clientQueryDefaults = {
  staleTime: clientCacheStaleTime,
  // Preserve TanStack Query's server default without starting Node GC timers.
  gcTime: typeof window === 'undefined' ? Infinity : clientCacheGcTime,
}

/** Keep cached results visible; reload mounted reads and expire inactive ones. */
export function refreshClientQueries(client: QueryClient) {
  return client.invalidateQueries({ refetchType: 'active' })
}

export function invalidateMediaItem(
  client: QueryClient,
  mediaType: 'album' | 'film',
  id: string,
) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['history', id] }),
    client.invalidateQueries({ queryKey: [`${mediaType}-selection`] }),
    ...(mediaType === 'album'
      ? [
          invalidatePlaylists(client),
          client.invalidateQueries({ queryKey: ['album-picker'] }),
          client.invalidateQueries({ queryKey: ['lastfm-links'] }),
        ]
      : [
          client.invalidateQueries({ queryKey: [mediaType, id] }),
          client.invalidateQueries({ queryKey: ['films'] }),
          client.invalidateQueries({ queryKey: ['film-collections'] }),
          client.invalidateQueries({ queryKey: ['film-collection'] }),
        ]),
  ])
}
