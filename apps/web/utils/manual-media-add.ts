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
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'

/**
 * Whether an album result has fewer tracks than `tracksPlayed`, the number
 * of different tracks scrobbled from the album being looked for. Such a
 * release cannot be that album: a single beside the EP of the same name.
 */
export function holdsFewerTracks(
  item: ManualMediaSearchItem,
  tracksPlayed: number | undefined,
) {
  return (
    tracksPlayed !== undefined &&
    item.trackCount !== undefined &&
    item.trackCount < tracksPlayed
  )
}

/** The results in the provider's order, those with too few tracks last. */
export function orderSearchItems(
  items: readonly ManualMediaSearchItem[],
  tracksPlayed: number | undefined,
) {
  return [
    ...items.filter((item) => !holdsFewerTracks(item, tracksPlayed)),
    ...items.filter((item) => holdsFewerTracks(item, tracksPlayed)),
  ]
}

/**
 * The line under a result's title: its tracks, who, the year, In library. The
 * tracks come first, so a narrow row cuts off the rest instead.
 */
export function describeSearchItem(
  item: ManualMediaSearchItem,
  { inLibrary, tracksPlayed }: { inLibrary: boolean; tracksPlayed?: number },
) {
  const tracks =
    item.trackCount === undefined
      ? null
      : formatItemCount(item.trackCount, { one: 'track', other: 'tracks' })
  return [
    tracks && tracksPlayed !== undefined && holdsFewerTracks(item, tracksPlayed)
      ? `${tracks}, you played ${formatCount(tracksPlayed)}`
      : tracks,
    item.subtitle,
    item.releaseDate?.slice(0, 4),
    inLibrary
      ? 'In library'
      : item.catalogMediaItemId
        ? 'Outside library'
        : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Stored snapshots stay offline; explicit searches may load another page. */
export async function loadManualSearchPage({
  apiBaseUrl,
  mediaType,
  query,
  page,
  stored,
  liveSearch,
  exactMembership,
  tracksPlayed,
  signal,
}: {
  apiBaseUrl: string
  mediaType: ManualMediaSearchInput['mediaType']
  query: string
  page: number
  stored: ManualMediaSearchResult | undefined
  liveSearch: boolean
  exactMembership?: boolean
  /** See `holdsFewerTracks`; each page is ordered by it. */
  tracksPlayed?: number
  signal: AbortSignal
}) {
  if (!liveSearch || (stored && stored.totalCount === undefined))
    return {
      items: orderSearchItems(stored?.items ?? [], tracksPlayed),
      totalCount: stored?.items.length ?? 0,
    }
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
              ManualMediaSearchInputSchema.parse({
                mediaType,
                q: query,
                page,
                exactMembership,
              }),
            ),
          },
        )
  return {
    items: orderSearchItems(result.items, tracksPlayed),
    totalCount: result.totalCount ?? result.items.length,
  }
}

/** Adds a selected provider result, or reuses its existing library item. */
export async function addManualMediaItem(
  apiBaseUrl: string,
  mediaType: ManualMediaSearchInput['mediaType'],
  item: Pick<ManualMediaSearchItem, 'externalId' | 'mediaItemId'>,
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
        'catalog-membership',
        'playback-catalog',
        'tidal-similar',
        'track',
        'album',
        'artists',
        'artist',
        'artist-overview',
        'artist-selection',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    )
  return Promise.all([
    ...(mediaType === 'album'
      ? [
          client.invalidateQueries({ queryKey: ['catalog-membership'] }),
          client.invalidateQueries({ queryKey: ['playback-catalog'] }),
          client.invalidateQueries({ queryKey: ['tidal-similar'] }),
        ]
      : []),
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
