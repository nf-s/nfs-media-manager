import type { QueryClient } from '@tanstack/react-query'
import {
  ManualMediaAddInputSchema,
  ManualMediaAddResultSchema,
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  type ManualMediaSearchInput,
  type ManualMediaSearchItem,
  type ManualMediaSearchResult,
} from '@repo/schemas/manual-add'
import { fetchApiData } from './api'

/** Stored snapshots stay offline; explicit searches may load another page. */
export async function loadManualSearchPage({
  apiBaseUrl,
  mediaType,
  query,
  page,
  stored,
  liveSearch,
  signal,
}: {
  apiBaseUrl: string
  mediaType: ManualMediaSearchInput['mediaType']
  query: string
  page: number
  stored: ManualMediaSearchResult | undefined
  liveSearch: boolean
  signal: AbortSignal
}) {
  if (!liveSearch || (stored && stored.totalCount === undefined))
    return { items: stored?.items ?? [], totalCount: stored?.items.length ?? 0 }
  const result =
    stored?.page === page
      ? stored
      : await fetchApiData(
          apiBaseUrl,
          '/api/v1/manual-add/search',
          ManualMediaSearchResultSchema,
          {
            method: 'POST',
            signal,
            body: JSON.stringify(
              ManualMediaSearchInputSchema.parse({ mediaType, q: query, page }),
            ),
          },
        )
  return {
    items: result.items,
    totalCount: result.totalCount ?? result.items.length,
  }
}

/** Adds a selected provider result, or reuses its existing library item. */
export async function addManualMediaItem(
  apiBaseUrl: string,
  mediaType: ManualMediaSearchInput['mediaType'],
  item: ManualMediaSearchItem,
) {
  if (item.mediaItemId) return item.mediaItemId
  const result = await fetchApiData(
    apiBaseUrl,
    '/api/v1/manual-add/add',
    ManualMediaAddResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        ManualMediaAddInputSchema.parse({
          mediaType,
          externalId: item.externalId,
        }),
      ),
    },
  )
  return result.mediaItemId
}

export function invalidateManualMediaAddition(
  client: QueryClient,
  mediaType: ManualMediaSearchInput['mediaType'],
) {
  if (mediaType === 'track')
    return Promise.all(
      [
        'tracks',
        'track',
        'album',
        'artists',
        'artist',
        'artist-overview',
        'artist-selection',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    )
  return Promise.all([
    client.invalidateQueries({
      queryKey: [mediaType === 'album' ? 'albums' : 'films'],
    }),
    client.invalidateQueries({ queryKey: ['imports'] }),
    client.invalidateQueries({ queryKey: ['lastfm-links'] }),
    client.invalidateQueries({ queryKey: ['album-picker'] }),
    client.invalidateQueries({ queryKey: [`${mediaType}-selection`] }),
    client.invalidateQueries({ queryKey: ['tags'] }),
  ])
}
