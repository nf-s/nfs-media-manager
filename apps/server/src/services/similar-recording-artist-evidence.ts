import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SpotifyCodeMatchSchema,
  TidalSuggestionSchema,
  tidalSuggestionTitle,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { validIsrc, validIsrcSql } from '@/lib/isrc'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import type { ChangeTransaction } from './library-change-effect'
import {
  matchRecordingArtistBilling,
  recordingCreditName,
  sharedRecordingBilling,
} from './recording-artist-billing'
import { parseStoredTrackSimilarReceipt } from './stored-tidal-similar-pages'
import { spotifyRecordingSources } from './track-isrcs'

const Billing = z.object({ id: SpotifyIdSchema, name: z.string().min(1) })
const LocalBilling = Billing.extend({ id: z.string().min(1) })
const EvidenceRows = z.array(
  z.object({
    code: z.string(),
    spotify_id: SpotifyIdSchema,
    local: z.boolean(),
    blocked: z.boolean(),
    payload: z.unknown(),
  }),
)
const LocalRecording = z.object({
  title: z.string(),
  durationSec: z.number().int().nonnegative().nullable(),
  searchDurationBounds: z.tuple([z.number(), z.number()]).nullish(),
  spotifyCredits: z.array(Billing).nullish(),
  spotifyBilling: z.array(Billing).nullish(),
  libraryCredits: z.array(LocalBilling),
})

type Billing = z.infer<typeof Billing>
type RecordingBilling = {
  title: string
  durationSec: number
  artists: Billing[]
}
type SpotifyRecording = RecordingBilling & {
  owners?: Map<string, string>
  searchDurationBounds?: [number, number] | null
}
type TidalRecording = RecordingBilling & {
  code: string
  item: TidalSuggestion
}
type RecordingClaims = {
  tracks: Set<string>
  billings: SpotifyRecording[]
  blocked: boolean
}

function completeBilling(names: string[], credits: Billing[]) {
  return (
    names.length > 0 &&
    names.length === credits.length &&
    credits.every(({ name }, index) => name === names[index])
  )
}

function tidalRecording(item: TidalSuggestion): TidalRecording | undefined {
  const code = validIsrc(item.code)
  const artists = item.artistCredits
  return code &&
    artists &&
    completeBilling(item.artists, artists) &&
    item.durationSec !== null
    ? {
        code,
        artists,
        item,
        title: tidalSuggestionTitle(item),
        durationSec: item.durationSec,
      }
    : undefined
}

function spotifyRecording(
  row: z.infer<typeof EvidenceRows>[number],
): SpotifyRecording | undefined {
  if (row.blocked) return
  if (row.local) {
    const recording = LocalRecording.safeParse(row.payload).data
    if (!recording?.spotifyCredits || recording.durationSec === null) return
    const { libraryCredits, spotifyBilling, spotifyCredits } = recording
    if (
      spotifyBilling &&
      (spotifyBilling.length !== spotifyCredits.length ||
        spotifyBilling.some(
          ({ id, name }, index) =>
            id !== spotifyCredits[index]?.id ||
            name !== spotifyCredits[index]?.name,
        ))
    )
      return
    const groups = sharedRecordingBilling(libraryCredits, spotifyCredits)
    if (!groups.length) return
    const owners = new Map<string, string>()
    for (const { leftIds, rightIds } of groups) {
      const [owner] = leftIds
      const [native] = rightIds
      if (leftIds.length === 1 && owner && native) owners.set(native, owner)
    }
    return {
      title: recording.title,
      durationSec: recording.durationSec,
      artists: spotifyCredits,
      owners,
      searchDurationBounds: recording.searchDurationBounds,
    }
  }
  const recording = SpotifyCodeMatchSchema.safeParse(row.payload).data
  const artists = recording?.artistCredits
  if (
    recording &&
    recording.spotifyId === row.spotify_id &&
    artists &&
    completeBilling(recording.artists, artists) &&
    recording.durationSec !== null
  )
    return {
      title: recording.title,
      durationSec: recording.durationSec,
      artists,
    }
}

function sameRecording(tidal: TidalRecording, spotify: SpotifyRecording) {
  return (
    tidal.title.toLowerCase() === spotify.title.toLowerCase() &&
    Math.abs(tidal.durationSec - spotify.durationSec) <= 2 &&
    (spotify.searchDurationBounds ?? []).every(
      (bound) => Math.abs(tidal.durationSec - bound) <= 2,
    )
  )
}

