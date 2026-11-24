import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { UpcSchema } from '@/lib/spotify-api'
import { providerReference } from '@/schemas/db'
import type { CatalogOrigin } from './catalog-discoveries'
import { recordTrackIsrcs, type TrackIsrcEvidence } from './track-isrcs'

type Origin = Pick<
  CatalogOrigin,
  'operation' | 'jobId' | 'responseId' | 'snapshotId' | 'importId'
>
type Code = {
  mediaItemId: string
  kind: 'album' | 'track'
  value?: string | null
  origin: Origin
}

function trackIsrcSource(origin: Origin): TrackIsrcEvidence['source'] | null {
  const { operation, jobId, responseId, snapshotId } = origin
  if (operation === 'playlist-contents')
    return responseId
      ? { kind: 'spotify-playlist-response', jobId, responseId }
      : null
  if (responseId)
    return {
      kind:
        operation === 'spotify-track-album-lookup'
          ? 'spotify-track-lookup'
          : 'spotify-search-response',
      responseId,
    }
  if (snapshotId) return { kind: 'spotify-track-lookup-snapshot', snapshotId }
  return jobId ? { kind: 'spotify-track-search', jobId } : null
}

/** Record only codes returned for the exact native Spotify resource. */
export async function recordSpotifyCatalogCodes(
  tx: Pick<typeof db, 'insert'>,
  codes: readonly Code[],
) {
  const barcodes = new Map<string, typeof providerReference.$inferInsert>()
  const isrcs: TrackIsrcEvidence[] = []
  for (const code of codes) {
    if (!code.value) continue
    if (code.kind === 'track') {
      const source = trackIsrcSource(code.origin)
      if (source)
        isrcs.push({
          mediaItemId: code.mediaItemId,
          isrc: code.value,
          provider: 'spotify',
          source,
        })
      continue
    }
    const upc = UpcSchema.safeParse(code.value)
    if (!upc.success || /^0+$/.test(upc.data)) continue
    const { mediaItemId, origin } = code
    const id = createStableId('pref', `${mediaItemId}:spotify:upc:${upc.data}`)
    if (barcodes.has(id)) continue
    barcodes.set(id, {
      id,
      mediaItemId,
      provider: 'spotify',
      referenceType: 'upc',
      externalId: upc.data,
      metadata: {
        source: origin.operation,
        ...(origin.jobId ? { jobId: origin.jobId } : {}),
        ...(origin.responseId ? { responseId: origin.responseId } : {}),
        ...(origin.snapshotId ? { snapshotId: origin.snapshotId } : {}),
        ...(origin.importId ? { importId: origin.importId } : {}),
      },
    })
  }
  const entries = [...barcodes.values()]
  let albumCodes = 0
  const batchSize = 500
  for (let index = 0; index < entries.length; index += batchSize) {
    const inserted = await tx
      .insert(providerReference)
      .values(entries.slice(index, index + batchSize))
      .onConflictDoNothing()
      .returning({ id: providerReference.id })
    albumCodes += inserted.length
  }
  if (isrcs.length) await recordTrackIsrcs(tx, isrcs)
  return albumCodes
}
