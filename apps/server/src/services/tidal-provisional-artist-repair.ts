import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  tidalSuggestionTitle,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { validIsrc, validIsrcSql } from '@/lib/isrc'
import {
  catalogCreditOccurrence,
  observeCatalogOccurrence,
  provisionalCatalogArtistId,
} from './catalog-discoveries'
import { observeNamedArtistIdentitiesWithoutMerging } from './catalog-artist-identities'
import {
  exactOwners,
  reconcileArtistPair,
} from './catalog-artist-reconciliation'
import type { ChangeTransaction } from './library-change-effect'
import type { similarRecordingArtistEvidence } from './similar-recording-artist-evidence'
import type { SimilarOrigin } from './tidal-similar-references'

type Pair = Awaited<ReturnType<typeof similarRecordingArtistEvidence>>[number]
type ReceiptPage = {
  kind: TidalSimilarKind
  items: readonly TidalSuggestion[]
  origin: SimilarOrigin
}
const candidates = z.array(
  z.object({
    recording: z.string(),
    source: z.string(),
    tidal_artist: z.string(),
    name: z.string(),
    position: z.number(),
    seed: z.string(),
    job: z.string(),
    response: z.string(),
    page_position: z.number(),
    observed_at: z.coerce.date(),
  }),
)

function receiptCredits(
  pages: readonly ReceiptPage[],
  pairs: ReadonlyMap<string, Pair>,
) {
  return pages.flatMap(({ kind, items, origin }) => {
    if (kind !== 'track' || !origin.jobId || !origin.responseId) return []
    const { jobId, responseId, seedId } = origin
    return items.flatMap((item, index) => {
      const code = validIsrc(item.code)
      if (!code) return []
      return (item.artistCredits ?? []).flatMap(({ id, name }, position) =>
        pairs.get(id)?.suggestions.has(item)
          ? [
              {
                tidal_track: item.tidalId,
                tidal_artist: id,
                title: tidalSuggestionTitle(item),
                code,
                name,
                position: position + 1,
                page_position: item.catalogPosition ?? index + 1,
                seed: seedId,
                job: jobId,
                response: responseId,
              },
            ]
          : [],
      )
    })
  })
}

