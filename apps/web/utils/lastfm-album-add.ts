import { z } from 'zod'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import type { ManualMediaSearchItem } from '@repo/schemas/manual-add'
import { fetchApiData } from './api'
import { addManualMediaItem } from './manual-media-add'

const MissingAlbumErrorSchema = z.object({
  statusCode: z.literal(404),
  message: z.literal('Album not found'),
})

/** A null identity forces the next explicit attempt to resolve a deleted album. */
export async function addAndLinkLastfmAlbum({
  apiBaseUrl,
  source,
  item,
  identities,
}: {
  apiBaseUrl: string
  source: { artistName: string; albumName: string }
  item: ManualMediaSearchItem
  identities: Map<string, string | null>
}) {
  const remembered = identities.get(item.externalId)
  const albumId = await addManualMediaItem(apiBaseUrl, 'album', {
    ...item,
    mediaItemId: remembered === undefined ? item.mediaItemId : remembered,
  })
  identities.set(item.externalId, albumId)
  try {
    return await fetchApiData(
      apiBaseUrl,
      '/api/v1/lastfm/links',
      LastfmSyncStatusSchema,
      {
        method: 'PUT',
        body: JSON.stringify({ action: 'link', ...source, albumId }),
      },
    )
  } catch (error) {
    // Transient link failures retain the new album; deletion clears only its identity.
    if (MissingAlbumErrorSchema.safeParse(error).success)
      identities.set(item.externalId, null)
    throw error
  }
}