async function relatedTidalRecordings(
  tx: ChangeTransaction,
  wanted: TidalRecording[],
  spotifyIds: string[],
) {
  const tidalArtists = wanted.flatMap(({ artists }) =>
    artists.map(({ id, name }) => ({ id, name: recordingCreditName(name) })),
  )
  const codes = [...new Set(wanted.map(({ code }) => code))]
  const receiptBody = sql`r.body->>'text'`
  // Match the track identifiers returned in data. Included resources can
  // contain tracks that the provider did not recommend on this page.
  const { rows } = await tx.execute(sql`
    with wanted_tidal as (
      select distinct id, name
      from jsonb_to_recordset(${JSON.stringify(tidalArtists)}::jsonb) as wanted(id text, name text)
    ), wanted_spotify as (
      select jsonb_array_elements_text(${JSON.stringify(spotifyIds)}::jsonb) id
    ),
    spotify_owners as (
      select coalesce(a.merged_into_id,a.id) id from artist a
      join wanted_spotify w on w.id=a.catalog_external_id where a.catalog_provider='spotify'
      union
      select coalesce(a.merged_into_id,a.id) id from artist_provider_current_state s
      join artist a on a.id=s.artist_id
      join artist_provider_snapshot p on p.id=s.latest_snapshot_id and p.artist_id=s.artist_id and p.provider=s.provider
      join wanted_spotify w on w.id=p.normalized_data->>'externalId' where s.provider='spotify'
    ), related_codes as materialized (
      select l.code from spotify_code_lookup l join wanted_spotify w
        on l.result->'artistCredits' @> jsonb_build_array(jsonb_build_object('id',w.id))
        where l.source='spotify' and l.code_type='isrc'
      union
      select r.external_id from spotify_owners owner
      join media_credit c on c.artist_id=owner.id and c.role='artist'
      join provider_reference r on r.media_item_id=c.media_item_id and r.provider='spotify' and r.reference_type='isrc'
      union
      select jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb)
    )
    select item, null::text as request_url, null::jsonb as document
    from tidal_similar p cross join lateral jsonb_path_query(p.items, '$[*]') item
    where p.kind='track' and jsonb_typeof(p.items)='array' and (
      exists (select 1 from related_codes c where c.code=${validIsrcSql(sql`item->>'code'`)})
      or exists (
        select 1 from wanted_tidal w
        where item->'artistCredits' @> jsonb_build_array(jsonb_build_object('id',w.id))
           or exists (
             select 1 from jsonb_path_query(item, '$.artists[*]') name
             where lower(btrim(name #>> '{}'))=w.name
           )
      )
    )
    union all
    select null, r.request_url, receipt.document
    from scrape_job j join provider_response r on r.job_id=j.id
    cross join lateral (
      select case when pg_input_is_valid(${receiptBody}, 'jsonb')
        then (${receiptBody})::jsonb end as document
      offset 0
    ) receipt
    where j.options->>'task'='tidal-similar' and j.status='succeeded'
      and j.options->>'itemId' is not null and r.provider='tidal'
      and r.status=200 and r.body_state='captured'
      and r.request_url ~ '/tracks/[0-9]+/relationships/similarTracks$'
      and exists (
        select 1 from jsonb_path_query(receipt.document, '$.included[*]') track
        where track->>'type'='tracks'
          and receipt.document->'data' @> jsonb_build_array(jsonb_build_object('id',track->>'id'))
          and (
            exists (select 1 from related_codes c
              where c.code=${validIsrcSql(sql`track #>> '{attributes,isrc}'`)})
            or exists (
              select 1 from jsonb_path_query(track, '$.relationships.artists.data[*]') credit
              join wanted_tidal w on w.id=credit->>'id'
            )
            or exists (
              select 1 from jsonb_path_query(receipt.document, '$.included[*]') billed
              join wanted_tidal w on lower(btrim(billed #>> '{attributes,name}'))=w.name
              where billed->>'type'='artists' and track #> '{relationships,artists,data}'
                @> jsonb_build_array(jsonb_build_object('id',billed->>'id'))
            )
          )
      )`)
  return rows.flatMap(({ item, request_url, document }) => {
    if (typeof request_url === 'string')
      return (
        parseStoredTrackSimilarReceipt(request_url, document) ?? []
      ).flatMap((suggestion) => tidalRecording(suggestion) ?? [])
    const suggestion = TidalSuggestionSchema.safeParse(item).data
    return suggestion ? (tidalRecording(suggestion) ?? []) : []
  })
}

function addMapping(map: Map<string, Set<string>>, from: string, to: string) {
  const ids = map.get(from) ?? new Set<string>()
  ids.add(to)
  map.set(from, ids)
}

/** Recover provenance through the retained-search and log job indexes for this library track. */
function retainedSpotifySearchDurations() {
  const duration = sql`case when candidate->>'durationSec' ~ '^[0-9]{1,10}$'
    then (candidate->>'durationSec')::numeric end`
  const trackBilling = sql`m.metadata->'spotifyArtistCredits'`
  const billedNames = sql`(select jsonb_agg(credit->>'name' order by ordinal)
    from jsonb_array_elements(case when jsonb_typeof(${trackBilling})='array'
      then ${trackBilling} else '[]'::jsonb end) with ordinality as bill(credit,ordinal))`
  return sql`
    select jsonb_build_array(min(${duration}),max(${duration})) as bounds
    from scrape_job j
    join scrape_job_log l on l.job_id=j.id and l.metadata ? 'diagnostics'
    cross join lateral jsonb_array_elements(case when jsonb_typeof(l.metadata->'diagnostics')='array'
      then l.metadata->'diagnostics' else '[]'::jsonb end) diagnostic
    cross join lateral jsonb_array_elements(case when jsonb_typeof(diagnostic->'candidates')='array'
      then diagnostic->'candidates' else '[]'::jsonb end) candidate
    where r.metadata->>'source'='library-track' and t.duration_sec is not null
      and r.metadata->>'rejected' is distinct from 'true' and r.metadata->>'verified' is distinct from 'false'
      and ${trackBilling}->0->>'id' ~ '^[A-Za-z0-9]{22}$'
      and j.options->>'task'='spotify-track-search' and j.provider='spotify' and j.status='succeeded'
      and coalesce(j.options->>'acceptedTrackId',j.options->>'trackId')=r.media_item_id
      and j.options->>'acceptedSpotifyTrackId'=t.spotify_track_id
      and diagnostic->>'kind'='spotify-track-search' and candidate->>'spotifyTrackId'=t.spotify_track_id
      and ${validIsrcSql(sql`candidate->>'isrc'`)}=r.external_id
    having count(*)>0 and bool_and(coalesce(
      lower(candidate->>'title')=lower(m.title)
      and abs(${duration}-t.duration_sec)<=2
      and candidate->'artistCredits'=${trackBilling}
      and candidate->'artists'=${billedNames}
      and (not candidate ? 'artistBilling' or candidate->'artistBilling'=${trackBilling}),false
    ))`
}

async function readSpotifyClaims(tx: ChangeTransaction, codes: string[]) {
  const byCode = new Map<string, RecordingClaims>()
  if (!codes.length) return byCode
  const { rows } = await tx.execute(sql`
    with codes as (select jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb) code)
    select l.code, l.spotify_id, false as local, false as blocked, l.result as payload
    from codes join spotify_code_lookup l using (code)
    where l.source='spotify' and l.code_type='isrc' and l.spotify_id ~ '^[A-Za-z0-9]{22}$'
    union all
    select r.external_id, t.spotify_track_id, true,
      coalesce(r.metadata->>'rejected'='true',false) or coalesce(r.metadata->>'verified'='false',false),
      jsonb_build_object('title',m.title,'durationSec',t.duration_sec,
        'searchDurationBounds',saved_search.bounds,
        'spotifyCredits',m.metadata->'spotifyArtistCredits',
        'spotifyBilling',m.metadata->'spotifyArtistBilling',
        'libraryCredits', (
          select jsonb_agg(jsonb_build_object('id',a.id,'name',coalesce(c.credited_as,a.name)))
          from media_credit c join artist a on a.id=c.artist_id
          where c.media_item_id=m.id and c.role='artist'
        ))
    from codes join provider_reference r on r.external_id=codes.code and r.reference_type='isrc' and r.provider='spotify'
    join library_track t on t.media_item_id=r.media_item_id and t.spotify_track_id ~ '^[A-Za-z0-9]{22}$'
    join media_item m on m.id=t.media_item_id and m.in_library and m.metadata->>'legacyHidden' is distinct from 'true'
    left join lateral (${retainedSpotifySearchDurations()}) saved_search on true
    where r.metadata->>'source' in (select jsonb_array_elements_text(${JSON.stringify(spotifyRecordingSources)}::jsonb))
      or saved_search.bounds is not null
      or r.metadata->>'rejected'='true' or r.metadata->>'verified'='false'`)
  for (const row of EvidenceRows.parse(rows)) {
    const claims = byCode.get(row.code) ?? {
      tracks: new Set<string>(),
      billings: [],
      blocked: false,
    }
    claims.tracks.add(row.spotify_id)
    claims.blocked ||= row.blocked
    const recording = spotifyRecording(row)
    if (recording) claims.billings.push(recording)
    byCode.set(row.code, claims)
  }
  return byCode
}

/** Find one-to-one artist mappings across the same first-party recordings in both catalogs. */
export async function similarRecordingArtistEvidence(
  tx: ChangeTransaction,
  items: readonly TidalSuggestion[],
  includesStoredItems: boolean,
) {
  const wanted = items.flatMap((item) => tidalRecording(item) ?? [])
  if (!wanted.length) return []
  const codes = new Set(wanted.map(({ code }) => code))
  const byCode = await readSpotifyClaims(tx, [...codes])
  const spotifyIds = new Set<string>()
  const candidates = new Map<
    TidalRecording,
    ReturnType<typeof matchRecordingArtistBilling>
  >()
  for (const tidal of wanted) {
    const claims = byCode.get(tidal.code)
    if (!claims || claims.blocked || claims.tracks.size !== 1) continue
    const pairs = claims.billings.flatMap((spotify) =>
      sameRecording(tidal, spotify)
        ? matchRecordingArtistBilling(tidal.artists, spotify.artists)
        : [],
    )
    if (!pairs.length) continue
    for (const pair of pairs) spotifyIds.add(pair.spotifyId)
    candidates.set(tidal, pairs)
  }
  if (!candidates.size) return []
  const related = includesStoredItems
    ? []
    : await relatedTidalRecordings(tx, [...candidates.keys()], [...spotifyIds])
  const otherCodes = [
    ...new Set(
      related.map(({ code }) => code).filter((code) => !codes.has(code)),
    ),
  ]
  for (const [code, claims] of await readSpotifyClaims(tx, otherCodes))
    byCode.set(code, claims)

  const tidalToSpotify = new Map<string, Set<string>>()
  const spotifyToTidal = new Map<string, Set<string>>()
  for (const tidal of [...wanted, ...related])
    for (const spotify of byCode.get(tidal.code)?.billings ?? []) {
      if (!sameRecording(tidal, spotify)) continue
      // An ambiguous bill can rule out a pair, but only unique names can prove it.
      for (const { leftIds, rightIds } of sharedRecordingBilling(
        tidal.artists,
        spotify.artists,
      )) {
        for (const tidalId of leftIds)
          for (const spotifyId of rightIds) {
            addMapping(tidalToSpotify, tidalId, spotifyId)
            addMapping(spotifyToTidal, spotifyId, tidalId)
          }
      }
    }

  const pairs = new Map<
    string,
    {
      tidalId: string
      spotifyId: string
      owners: Set<string>
      suggestions: Set<TidalSuggestion>
    }
  >()
  for (const [tidal, matches] of candidates) {
    const claims = byCode.get(tidal.code)
    if (!claims) continue
    for (const { tidalId, spotifyId, name } of matches) {
      if (
        tidalToSpotify.get(tidalId)?.size !== 1 ||
        spotifyToTidal.get(spotifyId)?.size !== 1 ||
        claims.billings.some(({ artists }) => {
          const [first, second] = artists.filter(
            (credit) =>
              recordingCreditName(credit.name) === recordingCreditName(name),
          )
          return first?.id !== spotifyId || second !== undefined
        })
      )
        continue
      const pair = pairs.get(tidalId) ?? {
        tidalId,
        spotifyId,
        owners: new Set<string>(),
        suggestions: new Set<TidalSuggestion>(),
      }
      for (const { owners } of claims.billings) {
        const owner = owners?.get(spotifyId)
        if (owner) pair.owners.add(owner)
      }
      pair.suggestions.add(tidal.item)
      pairs.set(tidalId, pair)
    }
  }
  return [...pairs.values()].flatMap(
    ({ tidalId, spotifyId, owners, suggestions }) =>
      owners.size <= 1
        ? [
            {
              tidalId,
              spotifyId,
              owner: owners.values().next().value,
              suggestions,
            },
          ]
        : [],
  )
}
