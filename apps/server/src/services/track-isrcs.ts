import { type SQL, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { validIsrc } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import { providerReference } from '@/schemas/db'

type Database = Pick<typeof db, 'insert'>

/** Where an ISRC reference was read. */
export type TrackIsrcSource =
  | { kind: 'spotify-playlist-import'; jobId: string }
  | { kind: 'spotify-track-search'; jobId: string }
  | { kind: 'spotify-track-lookup'; responseId: string }
  | { kind: 'spotify-search-response'; responseId: string }
  | { kind: 'spotify-manual-add' }
  // A raw Spotify playlist file stored by the legacy import.
  | { kind: 'legacy-playlist-import'; snapshotId: string }
  | { kind: 'tidal-album'; jobId: string }
  | { kind: 'tidal-track-match'; jobId: string }
  | { kind: 'tidal-similar' }
  | { kind: 'sonovault-track-lookup'; jobId: string; responseId: string }
  | { kind: 'sonovault-album-lookup'; jobId: string; responseId: string }
  // The value stored on the library track before references existed.
  | { kind: 'library-track' }

export type TrackIsrcEvidence = {
  mediaItemId: string
  isrc: string | null
  provider: 'spotify' | 'tidal' | 'sonovault'
  source: TrackIsrcSource
}

const WRITE_BATCH = 500

/** The ID a provider's ISRC reference has on a library track. */
export const trackIsrcReferenceId = (
  mediaItemId: string,
  provider: string,
  isrc: string,
) => createStableId('pref', `${mediaItemId}:${provider}:isrc:${isrc}`)

/**
 * Records each valid ISRC as the provider's reference on the library track.
 * A reference already recorded keeps the source it was first read from.
 */
export async function recordTrackIsrcs(
  database: Database,
  evidence: TrackIsrcEvidence[],
  recordedAt = new Date(),
) {
  const rows = new Map<string, typeof providerReference.$inferInsert>()
  for (const entry of evidence) {
    const isrc = validIsrc(entry.isrc)
    if (!isrc) continue
    const id = trackIsrcReferenceId(entry.mediaItemId, entry.provider, isrc)
    if (rows.has(id)) continue
    rows.set(id, {
      id,
      mediaItemId: entry.mediaItemId,
      provider: entry.provider,
      referenceType: 'isrc',
      externalId: isrc,
      isPrimary: false,
      metadata: {
        source: entry.source.kind,
        ...('jobId' in entry.source ? { jobId: entry.source.jobId } : {}),
        ...('responseId' in entry.source
          ? { responseId: entry.source.responseId }
          : {}),
        ...('snapshotId' in entry.source
          ? { snapshotId: entry.source.snapshotId }
          : {}),
        recordedAt: recordedAt.toISOString(),
      },
    })
  }
  const values = [...rows.values()]
  for (let start = 0; start < values.length; start += WRITE_BATCH)
    await database
      .insert(providerReference)
      .values(values.slice(start, start + WRITE_BATCH))
      .onConflictDoNothing()
  return values.length
}

/** Every recorded ISRC on a track with the services that reported it. */
export const trackIsrcsExpression = (mediaItemId: SQL) => sql`
  coalesce((select jsonb_agg(jsonb_build_object('isrc', codes.external_id, 'providers', codes.providers)
      order by codes.external_id)
    from (select r.external_id, jsonb_agg(distinct r.provider) as providers
      from provider_reference r
      where r.media_item_id = ${mediaItemId} and r.reference_type = 'isrc'
      group by r.external_id) codes), '[]'::jsonb)`

/**
 * Whether a library track's primary ISRC is the one a Sonovault lookup gave
 * it (SONO-07) and no other service reports it. Spotify replaces such a
 * value, and removing Sonovault's data clears it; nothing else does.
 */
export const sonovaultPrimaryIsrcSql = (mediaItemId: SQL, isrc: SQL) => sql`
  (exists (select 1 from sonovault_track_lookup sonovault_primary
    where sonovault_primary.media_item_id = ${mediaItemId}
      and sonovault_primary.primary_isrc = ${isrc})
  and not exists (select 1 from provider_reference sonovault_other
    where sonovault_other.media_item_id = ${mediaItemId}
      and sonovault_other.reference_type = 'isrc'
      and sonovault_other.provider <> 'sonovault'
      and sonovault_other.external_id = ${isrc}))`
