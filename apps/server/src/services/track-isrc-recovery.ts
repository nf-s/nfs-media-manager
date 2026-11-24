import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import type { db } from '@/lib/db'
import { validIsrc, validIsrcSql } from '@/lib/isrc'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  recordTrackIsrcs,
  sonovaultPrimaryIsrcSql,
  type TrackIsrcEvidence,
} from './track-isrcs'

type Database = Pick<typeof db, 'execute' | 'insert'>
type Options = { apply?: boolean; limit?: number; after?: string }

const UPDATE_BATCH = 500

const StoredPairsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    isrc: z.string(),
    source: z.enum([
      'spotify-track-lookup',
      'spotify-track-lookup-snapshot',
      'spotify-search-response',
      'spotify-track-search',
      'legacy-playlist-import',
    ]),
    source_id: z.string().nullable(),
  }),
)

const capturedText = sql`(body->>'text')`
const spotifyCaptured = sql`provider = 'spotify' and method = 'GET' and body_state = 'captured' and status between 200 and 299`
const directText = sql`(payload #>> '{response,body,text}')`
const capturedJson = sql`case when pg_input_is_valid(${capturedText}, 'jsonb') then ${capturedText}::jsonb end`
const directJson = sql`case when pg_input_is_valid(${directText}, 'jsonb') then ${directText}::jsonb end`

/**
 * Spotify ISRCs in retained responses, saved track searches and legacy
 * playlist files, matched to the
 * library track that holds the same Spotify track ID. A search candidate gives
 * its ISRC only to the track with that ID, never to the track searched for.
 */
