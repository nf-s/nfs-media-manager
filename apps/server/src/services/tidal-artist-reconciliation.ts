import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  TidalArtistResourceSchema,
  TidalTrackResourceSchema,
} from '@/lib/tidal-api'
import { providerResponse } from '@/schemas/db'
import { observeCatalogOccurrence } from './catalog-discoveries'
import { reconcileArtistPair } from './catalog-artist-reconciliation'
import type { ChangeTransaction } from './library-change-effect'

const operation = 'matched-recording-artist-credit'
const document = z.object({
  data: z.unknown().optional(),
  included: z.array(z.unknown()).default([]),
})

/** A Spotify artist ID may come from a native credit or a current profile. */
function unambiguousSpotifyArtist(externalId: SQL) {
  return sql`
    select min(owners.id) as id
    from (
      select coalesce(a.merged_into_id,a.id) id
      from artist a where a.catalog_provider='spotify' and a.catalog_external_id=${externalId}
      union
      select coalesce(a.merged_into_id,a.id) id
      from artist_provider_current_state s
      join artist a on a.id=s.artist_id
      join artist_provider_snapshot p on p.id=s.latest_snapshot_id
        and p.artist_id=s.artist_id and p.provider=s.provider
      where s.provider='spotify' and p.normalized_data->>'externalId'=${externalId}
    ) owners
    having count(*)=1`
}

function singleCredits(text: string) {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const page = document.safeParse(json).data
  if (!page) return []
  const resources = [
    ...page.included,
    ...(Array.isArray(page.data) ? page.data : [page.data]),
  ]
  const names = new Map<string, string>()
  for (const resource of resources) {
    const artist = TidalArtistResourceSchema.safeParse(resource).data
    if (artist) names.set(artist.id, artist.attributes.name)
  }
  return resources.flatMap((resource) => {
    const track = TidalTrackResourceSchema.safeParse(resource).data
    const billing = track?.relationships?.artists?.data
    const [artist] = billing ?? []
    if (!track || billing?.length !== 1 || artist?.type !== 'artists') return []
    const name = names.get(artist.id)
    return name
      ? [
          {
            track: track.id,
            artist: artist.id,
            title: track.attributes.title,
            name,
          },
        ]
      : []
  })
}

/** The accepted first-party recording is already in the library. Its sole local credit must also have a corroborating Spotify artist ID. */
async function recordMatchedCredits(
  tx: ChangeTransaction,
  response: typeof providerResponse.$inferSelect,
) {
  if (response.body.state !== 'captured') return
  const credits = singleCredits(response.body.text)
  if (!credits.length) return
  const spotifyId = sql`(m.metadata->'spotifyArtistCredits'->0->>'id')`
  const result = await tx.execute(sql`
    select distinct n.id as source, m.id as track, a.id as target, e.artist as tidal_id, e.track as tidal_track, ${spotifyId} as spotify_id
    from jsonb_to_recordset(${JSON.stringify(credits)}::jsonb) e(track text,artist text,title text,name text)
    join provider_reference r on r.provider='tidal' and r.reference_type='track' and r.external_id=e.track
      and r.is_primary and r.metadata->>'source'='tidal-track-match'
      and r.metadata->>'rejected' is distinct from 'true' and r.metadata->>'verified' is distinct from 'false'
    join media_item m on m.id=r.media_item_id and m.title=e.title and m.in_library
      and m.metadata->>'legacyHidden' is distinct from 'true'
    join library_track t on t.media_item_id=m.id and t.spotify_track_id is not null
    join media_credit c on c.media_item_id=m.id and c.role='artist'
    join artist a on a.id=c.artist_id and a.name=e.name and a.merged_into_id is null
    join lateral (${unambiguousSpotifyArtist(spotifyId)}) owner on owner.id=a.id
    join artist n on n.catalog_provider='tidal' and n.catalog_external_id=e.artist and n.name=e.name
    where ${spotifyId} ~ '^[A-Za-z0-9]{22}$'
      and m.metadata->'spotifyArtistCredits' = jsonb_build_array(jsonb_build_object('name',a.name,'id',${spotifyId}))
      and not exists (select 1 from media_credit other where other.media_item_id=m.id and other.role='artist' and other.artist_id<>a.id)`)
  for (const row of z
    .array(
      z.object({
        source: z.string(),
        track: z.string(),
        target: z.string(),
        tidal_id: z.string(),
        tidal_track: z.string(),
        spotify_id: z.string(),
      }),
    )
    .parse(result.rows))
    await observeCatalogOccurrence(
      tx,
      { kind: 'artist', id: row.source },
      {
        provider: 'tidal',
        operation,
        occurrenceKey: row.track,
        subjectKind: 'track',
        subjectId: row.track,
        relationshipRole: 'artist',
        responseId: response.id,
        jobId: response.jobId,
        observedAt: response.receivedAt ?? undefined,
        details: {
          libraryArtistId: row.target,
          tidalArtistId: row.tidal_id,
          tidalTrackId: row.tidal_track,
          spotifyArtistId: row.spotify_id,
        },
      },
    )
}

