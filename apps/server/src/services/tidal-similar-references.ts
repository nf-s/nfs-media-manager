import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TidalSimilarKind, TidalSuggestion } from '@repo/schemas/tidal'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import type { db } from '@/lib/db'
import { validIsrcSql } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import { providerReference } from '@/schemas/db'
import { readAlbumMatchRejectionsForItems } from './album-match-rejections'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { codeKey, upcVariants } from './spotify-code-search'
import type { MappedSimilarItem } from './similar-library-matches'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type SimilarOrigin = {
  seedId: string
  jobId?: string
  responseId?: string
  observedAt?: Date
}

export function similarReference(
  kind: TidalSimilarKind,
  item: TidalSuggestion,
  origin: SimilarOrigin,
) {
  return {
    referenceType: kind,
    externalId: item.tidalId,
    isPrimary: true,
    metadata: {
      source: 'tidal-similar',
      sourceItemId: origin.seedId,
      recordedAt: (origin.observedAt ?? new Date()).toISOString(),
      ...(origin.jobId && { jobId: origin.jobId }),
      ...(origin.responseId && { responseId: origin.responseId }),
      url: item.url,
      version: item.version,
      durationSec: item.durationSec,
      code: item.code,
      popularity: null,
    },
  }
}

/** Store only a native identity or an unambiguous first-party recording/release match. */
export async function shareSimilarReferences(
  tx: Transaction,
  kind: TidalSimilarKind,
  items: MappedSimilarItem[],
  origin: SimilarOrigin,
  disputedCodes: ReadonlySet<string> = new Set(),
) {
  if (!items.length) return 0
  await lockLibraryTrackWrites(tx)
  const candidates = items.flatMap((item) => {
    const key = codeKey(kind, item.code ?? '')
    const variants =
      key && kind === 'album' ? upcVariants(key) : key ? [key] : []
    return [...new Set([item.catalogMediaItemId, item.library?.id])].flatMap(
      (id) =>
        id
          ? [
              {
                id,
                native: item.tidalId,
                variants,
                catalog: id === item.catalogMediaItemId,
                disputed: Boolean(key && disputedCodes.has(key)),
                spotify:
                  kind === 'track' && item.spotifySource === 'spotify'
                    ? item.spotify?.spotifyId
                    : undefined,
              },
            ]
          : [],
    )
  })
  if (!candidates.length) return 0
  const codeType = kind === 'track' ? 'isrc' : 'upc'
  const observedCode =
    kind === 'track'
      ? validIsrcSql(sql`coalesce(r.metadata->>'code',r.metadata->>'isrc')`)
      : sql`ltrim(coalesce(r.metadata->>'code',r.metadata->>'barcodeId'),'0')`
  // One recording can have several TIDAL editions. Keep those IDs as evidence
  // without letting a new observation displace an existing or pending choice.
  const result = await tx.execute(sql`
    with incoming as (
      select * from jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
        as i(id text, native text, variants text[], catalog boolean, spotify text, disputed boolean)
    ), eligible as (
      select i.*, (i.disputed or
        exists (select from incoming other where other.id=i.id and other.native<>i.native)
        or exists (select from provider_reference r where r.media_item_id=i.id and
          r.provider='tidal' and r.reference_type=${kind} and r.external_id<>i.native)
        or exists (select from provider_reference r where r.provider='tidal' and r.reference_type=${kind}
          and r.external_id<>i.native and ${observedCode}=${kind === 'track' ? sql`i.variants[1]` : sql`ltrim(i.variants[1],'0')`})
        or exists (select from scrape_job j where j.options->>'task'='tidal-track-match'
          and j.options->>'trackId'=i.id and j.options->>'reason'='ambiguous'
          and j.options->>'acceptedTidalTrackId' is null)
      ) as competing from incoming i
    )
    select distinct i.id, i.native, (m.in_library and i.competing) as alternate from eligible i
    join media_item m on m.id=i.id and m.media_type=${kind}
    where m.metadata->>'legacyHidden' is distinct from 'true'
      and not exists (select from provider_reference r where r.media_item_id=i.id
        and r.provider='tidal' and r.reference_type=${kind} and
        r.external_id=i.native and (r.metadata->>'verified'='false' or r.metadata->>'rejected'='true'))
      and (exists (select from provider_reference r where r.media_item_id=i.id
             and r.provider='tidal' and r.reference_type=${kind} and r.external_id=i.native)
        or (m.in_library and not i.catalog and cardinality(i.variants)>0 and (${kind}='track' or not i.competing)
          and (exists (select from provider_reference c where c.media_item_id=i.id
                and c.reference_type=${codeType} and c.provider<>'sonovault' and c.external_id=any(i.variants)
                and c.metadata->>'verified' is distinct from 'false' and c.metadata->>'rejected' is distinct from 'true')
            or exists (select from library_track t where t.media_item_id=i.id and t.spotify_track_id=i.spotify))
          and not exists (select from provider_reference c join media_item other on other.id=c.media_item_id
             where c.reference_type=${codeType} and c.external_id=any(i.variants) and other.id<>i.id
               and other.in_library and other.media_type=${kind} and other.metadata->>'legacyHidden' is distinct from 'true')
          and not exists (select from library_track t join media_item other on other.id=t.media_item_id
              where t.spotify_track_id=i.spotify and t.media_item_id<>i.id and other.in_library
                and other.metadata->>'legacyHidden' is distinct from 'true')
          and not exists (select from provider_reference r join media_item other on other.id=r.media_item_id
              where r.provider='tidal' and r.reference_type=${kind} and r.external_id=i.native
                and other.in_library and other.id<>i.id and other.metadata->>'legacyHidden' is distinct from 'true')
        ))`)
  const eligible = z
    .array(
      z.object({ id: z.string(), native: z.string(), alternate: z.boolean() }),
    )
    .parse(result.rows)
  const rejected =
    kind === 'album'
      ? await readAlbumMatchRejectionsForItems(
          tx,
          eligible.map((row) => row.id),
        )
      : undefined
  const suggestions = new Map(items.map((item) => [item.tidalId, item]))
  const references: (typeof providerReference.$inferInsert)[] = []
  const codes = new Map<string, typeof providerReference.$inferInsert>()
  for (const { id, native, alternate } of eligible) {
    const item = suggestions.get(native)
    if (!item) continue
    const reference = similarReference(kind, item, origin)
    const isRejected = createAlbumMatchRejectionPredicate(
      'tidal',
      rejected?.get(id) ?? [],
    )
    if (
      isRejected(reference) ||
      isRejected({ referenceType: 'url', externalId: item.url })
    )
      continue
    references.push({
      ...reference,
      isPrimary: !alternate,
      id: createStableId('pref', `${id}:tidal:${kind}:${native}`),
      mediaItemId: id,
      provider: 'tidal',
      metadata: {
        ...reference.metadata,
        ...(alternate && { selection: 'alternate' }),
        ...(id === item.library?.id &&
          item.libraryMatch && { libraryMatch: item.libraryMatch }),
      },
    })
    const key = codeKey(kind, item.code ?? '')
    if (key && item.code) {
      const externalId = kind === 'album' ? item.code.trim() : key
      const codeId = createStableId(
        'pref',
        `${id}:tidal:${codeType}:${externalId}`,
      )
      codes.set(codeId, {
        id: codeId,
        mediaItemId: id,
        provider: 'tidal',
        referenceType: codeType,
        externalId,
        metadata: reference.metadata,
      })
    }
  }
  const changed = references.length
    ? await tx
        .insert(providerReference)
        .values(references)
        .onConflictDoUpdate({
          target: [
            providerReference.mediaItemId,
            providerReference.provider,
            providerReference.referenceType,
            providerReference.externalId,
          ],
          set: {
            metadata: sql`coalesce(${providerReference.metadata}, '{}'::jsonb) || excluded.metadata`,
            isPrimary: sql`excluded.is_primary`,
          },
          setWhere: sql`${providerReference.metadata}->>'source' is null and ${providerReference.metadata}->>'matchReason' is null`,
        })
        .returning({ id: providerReference.id })
    : []
  const addedCodes = codes.size
    ? await tx
        .insert(providerReference)
        .values([...codes.values()])
        .onConflictDoNothing()
        .returning({ id: providerReference.id })
    : []
  return changed.length + addedCodes.length
}
