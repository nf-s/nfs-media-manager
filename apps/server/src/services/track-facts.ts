import { inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { CamelotKeySchema, parseMusicalKey } from '@repo/schemas/musical-keys'
import type { db } from '@/lib/db'
import {
  SonovaultResolveResultSchema,
  SonovaultTrackSchema,
  type SonovaultTrack,
} from '@/lib/sonovault-api'
import { providerResponse, trackFact } from '@/schemas/db'

type Database = Pick<typeof db, 'execute' | 'insert' | 'select'>

/** The provider whose verified facts Browse shows. */
export const browseTrackFactProvider = 'sonovault'

const WRITE_BATCH = 500
const RESPONSE_BATCH = 20

/** The fields of a Sonovault track record that hold its tempo and key. */
export type SonovaultTrackFacts = Pick<
  SonovaultTrack,
  'id' | 'bpm' | 'key_alphanumeric' | 'key_musical' | 'key_open' | 'keys'
>

export type SonovaultTrackFactsEntry = {
  mediaItemId: string
  /** The track record as returned by Sonovault. */
  track: SonovaultTrackFacts
  /** Whether the record agreed with the library track (SONO-08). */
  verified: boolean
  responseId: string | null
  fetchedAt: Date
}

function factRow(
  entry: SonovaultTrackFactsEntry,
): typeof trackFact.$inferInsert {
  const { track } = entry
  const camelot = CamelotKeySchema.safeParse(track.key_alphanumeric).success
    ? track.key_alphanumeric
    : // A record missing the Camelot form can still name the key another way.
      parseMusicalKey(track.key_musical ?? track.key_open ?? '')
  return {
    mediaItemId: entry.mediaItemId,
    provider: 'sonovault',
    // Sonovault reports an unanalysed tempo as null; zero is treated the same.
    bpm:
      track.bpm === null || track.bpm <= 0
        ? null
        : Math.round(track.bpm * 100) / 100,
    keyCamelot: camelot,
    keyMusical: camelot ? track.key_musical : null,
    keyOpen: camelot ? track.key_open : null,
    keySource:
      (camelot &&
        track.keys.find((key) => key.key_alphanumeric === camelot)?.source) ||
      null,
    verified: entry.verified,
    responseId: entry.responseId,
    fetchedAt: entry.fetchedAt,
  }
}

/**
 * Stores the tempo and key of Sonovault records on their library tracks. A
 * record replaces the track's earlier Sonovault facts unless it is older.
 */
export async function recordSonovaultTrackFacts(
  database: Pick<typeof db, 'insert'>,
  entries: SonovaultTrackFactsEntry[],
) {
  const rows = new Map<string, typeof trackFact.$inferInsert>()
  for (const entry of entries) {
    const existing = rows.get(entry.mediaItemId)
    if (existing && existing.fetchedAt > entry.fetchedAt) continue
    rows.set(entry.mediaItemId, factRow(entry))
  }
  const values = [...rows.values()]
  for (let start = 0; start < values.length; start += WRITE_BATCH)
    await database
      .insert(trackFact)
      .values(values.slice(start, start + WRITE_BATCH))
      .onConflictDoUpdate({
        target: [trackFact.mediaItemId, trackFact.provider],
        set: {
          bpm: sql`excluded.bpm`,
          keyCamelot: sql`excluded.key_camelot`,
          keyMusical: sql`excluded.key_musical`,
          keyOpen: sql`excluded.key_open`,
          keySource: sql`excluded.key_source`,
          verified: sql`excluded.verified`,
          responseId: sql`excluded.response_id`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`excluded.fetched_at >= ${trackFact.fetchedAt}
          and (excluded.bpm, excluded.key_camelot, excluded.key_musical,
            excluded.key_open, excluded.key_source, excluded.verified,
            excluded.response_id, excluded.fetched_at)
          is distinct from (${trackFact.bpm}, ${trackFact.keyCamelot},
            ${trackFact.keyMusical}, ${trackFact.keyOpen}, ${trackFact.keySource},
            ${trackFact.verified}, ${trackFact.responseId}, ${trackFact.fetchedAt})`,
      })
  return values.length
}

/** Removes every fact a provider reported, in one statement (SONO-10). */
export async function removeProviderTrackFacts(
  database: Pick<typeof db, 'execute'>,
  provider: string,
) {
  const result = await database.execute(
    sql`delete from track_fact where provider = ${provider}`,
  )
  return result.rowCount ?? 0
}

const SonovaultReferenceRowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    external_id: z.string(),
    verified: z.boolean(),
  }),
)

const StoredResponseRowsSchema = z.array(
  z.object({ id: z.string(), received_at: z.string().datetime() }),
)

/** Track records in a stored Sonovault body: a bulk result list or one track. */
function storedTrackRecords(text: string): SonovaultTrack[] {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  const results = z.object({ results: z.array(z.unknown()) }).safeParse(body)
  if (results.success)
    return results.data.results.flatMap((result) => {
      // One malformed line does not hide the others.
      const parsed = SonovaultResolveResultSchema.safeParse(result)
      return parsed.success && parsed.data.track ? [parsed.data.track] : []
    })
  const single = SonovaultTrackSchema.safeParse(body)
  return single.success ? [single.data] : []
}

/**
 * Applies the tempo and key of every stored Sonovault response to the library
 * tracks that hold its `sonovault-track` reference, with the reference's
 * verified flag. A later response replaces an earlier one. Makes no requests;
 * a second run changes nothing.
 */
