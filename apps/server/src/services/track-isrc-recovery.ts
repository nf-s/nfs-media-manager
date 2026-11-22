import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { validIsrc, validIsrcSql } from '@/lib/isrc'
import { recordTrackIsrcs, type TrackIsrcEvidence } from './track-isrcs'

type Database = Pick<typeof db, 'execute' | 'insert'>

const UPDATE_BATCH = 500

const StoredPairsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    isrc: z.string(),
    source: z.enum([
      'library-track',
      'spotify-track-lookup',
      'spotify-search-response',
      'spotify-track-search',
    ]),
    source_id: z.string().nullable(),
  }),
)

const capturedText = sql`(body->>'text')`
const spotifyCaptured = sql`provider = 'spotify' and body_state = 'captured'
  and pg_input_is_valid(${capturedText}, 'jsonb')`

/**
 * Every Spotify track object already stored with an ISRC, matched to the
 * library track that holds the same Spotify track ID. A search candidate gives
 * its ISRC only to the track with that ID, never to the track searched for.
 */
const storedSpotifyIsrcs = sql`
  select lt.media_item_id, pairs.isrc, pairs.source, pairs.source_id
  from (
    select spotify_track_id as spotify_id, ${validIsrcSql(sql`isrc`)} as isrc,
      'library-track' as source, null::text as source_id, 0 as priority
    from library_track where isrc is not null
    union all
    select response.body_json->>'id', ${validIsrcSql(sql`response.body_json #>> '{external_ids,isrc}'`)},
      'spotify-track-lookup', response.id, 1
    from (select id, ${capturedText}::jsonb as body_json from provider_response
      where ${spotifyCaptured}
        and request_url ~ '^https://api\\.spotify\\.com/v1/tracks/') response
    union all
    select item->>'id', ${validIsrcSql(sql`item #>> '{external_ids,isrc}'`)},
      'spotify-search-response', response.id, 2
    from (select id, ${capturedText}::jsonb #> '{tracks,items}' as items from provider_response
      where ${spotifyCaptured}
        and request_url ~ '^https://api\\.spotify\\.com/v1/search') response
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(response.items) = 'array' then response.items else '[]'::jsonb end) item
    union all
    select candidate->>'spotifyTrackId', ${validIsrcSql(sql`candidate->>'isrc'`)},
      'spotify-track-search', log.job_id, 3
    from scrape_job_log log
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(log.metadata->'diagnostics') = 'array' then log.metadata->'diagnostics' else '[]'::jsonb end) diagnostic
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(diagnostic->'candidates') = 'array' then diagnostic->'candidates' else '[]'::jsonb end) candidate
    where log.metadata ? 'diagnostics' and diagnostic->>'kind' = 'spotify-track-search'
  ) pairs
  join library_track lt on lt.spotify_track_id = pairs.spotify_id
  where pairs.isrc is not null
  order by lt.media_item_id, pairs.isrc, pairs.priority, pairs.source_id`

function sourceFor(
  row: z.infer<typeof StoredPairsSchema>[number],
): TrackIsrcEvidence['source'] | null {
  if (row.source === 'library-track') return { kind: 'library-track' }
  if (!row.source_id) return null
  if (row.source === 'spotify-track-search')
    return { kind: 'spotify-track-search', jobId: row.source_id }
  return { kind: row.source, responseId: row.source_id }
}

/**
 * Records ISRCs from stored Spotify responses, saved track searches and
 * library values as references, then fills an empty `library_track.isrc` when
 * the track's Spotify references agree on one code. Makes no provider
 * requests, and a second run changes nothing.
 */
export async function recoverStoredTrackIsrcs(
  database: Database,
  { apply = false }: { apply?: boolean } = {},
) {
  const pairs = StoredPairsSchema.parse(
    (await database.execute(storedSpotifyIsrcs)).rows,
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
  const counts = {
    apply,
    pairs: pairs.length,
    tracks: codesByTrack.size,
    tracksWithSeveralIsrcs: [...codesByTrack.values()].filter(
      (codes) => codes.size > 1,
    ).length,
    references: 0,
    primaryFilled: 0,
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
          and media_item_id = any(${sql.param(batch)}::text[])
        group by media_item_id having count(distinct external_id) = 1
      ) codes
      where lt.media_item_id = codes.media_item_id and lt.isrc is null`)
    counts.primaryFilled += result.rowCount ?? 0
  }
  return counts
}