const storedSpotifyIsrcs = (targets: string[] | undefined) => sql`
  select lt.media_item_id, pairs.isrc, pairs.source, pairs.source_id
  from (
    select response.body_json->>'id' as spotify_id, ${validIsrcSql(sql`response.body_json #>> '{external_ids,isrc}'`)} as isrc,
      'spotify-track-lookup' as source, response.id as source_id, 1 as priority
    from (select id, request_url, ${capturedJson} as body_json from provider_response
      where ${spotifyCaptured}
        and request_url ~ '^https://api\\.spotify\\.com/v1/tracks/') response
    where split_part(response.request_url, '?', 1) =
      'https://api.spotify.com/v1/tracks/' || (response.body_json->>'id')
    union all
    select item->>'id', ${validIsrcSql(sql`item #>> '{external_ids,isrc}'`)},
      'spotify-search-response', response.id, 2
    from (select id, (${capturedJson}) #> '{tracks,items}' as items from provider_response
      where ${spotifyCaptured}
        and request_url ~ '^https://api\\.spotify\\.com/v1/search') response
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(response.items) = 'array' then response.items else '[]'::jsonb end) item
    union all
    select body_json->>'id', ${validIsrcSql(sql`body_json #>> '{external_ids,isrc}'`)},
      'spotify-track-lookup-snapshot', id, 1
    from (select id, payload #>> '{request,url}' as url, ${directJson} as body_json
      from provider_snapshot
      where provider = 'spotify' and source = ${DIRECT_PROVIDER_RESPONSE_SOURCE}
        and payload #>> '{response,body,state}' = 'captured'
        and payload #>> '{response,status}' ~ '^2[0-9]{2}$') direct
    where split_part(url, '?', 1) = 'https://api.spotify.com/v1/tracks/' || (body_json->>'id')
    union all
    select candidate->>'spotifyTrackId', ${validIsrcSql(sql`candidate->>'isrc'`)},
      'spotify-track-search', log.job_id, 3
    from scrape_job_log log
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(log.metadata->'diagnostics') = 'array' then log.metadata->'diagnostics' else '[]'::jsonb end) diagnostic
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(diagnostic->'candidates') = 'array' then diagnostic->'candidates' else '[]'::jsonb end) candidate
    where log.metadata ? 'diagnostics' and diagnostic->>'kind' = 'spotify-track-search'
    union all
    select item #>> '{track,id}', ${validIsrcSql(sql`item #>> '{track,external_ids,isrc}'`)},
      'legacy-playlist-import', snapshot.id, 4
    from provider_snapshot snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array' then snapshot.payload else '[]'::jsonb end) item
    where snapshot.provider = 'spotify' and snapshot.media_item_id is null
      and snapshot.source like 'legacy-import:%-raw.json'
  ) pairs
  join library_track lt on lt.spotify_track_id = pairs.spotify_id
  where pairs.isrc is not null
    ${targets ? sql`and lt.media_item_id = any(${sql.param(targets)}::text[])` : sql``}
  order by lt.media_item_id, pairs.isrc, pairs.priority, pairs.source_id`

function sourceFor(
  row: z.infer<typeof StoredPairsSchema>[number],
): TrackIsrcEvidence['source'] | null {
  if (!row.source_id) return null
  if (row.source === 'spotify-track-search')
    return { kind: 'spotify-track-search', jobId: row.source_id }
  if (
    row.source === 'legacy-playlist-import' ||
    row.source === 'spotify-track-lookup-snapshot'
  )
    return { kind: row.source, snapshotId: row.source_id }
  return { kind: row.source, responseId: row.source_id }
}

/**
 * Records ISRCs from retained Spotify evidence, then fills an empty
 * `library_track.isrc` when
 * the track's Spotify references agree on one code. Makes no provider
 * requests, and a second run changes nothing.
 */
export async function recoverStoredTrackIsrcs(
  database: Database & Pick<typeof db, 'transaction'>,
  options: Options = {},
) {
  if (options.apply)
    return database.transaction(async (tx) => {
      await lockLibraryTrackWrites(tx)
      return recoverTrackIsrcs(tx, options)
    })
  return recoverTrackIsrcs(database, options)
}

async function recoverTrackIsrcs(
  database: Database,
  { apply = false, limit, after }: Options,
) {
  const targets =
    limit === undefined
      ? undefined
      : z
          .array(z.object({ id: z.string() }))
          .parse(
            (
              await database.execute(sql`
          select media_item_id as id from library_track where spotify_track_id is not null
          ${after ? sql`and media_item_id > ${after}` : sql``}
          order by media_item_id limit ${limit}`)
            ).rows,
          )
          .map(({ id }) => id)
  const pairs = StoredPairsSchema.parse(
    (await database.execute(storedSpotifyIsrcs(targets))).rows,
  )
  const evidence = pairs.flatMap((row): TrackIsrcEvidence[] => {
    const source = sourceFor(row)
    return source
      ? [
          {
            mediaItemId: row.media_item_id,
            isrc: row.isrc,
            provider: 'spotify',
            source,
          },
        ]
      : []
  })
  const codesByTrack = new Map<string, Set<string>>()
  for (const entry of evidence) {
    const isrc = validIsrc(entry.isrc)
    if (!isrc) continue
    const codes = codesByTrack.get(entry.mediaItemId) ?? new Set<string>()
    codes.add(isrc)
    codesByTrack.set(entry.mediaItemId, codes)
  }
  const [legacy] = z
    .array(
      z.object({
        unattributedPrimaryValues: z.number(),
        legacySpotifyReferences: z.number(),
        legacySpotifyReferencesWithSonovaultPrimary: z.number(),
      }),
    )
    .parse(
      (
        await database.execute(sql`
    select
      count(distinct lt.media_item_id) filter (where lt.isrc is not null and not exists (
        select 1 from provider_reference confirmed
        where confirmed.media_item_id = lt.media_item_id and confirmed.reference_type = 'isrc'
          and confirmed.external_id = ${validIsrcSql(sql`lt.isrc`)}
          and confirmed.metadata->>'source' is distinct from 'library-track'
      ))::integer as "unattributedPrimaryValues",
      count(r.id)::integer as "legacySpotifyReferences",
      count(r.id) filter (where exists (
        select 1 from sonovault_track_lookup lookup
        where lookup.media_item_id = lt.media_item_id and lookup.primary_isrc = r.external_id
      ))::integer as "legacySpotifyReferencesWithSonovaultPrimary"
    from library_track lt
    left join provider_reference r on r.media_item_id = lt.media_item_id
      and r.provider = 'spotify' and r.reference_type = 'isrc'
      and r.metadata->>'source' = 'library-track'
    where lt.spotify_track_id is not null
      ${targets ? sql`and lt.media_item_id = any(${sql.param(targets)}::text[])` : sql``}
  `)
      ).rows,
    )
  const counts = {
    apply,
    pairs: pairs.length,
    tracks: codesByTrack.size,
    tracksWithSeveralIsrcs: [...codesByTrack.values()].filter(
      (codes) => codes.size > 1,
    ).length,
    references: 0,
    primaryFilled: 0,
    pendingReferences: 0,
    ...(targets ? { next: targets.at(-1) ?? null } : {}),
    ...legacy,
  }
  if (codesByTrack.size) {
    const [pending] = z.array(z.object({ count: z.number() })).parse(
      (
        await database.execute(sql`
        select count(*)::integer as count
        from jsonb_to_recordset(${JSON.stringify(
          [...codesByTrack].flatMap(([mediaItemId, codes]) =>
            [...codes].map((isrc) => ({ mediaItemId, isrc })),
          ),
        )}::jsonb) as candidates("mediaItemId" text, isrc text)
        where not exists (
          select 1 from provider_reference r
          where r.media_item_id = candidates."mediaItemId" and r.provider = 'spotify'
            and r.reference_type = 'isrc' and r.external_id = candidates.isrc
            and r.metadata->>'source' is distinct from 'library-track'
        )
      `)
      ).rows,
    )
    counts.pendingReferences = pending?.count ?? 0
  }
  if (!apply) return counts
  counts.references = await recordTrackIsrcs(database, evidence)
  const ids = [...codesByTrack.keys()]
  for (let start = 0; start < ids.length; start += UPDATE_BATCH) {
    const batch = ids.slice(start, start + UPDATE_BATCH)
    const result = await database.execute(sql`
      update library_track lt set isrc = codes.isrc, updated_at = now()
      from (
        select media_item_id, min(external_id) as isrc from provider_reference
        where reference_type = 'isrc' and provider = 'spotify'
          and metadata->>'source' is distinct from 'library-track'
          and media_item_id = any(${sql.param(batch)}::text[])
        group by media_item_id having count(distinct external_id) = 1
      ) codes
      where lt.media_item_id = codes.media_item_id
        and (lt.isrc is null or ${sonovaultPrimaryIsrcSql(sql`lt.media_item_id`, sql`lt.isrc`)})`)
    counts.primaryFilled += result.rowCount ?? 0
  }
  return counts
}