/** Recover the old recording-scoped identity only for an extant, exactly corroborated credit. */
export async function repairProvisionalTidalSimilarArtists(
  tx: ChangeTransaction,
  receiptPages: readonly ReceiptPage[],
  evidence: readonly Pair[],
) {
  const pairs = new Map(evidence.map((pair) => [pair.tidalId, pair]))
  const incoming = receiptCredits(receiptPages, pairs)
  if (!incoming.length) return 0
  const { rows } = await tx.execute(sql`
    select distinct m.id as recording, a.id as source, e.tidal_artist, e.name,
      e.position, e.seed, e.job, e.response, e.page_position, coalesce(p.received_at,o.observed_at) as observed_at
    from jsonb_to_recordset(${JSON.stringify(incoming)}::jsonb)
      e(tidal_track text,tidal_artist text,title text,code text,name text,position int,page_position int,seed text,job text,response text)
    join scrape_job j on j.id=e.job and j.status='succeeded' and j.provider='tidal'
      and j.options->>'task'='tidal-similar' and j.options->>'itemId'=e.seed
    join provider_response p on p.id=e.response and p.job_id=j.id and p.provider='tidal' and p.status=200
      and p.method='GET' and p.phase='task' and p.body_state='captured'
      and p.request_url ~ '^https://openapi[.]tidal[.]com/v2/tracks/[0-9]{1,20}/relationships/similarTracks$'
    join provider_reference r on r.provider='tidal' and r.reference_type='track' and r.external_id=e.tidal_track
      and r.metadata->>'rejected' is distinct from 'true' and r.metadata->>'verified' is distinct from 'false'
      and (r.metadata->>'code' is null or ${validIsrcSql(sql`r.metadata->>'code'`)}=e.code)
    join media_item m on m.id=r.media_item_id and m.media_type='track'
      and lower(m.title)=lower(e.title) and m.metadata->>'legacyHidden' is distinct from 'true'
    join catalog_observation o on o.subject_kind='track' and o.subject_id=m.id
      and o.target_kind='artist' and o.relationship_role='artist' and o.position=e.position
      and o.provider='tidal' and o.operation='similar' and o.job_id=j.id
      and (o.response_id is null or o.response_id=p.id)
    join artist a on a.id=o.target_id and a.name=e.name and a.catalog_provider='tidal'
      and a.catalog_external_id is null and a.merged_into_id is null
    join media_credit c on c.media_item_id=m.id and c.artist_id=a.id
      and c.role='artist' and c.billing_order=e.position-1
    where exists (
      select 1 from catalog_observation track
      where track.target_kind='track' and track.target_id=m.id and track.media_item_id=m.id
        and track.subject_kind='track' and track.subject_id=e.seed and track.position=e.page_position
        and track.provider='tidal' and track.operation='similar' and track.job_id=j.id
        and (track.response_id is null or track.response_id=p.id)
    ) and not exists (
      select 1 from media_credit other where other.artist_id=a.id
        and (other.media_item_id<>m.id or other.role<>'artist' or other.billing_order<>e.position-1)
    ) and not exists (
      select 1 from catalog_observation other join artist rival on rival.id=other.target_id
      where other.subject_kind='track' and other.subject_id=m.id and other.position=e.position
        and other.target_kind='artist' and other.relationship_role='artist' and other.provider='tidal'
        and rival.catalog_provider='tidal' and rival.catalog_external_id<>e.tidal_artist
    )
    order by recording,position,source,response`)
  const bySource = new Map<string, z.infer<typeof candidates>[number]>()
  const conflicted = new Set<string>()
  for (const row of candidates.parse(rows)) {
    if (
      row.source !==
      provisionalCatalogArtistId(
        'tidal',
        row.recording,
        'artist',
        row.position - 1,
        row.name,
      )
    )
      continue
    const previous = bySource.get(row.source)
    if (previous && previous.tidal_artist !== row.tidal_artist)
      conflicted.add(row.source)
    if (!previous) bySource.set(row.source, row)
  }

  let changed = 0
  for (const row of bySource.values()) {
    const pair = pairs.get(row.tidal_artist)
    if (!pair || conflicted.has(row.source)) continue
    const spotifyOwners = await exactOwners(tx, 'spotify', pair.spotifyId)
    const [spotify] = spotifyOwners
    if (
      !spotify ||
      spotifyOwners.length !== 1 ||
      (pair.owner && pair.owner !== spotify)
    )
      continue
    const slot = { trackId: row.recording, position: row.position }
    const rule = 'retained-tidal-recording-artist-credit'
    // Respect earlier decisions on the provisional artist and the final Spotify owner.
    if (
      !(await reconcileArtistPair(tx, row.source, spotify, rule, false, slot))
    )
      continue
    const tidalOwners = await exactOwners(tx, 'tidal', row.tidal_artist)
    if (tidalOwners.length > 1) continue
    const rollback = new Error('Discard unused native TIDAL artist')
    try {
      await tx.transaction(async (savepoint) => {
        const observed = new Map<string, string>()
        const identities = await observeNamedArtistIdentitiesWithoutMerging(
          savepoint,
          'tidal',
          new Map([[row.tidal_artist, row.name]]),
          observed,
        )
        const target = identities?.get(row.tidal_artist)
        if (
          !target ||
          (tidalOwners[0] && target !== tidalOwners[0]) ||
          (target !== spotify &&
            !(await reconcileArtistPair(
              savepoint,
              target,
              spotify,
              'matched-recording-artist-ids',
              false,
            ))) ||
          !(await reconcileArtistPair(
            savepoint,
            row.source,
            target,
            rule,
            true,
            slot,
          ))
        )
          throw rollback
        const occurrence = catalogCreditOccurrence(
          { kind: 'artist', id: observed.get(row.tidal_artist) ?? target },
          {
            provider: 'tidal',
            operation: 'similar',
            occurrenceKey: row.job,
            subjectKind: 'track',
            subjectId: row.seed,
            page: 1,
            position: row.page_position,
            jobId: row.job,
            responseId: row.response,
            observedAt: row.observed_at,
          },
          'track',
          row.recording,
          'artist',
          row.position - 1,
        )
        await observeCatalogOccurrence(
          savepoint,
          occurrence.target,
          occurrence.origin,
        )
      })
      changed++
    } catch (error) {
      if (error !== rollback) throw error
    }
  }
  return changed
}