export async function applyStoredSonovaultTrackFacts(
  database: Database,
  { apply = false }: { apply?: boolean } = {},
) {
  const references = SonovaultReferenceRowsSchema.parse(
    (
      await database.execute(sql`
        select media_item_id, external_id,
          coalesce(metadata->>'verified' = 'true', false) as verified
        from provider_reference
        where provider = 'sonovault' and reference_type = 'sonovault-track'
          and media_item_id in (select media_item_id from library_track)`)
    ).rows,
  )
  const tracksByRecord = new Map<
    string,
    { mediaItemId: string; verified: boolean }[]
  >()
  for (const row of references) {
    const tracks = tracksByRecord.get(row.external_id) ?? []
    tracks.push({ mediaItemId: row.media_item_id, verified: row.verified })
    tracksByRecord.set(row.external_id, tracks)
  }
  const responses = StoredResponseRowsSchema.parse(
    (
      await database.execute(sql`
        select r.id, to_char(coalesce(r.received_at, j.created_at),
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at
        from provider_response r join scrape_job j on j.id = r.job_id
        where r.provider = 'sonovault' and r.body_state = 'captured'
        order by coalesce(r.received_at, j.created_at), r.job_id, r.attempt, r.ordinal`)
    ).rows,
  )
  const entries = new Map<string, SonovaultTrackFactsEntry>()
  for (let start = 0; start < responses.length; start += RESPONSE_BATCH) {
    const batch = responses.slice(start, start + RESPONSE_BATCH)
    const bodies = await database
      .select({
        id: providerResponse.id,
        text: sql<string | null>`${providerResponse.body}->>'text'`,
      })
      .from(providerResponse)
      .where(
        inArray(
          providerResponse.id,
          batch.map((response) => response.id),
        ),
      )
    const textById = new Map(bodies.map((body) => [body.id, body.text]))
    for (const response of batch) {
      const text = textById.get(response.id)
      if (!text) continue
      for (const track of storedTrackRecords(text))
        for (const libraryTrack of tracksByRecord.get(String(track.id)) ?? [])
          entries.set(libraryTrack.mediaItemId, {
            mediaItemId: libraryTrack.mediaItemId,
            track,
            verified: libraryTrack.verified,
            responseId: response.id,
            fetchedAt: new Date(response.received_at),
          })
    }
  }
  const values = [...entries.values()]
  const counts = {
    apply,
    references: references.length,
    responses: responses.length,
    tracks: values.length,
    withTempo: values.filter((entry) => entry.track.bpm !== null).length,
    withKey: values.filter((entry) => factRow(entry).keyCamelot !== null)
      .length,
    verified: values.filter((entry) => entry.verified).length,
    written: 0,
  }
  if (!apply) return counts
  counts.written = await recordSonovaultTrackFacts(database, values)
  return counts
}

const verifiedFact = sql`f.provider = ${browseTrackFactProvider} and f.verified`

/** Browse: a track's verified tempo. */
export function verifiedTrackBpm(mediaItemId: SQL) {
  return sql`(select f.bpm from track_fact f
    where f.media_item_id = ${mediaItemId} and ${verifiedFact})`
}

/** Browse: a track's verified key, as a Camelot key. */
export function verifiedTrackKey(mediaItemId: SQL) {
  return sql`(select f.key_camelot from track_fact f
    where f.media_item_id = ${mediaItemId} and ${verifiedFact})`
}

// 1A, 1B, 2A … 12B: the order of the Camelot wheel.
const keyPosition = sql`left(f.key_camelot, -1)::int * 2 + (right(f.key_camelot, 1) = 'B')::int`

/** Browse sort: a track's verified key by its place on the Camelot wheel. */
export function verifiedTrackKeyPosition(mediaItemId: SQL) {
  return sql`(select ${keyPosition} from track_fact f
    where f.media_item_id = ${mediaItemId} and ${verifiedFact})`
}

/** Browse order rows: tempo, or the key's place on the Camelot wheel. */
export function verifiedTrackFactOrderRows(key: 'bpm' | 'musicalKey') {
  return key === 'bpm'
    ? sql`select f.media_item_id, f.bpm as name from track_fact f
        where ${verifiedFact} and f.bpm is not null`
    : sql`select f.media_item_id, ${keyPosition} as name
        from track_fact f where ${verifiedFact} and f.key_camelot is not null`
}

/** Browse filter: track IDs whose verified tempo is within the bounds. */
export function verifiedTrackBpmIds(bounds: SQL) {
  return sql`select f.media_item_id from track_fact f
    where ${verifiedFact} and f.bpm is not null and ${bounds}`
}

/** Browse filter: track IDs with a verified key, written in any notation. */
export function verifiedTrackKeyIds(value: string) {
  const camelot = parseMusicalKey(value)
  if (!camelot) return null
  return sql`select f.media_item_id from track_fact f
    where ${verifiedFact} and f.key_camelot = ${camelot}`
}

/** Browse values for facets and search: each track's verified key. */
export function verifiedTrackKeyRows(visible: SQL) {
  return sql`select media_item.id, f.key_camelot as value from media_item
    join track_fact f on f.media_item_id = media_item.id
    where ${visible} and ${verifiedFact} and f.key_camelot is not null`
}

/** Every provider's tempo and key for a track, verified records first. */
export const trackFactsExpression = (mediaItemId: SQL) => sql`
  coalesce((select jsonb_agg(jsonb_build_object(
      'provider', f.provider, 'bpm', f.bpm, 'keyCamelot', f.key_camelot,
      'keyMusical', f.key_musical, 'keyOpen', f.key_open, 'verified', f.verified,
      'fetchedAt', to_char(f.fetched_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      order by f.verified desc, f.provider)
    from track_fact f
    where f.media_item_id = ${mediaItemId}
      and (f.bpm is not null or f.key_camelot is not null)), '[]'::jsonb)`
