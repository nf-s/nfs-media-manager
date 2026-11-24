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
  libraryCredits: z.tuple([LocalBilling]),
})

type Billing = z.infer<typeof Billing>
type SpotifyCredit = {
  title: string
  durationSec: number
  artist: Billing
  owner?: string
  searchDurationBounds?: [number, number] | null
}
type RecordingClaims = {
  tracks: Set<string>
  credits: SpotifyCredit[]
  blocked: boolean
}

function tidalCredit(item: TidalSuggestion) {
  const code = validIsrc(item.code)
  const artist = item.artistCredits?.[0]
  return code &&
    artist &&
    item.artistCredits?.length === 1 &&
    item.artists.length === 1 &&
    item.artists[0] === artist.name &&
    item.durationSec !== null
    ? {
        code,
        artist,
        title: tidalSuggestionTitle(item),
        durationSec: item.durationSec,
      }
    : undefined
}

function spotifyCredit(
  row: z.infer<typeof EvidenceRows>[number],
): SpotifyCredit | undefined {
  if (row.blocked) return
  if (row.local) {
    const recording = LocalRecording.safeParse(row.payload).data
    const artist = recording?.spotifyCredits?.[0]
    if (
      recording &&
      artist &&
      recording.spotifyCredits?.length === 1 &&
      recording.libraryCredits[0].name === artist.name &&
      recording.durationSec !== null
    )
      return {
        title: recording.title,
        durationSec: recording.durationSec,
        artist,
        owner: recording.libraryCredits[0].id,
        searchDurationBounds: recording.searchDurationBounds,
      }
    return
  }
  const recording = SpotifyCodeMatchSchema.safeParse(row.payload).data
  const artist = recording?.artistCredits?.[0]
  if (
    recording &&
    recording.spotifyId === row.spotify_id &&
    artist &&
    recording.artistCredits?.length === 1 &&
    recording.artists.length === 1 &&
    recording.artists[0] === artist.name &&
    recording.durationSec !== null
  )
    return {
      title: recording.title,
      durationSec: recording.durationSec,
      artist,
    }
}

function agrees(
  tidal: NonNullable<ReturnType<typeof tidalCredit>>,
  spotify: SpotifyCredit,
) {
  return (
    tidal.artist.name === spotify.artist.name &&
    tidal.title.toLowerCase() === spotify.title.toLowerCase() &&
    Math.abs(tidal.durationSec - spotify.durationSec) <= 2 &&
    (spotify.searchDurationBounds ?? []).every(
      (bound) => Math.abs(tidal.durationSec - bound) <= 2,
    )
  )
}

async function relatedTidalCredits(
  tx: ChangeTransaction,
  wanted: NonNullable<ReturnType<typeof tidalCredit>>[],
  spotifyIds: string[],
) {
  const { rows } = await tx.execute(sql`
    with wanted_spotify as (select jsonb_array_elements_text(${JSON.stringify(spotifyIds)}::jsonb) id),
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
    )
    select p.items from tidal_similar p where p.kind='track' and (
      exists (
        select 1 from jsonb_to_recordset(${JSON.stringify(wanted.map(({ artist }) => artist))}::jsonb) w(id text, name text)
        where p.items @> jsonb_build_array(jsonb_build_object('artistCredits',jsonb_build_array(jsonb_build_object('id',w.id))))
           or p.items @> jsonb_build_array(jsonb_build_object('artists',jsonb_build_array(w.name)))
      ) or exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(p.items)='array' then p.items else '[]'::jsonb end) item
        join related_codes r on r.code=${validIsrcSql(sql`item->>'code'`)}
      )
    )`)
  return rows.flatMap(({ items }) =>
    (z.array(z.unknown()).safeParse(items).data ?? []).flatMap((item) => {
      const parsed = TidalSuggestionSchema.safeParse(item).data
      const credit = parsed && tidalCredit(parsed)
      return credit ? [credit] : []
    }),
  )
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
      and ${trackBilling}->0->>'id' ~ '^[A-Za-z0-9]{22}$' and ${trackBilling}->1 is null
      and j.options->>'task'='spotify-track-search' and j.provider='spotify' and j.status='succeeded'
      and coalesce(j.options->>'acceptedTrackId',j.options->>'trackId')=r.media_item_id
      and j.options->>'acceptedSpotifyTrackId'=t.spotify_track_id
      and diagnostic->>'kind'='spotify-track-search' and candidate->>'spotifyTrackId'=t.spotify_track_id
      and ${validIsrcSql(sql`candidate->>'isrc'`)}=r.external_id
    having count(*)>0 and bool_and(coalesce(
      lower(candidate->>'title')=lower(m.title)
      and abs(${duration}-t.duration_sec)<=2
      and candidate->'artistCredits'=${trackBilling}
      and candidate->'artists'=jsonb_build_array(${trackBilling}->0->>'name')
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
      credits: [],
      blocked: false,
    }
    claims.tracks.add(row.spotify_id)
    claims.blocked ||= row.blocked
    const credit = spotifyCredit(row)
    if (credit) claims.credits.push(credit)
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
  const wanted = items.flatMap((item) => tidalCredit(item) ?? [])
  if (!wanted.length) return []
  const codes = new Set(wanted.map(({ code }) => code))
  const byCode = await readSpotifyClaims(tx, [...codes])
  const spotifyIds = new Set<string>()
  const candidates = wanted.filter((t) => {
    const claims = byCode.get(t.code)
    if (!claims || claims.blocked || claims.tracks.size !== 1) return false
    const matches = claims.credits.filter((s) => agrees(t, s))
    for (const match of matches) spotifyIds.add(match.artist.id)
    return matches.length > 0
  })
  if (!candidates.length) return []
  const related = includesStoredItems
    ? []
    : await relatedTidalCredits(tx, candidates, [...spotifyIds])
  const otherCodes = [
    ...new Set(
      related.map(({ code }) => code).filter((code) => !codes.has(code)),
    ),
  ]
  for (const [code, claims] of await readSpotifyClaims(tx, otherCodes))
    byCode.set(code, claims)

  const tidalToSpotify = new Map<string, Set<string>>()
  const spotifyToTidal = new Map<string, Set<string>>()
  for (const t of [...wanted, ...related])
    for (const s of byCode.get(t.code)?.credits ?? [])
      if (agrees(t, s)) {
        addMapping(tidalToSpotify, t.artist.id, s.artist.id)
        addMapping(spotifyToTidal, s.artist.id, t.artist.id)
      }

  const pairs = new Map<
    string,
    { tidalId: string; spotifyId: string; owners: Set<string> }
  >()
  for (const t of candidates) {
    const claims = byCode.get(t.code)
    if (!claims || claims.blocked || claims.tracks.size !== 1) continue
    const credits = claims.credits.filter((s) => agrees(t, s))
    const [credit] = credits
    if (
      !credit ||
      claims.credits.some((s) => s.artist.id !== credit.artist.id) ||
      tidalToSpotify.get(t.artist.id)?.size !== 1 ||
      spotifyToTidal.get(credit.artist.id)?.size !== 1
    )
      continue
    const pair = pairs.get(t.artist.id) ?? {
      tidalId: t.artist.id,
      spotifyId: credit.artist.id,
      owners: new Set<string>(),
    }
    for (const { owner } of credits) if (owner) pair.owners.add(owner)
    pairs.set(t.artist.id, pair)
  }
  return [...pairs.values()].flatMap(({ tidalId, spotifyId, owners }) =>
    owners.size <= 1
      ? [{ tidalId, spotifyId, owner: owners.values().next().value }]
      : [],
  )
}
