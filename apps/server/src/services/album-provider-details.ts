import { and, eq, inArray } from 'drizzle-orm'
import type { AlbumProviderDetails } from '@repo/schemas/album-provider-details'
import { db } from '@/lib/db'
import { readAlbumProviderDetails } from '@/lib/album-provider-details'
import { providerCurrentState } from '@/schemas/db'

const providers = ['musicbrainz', 'discogs', 'lastfm']

export async function getAlbumProviderDetails(
  mediaItemId: string,
): Promise<AlbumProviderDetails[]> {
  const states = await db
    .select({
      provider: providerCurrentState.provider,
      payload: providerCurrentState.payload,
    })
    .from(providerCurrentState)
    .where(
      and(
        eq(providerCurrentState.mediaItemId, mediaItemId),
        inArray(providerCurrentState.provider, providers),
      ),
    )
  return providers.flatMap((provider) => {
    const state = states.find((item) => item.provider === provider)
    const details = state && readAlbumProviderDetails(provider, state.payload)
    return details ? [details] : []
  })
}
