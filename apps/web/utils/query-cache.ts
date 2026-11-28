import type { QueryClient } from '@tanstack/react-query'
import { syncDeviceStoreBeforeRefresh } from './device-store/bootstrap'
import { invalidatePlaylists } from './playlist-sync'

export const clientCacheStaleTime = 4 * 60 * 60 * 1000
export const clientCacheGcTime = 24 * 60 * 60 * 1000

export const clientQueryDefaults = {
  staleTime: clientCacheStaleTime,
  // Preserve TanStack Query's server default without starting Node GC timers.
  gcTime: typeof window === 'undefined' ? Infinity : clientCacheGcTime,
}

/**
 * Keep cached results visible; reload mounted reads and expire inactive ones.
 * With the device store on, the copy syncs first so the reloads read current rows.
 */
export function refreshClientQueries(client: QueryClient) {
  const invalidate = () =>
    client.invalidateQueries({ refetchType: 'active' }, { throwOnError: true })
  const sync = syncDeviceStoreBeforeRefresh()
  return sync ? sync.then(invalidate) : invalidate()
}

export function invalidateMediaItem(
  client: QueryClient,
  mediaType: 'album' | 'film',
  id: string,
) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['history', id] }),
    client.invalidateQueries({ queryKey: [`${mediaType}-selection`] }),
    client.invalidateQueries({ queryKey: [`${mediaType}-collections`] }),
    client.invalidateQueries({ queryKey: [`${mediaType}-collection`] }),
    ...(mediaType === 'album'
      ? [
          invalidatePlaylists(client),
          client.invalidateQueries({ queryKey: ['album-picker'] }),
          client.invalidateQueries({ queryKey: ['lastfm-links'] }),
        ]
      : [
          client.invalidateQueries({ queryKey: [mediaType, id] }),
          client.invalidateQueries({ queryKey: ['films'] }),
        ]),
  ])
}
