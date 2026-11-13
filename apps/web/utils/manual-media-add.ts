import type { QueryClient } from '@tanstack/react-query'
import {
  ManualMediaAddInputSchema,
  ManualMediaAddResultSchema,
  type ManualMediaSearchItem,
} from '@repo/schemas/manual-add'
import { fetchApiData } from './api'

/** Adds a selected provider result, or reuses its existing library item. */
export async function addManualMediaItem(
  apiBaseUrl: string,
  mediaType: 'album' | 'film',
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
  mediaType: 'album' | 'film',
) {
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