async function mergeMatchedCredits(
  tx: ChangeTransaction,
  onlyId?: string,
  jobId?: string,
) {
  const candidates = await tx.execute(sql`
    with evidence as (select distinct n.id source, coalesce(a.merged_into_id,a.id) target, n.catalog_external_id tidal_id
      from catalog_observation o join artist n on n.id=o.target_id and n.catalog_provider='tidal'
        and n.catalog_external_id=o.details->>'tidalArtistId'
      join artist a on a.id=o.details->>'libraryArtistId'
      join lateral (${unambiguousSpotifyArtist(sql`(o.details->>'spotifyArtistId')`)}) owner on owner.id=coalesce(a.merged_into_id,a.id)
      join provider_reference r on r.media_item_id=o.subject_id and r.provider='tidal' and r.reference_type='track'
        and r.external_id=o.details->>'tidalTrackId' and r.is_primary and r.metadata->>'source'='tidal-track-match'
        and r.metadata->>'rejected' is distinct from 'true' and r.metadata->>'verified' is distinct from 'false'
      join media_item m on m.id=o.subject_id and m.in_library
        and m.metadata->>'legacyHidden' is distinct from 'true'
      join library_track t on t.media_item_id=m.id and t.spotify_track_id is not null
      where o.operation=${operation} and o.target_kind='artist' and o.provider='tidal'
        and o.response_id is not null and m.metadata->'spotifyArtistCredits' = jsonb_build_array(jsonb_build_object('id',o.details->>'spotifyArtistId','name',a.name))
        and exists (select 1 from media_credit c where c.media_item_id=o.subject_id and c.role='artist' and c.artist_id=coalesce(a.merged_into_id,a.id))
        and not exists (select 1 from media_credit other where other.media_item_id=o.subject_id and other.role='artist' and other.artist_id<>coalesce(a.merged_into_id,a.id)))
    select e.source,e.target from evidence e join artist n on n.id=e.source and n.merged_into_id is null
    where e.source<>e.target ${onlyId ? sql`and e.source=${onlyId}` : sql``}
      ${jobId ? sql`and exists (select 1 from catalog_observation o where o.operation=${operation} and o.target_id=e.source and o.job_id=${jobId})` : sql``}
      and not exists(select 1 from evidence other where (other.source=e.source and other.target<>e.target)
        or (other.target=e.target and other.tidal_id<>e.tidal_id))`)
  let merged = 0
  for (const { source, target } of z
    .array(z.object({ source: z.string(), target: z.string() }))
    .parse(candidates.rows))
    if (
      await reconcileArtistPair(
        tx,
        source,
        target,
        'matched-native-recording-credit',
        true,
      )
    )
      merged++
  return merged
}

export async function reconcileTidalJobArtists(
  tx: ChangeTransaction,
  jobId: string,
) {
  const rows = await tx
    .select()
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, jobId),
        eq(providerResponse.provider, 'tidal'),
        eq(providerResponse.status, 200),
        eq(providerResponse.bodyState, 'captured'),
      ),
    )
  for (const row of rows) await recordMatchedCredits(tx, row)
  if (rows.length) await mergeMatchedCredits(tx, undefined, jobId)
}

/** Collect independent corroboration before choosing any target. A dry run rolls the observations and changes back together. */
export async function repairMatchedTidalArtists(
  apply: boolean,
  database = db,
  onlyId?: string,
) {
  let merged = 0
  const dryRun = Symbol('dry run')
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      let after: string | undefined
      while (true) {
        const rows = await tx
          .select()
          .from(providerResponse)
          .where(
            and(
              eq(providerResponse.provider, 'tidal'),
              eq(providerResponse.status, 200),
              eq(providerResponse.bodyState, 'captured'),
              after ? gt(providerResponse.id, after) : undefined,
            ),
          )
          .orderBy(asc(providerResponse.id))
          .limit(10)
        for (const row of rows) await recordMatchedCredits(tx, row)
        after = rows.at(-1)?.id
        if (rows.length < 10) break
      }
      merged = await mergeMatchedCredits(tx, onlyId)
      if (!apply) throw dryRun
    })
  } catch (error) {
    if (error !== dryRun) throw error
  }
  return merged
}
