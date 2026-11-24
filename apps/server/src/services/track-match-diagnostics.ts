import { SONOVAULT_TRACK_LOOKUP_TASK } from '@repo/schemas/sonovault'
import { inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  BrowseFacetQuerySchema,
  trackBrowseFields,
  type BrowseFacetQuery,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  MatchDiagnosticsPageSchema,
  MatchDiagnosticsRowSchema,
  trackMatchDiagnosticFields,
  trackMatchProviderLabels,
  type TrackMatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { trackSpotifyMatchLabels } from '@repo/schemas/tracks'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import type { ProviderFreshnessFilter } from '@repo/schemas/film-selection'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { TIDAL_TRACK_MATCH_TASK } from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  browseFacetRows,
  listBrowseFacets,
  trackBrowseFieldConditions,
  trackBrowseOrder,
  trackBrowseSearchIds,
} from './browse'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { artistTagLabels } from './music-tags'
import {
  playableSpotifyId,
  spotifyAlternates,
  spotifyAlternateValue,
} from './recording-groups'
import { loadTracks } from './tracks'
import {
  trackDuplicateCautions,
  trackDuplicateMembership,
  trackDuplicateOrder,
  trackDuplicatePosition,
} from './track-duplicate-refresh'
import { trackSpotifyMatchExpression } from './track-values'
import { createBrowseListening } from './browse-listening'
import { catalogScopeCondition } from './catalog-scope'

const providers = [
  { key: 'spotify', label: trackMatchProviderLabels.spotify },
  { key: 'lastfm', label: trackMatchProviderLabels.lastfm },
  { key: 'discogs', label: trackMatchProviderLabels.discogs },
]

type EvidenceProvider = 'spotify' | 'lastfm' | 'discogs'
const allEvidenceProviders = new Set(providers.map((provider) => provider.key))
const evidenceFields = new Map<
  string,
  { provider: EvidenceProvider; value: SQL }
>([
  ['spotifyName', { provider: 'spotify', value: sql`e.name` }],
  ['spotifyArtist', { provider: 'spotify', value: sql`e.creator` }],
  ['spotifyId', { provider: 'spotify', value: sql`e.identifier` }],
  ['lastfmName', { provider: 'lastfm', value: sql`e.name` }],
  ['lastfmArtist', { provider: 'lastfm', value: sql`e.creator` }],
  ['lastfmId', { provider: 'lastfm', value: sql`e.identifier` }],
  ['discogsName', { provider: 'discogs', value: sql`e.name` }],
  ['discogsArtist', { provider: 'discogs', value: sql`e.creator` }],
])

function lastfmTrackGroups(id: SQL) {
  return sql`
    select username, artist_key, track_key from lastfm_track_link where track_media_item_id = ${id}
    union
    select username, artist_key, track_key from lastfm_track_source where track_media_item_id = ${id}
  `
}

/** Read provider names from the import or saved response that supplied them. */
function trackEvidence(scope: SQL, selected: Set<string>) {
  const sources: SQL[] = []
  if (selected.has('spotify'))
    sources.push(sql`
    select r.id, 'spotify'::text as provider,
      case when r.catalog is not null then r.catalog->>'title' when r.source_label = 'spotify' then r.name else entry->>'title' end as name,
      case when r.catalog is not null then
        (select string_agg(a.name, ', ' order by a.position) from jsonb_array_elements_text(r.catalog->'artists') with ordinality a(name, position))
      when r.source_label = 'spotify' then r.creator
      else
        (select string_agg(credit #>> '{}', ', ' order by ord)
         from jsonb_path_query(entry, '$.artists[*] ? (@.type() == "string")')
           with ordinality as artists(credit, ord)) end as creator,
      r.spotify_track_id as identifier, null::text as artist_key, null::text as track_key, null::text as album_id
    from ${scope} r
    left join lateral (
      select e.entry from track t
      join provider_current_state p on p.media_item_id = t.album_media_item_id and p.provider = 'spotify' and p.status = 'ready'
      left join lateral (
        select saved.normalized_data from provider_snapshot saved
        where saved.media_item_id = p.media_item_id and saved.provider = 'spotify'
          and not coalesce(jsonb_path_exists(p.normalized_data, '$.tracks[*].externalId ? (@.type() == "string")'), false)
          and jsonb_path_exists(saved.normalized_data, '$.tracks[*].externalId ? (@.type() == "string")')
        order by saved.created_at desc, saved.id desc limit 1
      ) history on true
      cross join lateral jsonb_path_query(coalesce(history.normalized_data, p.normalized_data), '$.tracks[*] ? (@.externalId == $id)',
        jsonb_build_object('id', r.spotify_track_id)) as e(entry)
      where t.track_media_item_id = r.id
        and r.source_label is distinct from 'spotify' and r.catalog is null
    ) spotify on true
    where r.spotify_track_id is not null
    `)
  if (selected.has('lastfm'))
    sources.push(sql`
    select r.id, 'lastfm'::text as provider, s.track_name as name, s.artist_name as creator,
      nullif(s.track_mbid, '') as identifier, s.artist_key, s.track_key, null::text as album_id
    from ${scope} r join lateral (${lastfmTrackGroups(sql`r.id`)}) l on true
    join lateral (
      select distinct artist_name, track_name, track_mbid, artist_key, track_key
      from lastfm_scrobble s
      where s.username = l.username and s.artist_key = l.artist_key and s.track_key = l.track_key
    ) s on true
    `)
  if (selected.has('discogs'))
    sources.push(sql`
    select r.id, 'discogs'::text as provider, d.entry->>'title' as name,
      (select string_agg(a.credit->>'name', ', ' order by a.ord)
       from jsonb_path_query(d.entry, '$.artists[*] ? (@.name.type() == "string")')
         with ordinality a(credit, ord)) as creator, null::text as identifier,
      null::text as artist_key, null::text as track_key, t.album_media_item_id as album_id
    from ${scope} r join track t on t.track_media_item_id = r.id
    join provider_current_state p on p.media_item_id = t.album_media_item_id and p.provider = 'discogs' and p.status = 'ready'
    cross join lateral jsonb_path_query(coalesce(p.payload->'master', p.payload->'release', p.payload),
      '$.tracklist[*] ? (@.type_ == "track")') with ordinality as d(entry, position)
    where d.position = t.position and jsonb_typeof(d.entry->'title') = 'string'
    `)
  return sql.join(sources, sql` union `)
}

const trackId = sql`media_item.id`
const trackAlbumName = sql`coalesce(library_track.album_name, track_sort_album.title)`
const trackCreator = sql`(select string_agg(a.name, ', ' order by c.billing_order, a.name)
  from media_credit c join artist a on a.id = c.artist_id
  where c.media_item_id = media_item.id and c.role = 'artist')`
const records = sql`select media_item.id, media_item.title as name, media_item.source_label,
  library_track.spotify_track_id, media_item.metadata->'spotifyTrackSearch' as catalog, ${trackAlbumName} as album_name, ${trackCreator} as creator`
// The album alias is also used by the shared Tracks Browse ordering.
const trackTables = sql`from media_item join library_track on library_track.media_item_id = media_item.id
  left join media_item track_sort_album on track_sort_album.id = library_track.album_media_item_id`
const visibleTracks = sql`media_item.media_type = 'track'
  and media_item.metadata->>'legacyHidden' is distinct from 'true'`
const visibleLibraryTracks = sql`${visibleTracks} and media_item.in_library`
const trackBrowseFieldKeys = new Set(
  trackBrowseFields.map((field) => field.key),
)
const ordinaryFields = trackMatchDiagnosticFields.filter((field) =>
  trackBrowseFieldKeys.has(field.key),
)
const diagnosticFields = trackMatchDiagnosticFields.filter(
  (field) => !trackBrowseFieldKeys.has(field.key),
)

function playabilityCondition(
  playability: TrackMatchDiagnosticsQuery['playability'],
) {
  const direct = playableSpotifyId(sql`library_track.spotify_track_id`)
  const alternate = sql`coverage.id is not null`
  switch (playability) {
    case 'direct':
      return direct
    case 'alternate':
      return alternate
    case 'playable':
      return sql`(${direct} or ${alternate})`
    case 'unavailable':
      return sql`not (${direct} or ${alternate})`
  }
}

/** Apply the worklist's recording coverage rules again when queuing or accepting a search. */
export async function listTracksNeedingSpotifyMatch(
  database: Pick<typeof db, 'execute'>,
  trackIds: string[],
): Promise<string[]> {
  if (!trackIds.length) return []
  const result = await database.execute(sql`
    with targets as materialized (
      select media_item.id, media_item.source_label, library_track.spotify_track_id
      ${trackTables} where ${visibleTracks} and ${inArray(trackId, trackIds)}
    ), ${spotifyAlternates(sql`select * from targets`, { useTargetTitles: true })}
    select targets.id from targets left join spotify_alternates coverage using (id)
    where not ${playableSpotifyId(sql`targets.spotify_track_id`)} and coverage.id is null`)
  return z
    .array(z.object({ id: z.string() }))
    .parse(result.rows)
    .map((row) => row.id)
}

function presenceValues(spotify: SQL, lastfm: SQL, discogs: SQL) {
  return [
    { value: trackMatchProviderLabels.spotify, test: spotify },
    { value: trackMatchProviderLabels.lastfm, test: lastfm },
    { value: trackMatchProviderLabels.discogs, test: discogs },
    {
      value: trackMatchProviderLabels.noRecording,
      test: sql`not (${spotify} or ${lastfm})`,
    },
    {
      value: trackMatchProviderLabels.noEvidence,
      test: sql`not (${spotify} or ${lastfm} or ${discogs})`,
    },
  ]
}

function providerValues() {
  const labels = presenceValues(
    sql`r.spotify_track_id is not null`,
    sql`coalesce(m.lastfm, false)`,
    sql`coalesce(m.discogs, false)`,
  )
  return sql`select r.id, p.value from records r
    left join (
      select id, bool_or(provider = 'lastfm') as lastfm,
        bool_or(provider = 'discogs') as discogs from evidence group by id
    ) m on m.id = r.id
    cross join lateral (values ${sql.join(
      labels.map(({ value, test }) => sql`(${value}::text, ${test})`),
      sql`, `,
    )}) p(value, present)
    where p.present`
}

function evidenceValues(field: string) {
  if (field === 'matchProvider') return providerValues()
  const column = evidenceFields.get(field)
  if (column)
    return sql`select e.id, ${column.value} as value from evidence e
      where e.provider = ${column.provider}`
  return sql`select e.id, coalesce(e.name, e.identifier) as value from evidence e
    where e.provider = ${field}
    ${field === 'spotify' ? sql`union all select id, name as value from spotify_alternates` : sql``}`
}

function evidenceFilter(filter: BrowseFilter) {
  if (filter.field === 'spotifyId')
    return sql`coalesce(lower(library_track.spotify_track_id) = lower(${filter.value}::text), false)`
  if (filter.field === 'matchProvider') {
    const values = presenceValues(
      sql`library_track.spotify_track_id is not null`,
      sql`exists (select 1 from (${lastfmTrackGroups(trackId)}) l
        join lastfm_scrobble s using (username, artist_key, track_key))`,
      sql`media_item.id in (select id from evidence where provider = 'discogs')`,
    )
    return (
      values.find(
        ({ value }) => value.toLowerCase() === filter.value.toLowerCase(),
      )?.test ?? sql`false`
    )
  }
  const column = evidenceFields.get(filter.field)
  if (!column) return
  return sql`media_item.id in (select e.id from evidence e
    where e.provider = ${column.provider} and lower(${column.value}) = lower(${filter.value}::text))`
}

function pageMatchEvidence(reuseEvidence: boolean) {
  return sql`select e.id, jsonb_agg(jsonb_build_object('provider', e.provider, 'name', e.name,
        'creator', e.creator, 'identifier', e.identifier) ||
        case when e.provider = 'lastfm' then jsonb_build_object('artistKey', e.artist_key, 'trackKey', e.track_key)
        when e.album_id is not null then jsonb_build_object('albumId', e.album_id)
        else '{}'::jsonb end order by e.provider, e.name, e.creator, e.identifier, e.album_id) as matches
      from ${reuseEvidence ? sql`evidence` : sql`(${trackEvidence(sql`page`, allEvidenceProviders)})`} e
      join page p on p.id = e.id group by e.id`
}

const pageMergeSourceId = sql`(select min(source_id) from (
          select s.track_media_item_id as source_id from lastfm_track_source s where s.track_media_item_id = p.id
          union
          select s.track_media_item_id from lastfm_track_link l join lastfm_track_source s
            using (username, artist_key, track_key) where l.track_media_item_id = p.id
        ) ids join media_item source on source.id = ids.source_id
        where coalesce(source.source_label,'') not in ('spotify','spotify-search') and source.metadata->>'legacyHidden' is distinct from 'true'
          and (ids.source_id = p.id or (p.source_label in ('spotify','spotify-search') and p.spotify_track_id is not null))
        having count(*) = 1)`

const spotifyCoverageOrder = sql`case
  when ${playableSpotifyId(sql`library_track.spotify_track_id`)} then
    ${trackSpotifyMatchExpression(sql`library_track.spotify_track_id`, sql`media_item.source_label`, true)}
  when coverage.id is not null then 'Other Spotify version'
  else ${trackSpotifyMatchLabels.unmatched}::text end`

type DiagnosticsQuery = Omit<TrackMatchDiagnosticsQuery, 'filters' | 'ranges'> &
  Partial<Pick<TrackMatchDiagnosticsQuery, 'filters' | 'ranges'>>

/** Each provider's job history, as joined to the Matches rows. */
const freshnessHistories = {
  spotify: sql.raw('search_history'),
  tidal: sql.raw('tidal_history'),
  sonovault: sql.raw('sonovault_history'),
}
type FreshnessProvider = keyof typeof freshnessHistories

/** Any selected status of a provider's history. */
function providerFreshness(filters: ProviderFreshnessFilter[], history: SQL) {
  if (!filters.length || filters.some((filter) => filter.mode === 'all')) return
  const modes = filters.map((filter) => {
    switch (filter.mode) {
      case 'never':
        return sql`${history}.latest_attempt_status is null`
      case 'failed':
        return sql`${history}.latest_attempt_status = 'failed'`
      case 'older':
        return sql`(${history}.last_success is null or ${history}.last_success < ${new Date(Date.now() - filter.olderThanDays * 86_400_000).toISOString()}::timestamp)`
      case 'unscraped':
        return sql`${history}.last_success is null`
      case 'all':
        return sql`true`
    }
  })
  return sql`(${sql.join(modes, sql` or `)})`
}

/** Every filtered provider, each by any of its selected statuses. */
function searchFreshness(filters: ProviderFreshnessFilter[]) {
  const providers = new Map<FreshnessProvider, SQL>()
  for (const provider of ['spotify', 'tidal', 'sonovault'] as const) {
    const condition = providerFreshness(
      filters.filter((filter) => filter.provider === provider),
      freshnessHistories[provider],
    )
    if (condition) providers.set(provider, condition)
  }
  return providers.size
    ? {
        providers: new Set(providers.keys()),
        condition: sql`(${sql.join([...providers.values()], sql` and `)})`,
      }
    : undefined
}

export function spotifySearchRecordingId(options: SQL) {
  return sql<string>`coalesce(${options}->>'acceptedTrackId', ${options}->>'trackId')`
}

/** The last attempt and last success of each track's TIDAL match jobs. */
function tidalTrackMatchHistory() {
  const recordingId = sql`options->>'trackId'`
  return sql`
    select ${recordingId} as id,
      max(finished_at) filter (where status = 'succeeded' and options ? 'reason') as last_success,
      (array_agg(status order by started_at desc, created_at desc, id desc))[1] as latest_attempt_status
    from scrape_job where provider = 'tidal'
      and options->>'task' = ${sql.raw(`'${TIDAL_TRACK_MATCH_TASK}'`)}
      and started_at is not null and (status <> 'succeeded' or options ? 'reason')
    group by ${recordingId}`
}

/**
 * Each track's last Sonovault lookup (a match or a miss counts as a lookup)
 * and the status of the latest lookup job that held it.
 */
function sonovaultLookupHistory() {
  return sql`
    select coalesce(lookups.media_item_id, attempts.id) as id,
      lookups.looked_up_at as last_success,
      attempts.latest_attempt_status
    from sonovault_track_lookup lookups
    full join (
      select t.id,
        (array_agg(j.status order by j.started_at desc, j.created_at desc, j.id desc))[1] as latest_attempt_status
      from scrape_job j cross join jsonb_array_elements_text(j.options->'trackIds') as t(id)
      where j.provider = 'sonovault'
        and j.options->>'task' = ${sql.raw(`'${SONOVAULT_TRACK_LOOKUP_TASK}'`)}
        and j.started_at is not null
      group by t.id
    ) attempts on attempts.id = lookups.media_item_id`
}

function spotifyTrackSearchHistory(userId: string | null, trackId?: string) {
  const recordingId = spotifySearchRecordingId(sql`options`)
  return sql`
    select ${recordingId} as id,
      max(finished_at) filter (where status = 'succeeded' and options ? 'resultCount') as last_success,
      (array_agg(status order by started_at desc, created_at desc, id desc))[1] as latest_attempt_status
    from scrape_job where options->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}
      and requested_by_user_id = ${userId}
      and started_at is not null and (status <> 'succeeded' or options ? 'resultCount')
      ${trackId ? sql`and ${recordingId} = ${trackId}` : sql``}
    group by ${recordingId}`
}

export async function trackMatchesSpotifySearchFreshness(
  database: Pick<typeof db, 'execute'>,
  trackId: string,
  userId: string | null,
  filters: ProviderFreshnessFilter[],
) {
  const freshness = searchFreshness(
    filters.filter((filter) => filter.provider === 'spotify'),
  )
  if (!freshness) return true
  const { rows } = await database.execute(sql`
    with search_history as (${spotifyTrackSearchHistory(userId, trackId)})
    select exists (
      select 1 from (values (${trackId}::text)) target(id)
      left join search_history on search_history.id = target.id
      where ${freshness.condition}
    ) as eligible`)
  return z.object({ eligible: z.boolean() }).parse(rows[0]).eligible
}

/**
 * The parts of a Matches statement that the page and the list of all its row
 * IDs share: the leading common table expressions (each followed by a comma),
 * the tables, joins and conditions of the rows, their order and the total.
 */
function trackMatchDiagnosticsRows(
  query: DiagnosticsQuery,
  userId: string | undefined,
  now: Date,
) {
  const includeEvidence = !query.view || query.view === 'providers'
  const metadata = query.view === 'spotify-search-metadata'
  const freshness = metadata
    ? searchFreshness(query.freshness ?? [])
    : undefined
  const sortBy = query.sortBy
  const usesHistory =
    metadata &&
    (freshness?.providers.has('spotify') || sortBy === 'spotifyLastSearch')
  const usesTidalHistory =
    metadata &&
    (freshness?.providers.has('tidal') || sortBy === 'tidalLastMatch')
  const usesSonovaultHistory =
    metadata &&
    (freshness?.providers.has('sonovault') || sortBy === 'sonovaultLastLookup')
  const sortsByListening = sortBy === 'listeningScrobbles'
  const listening = createBrowseListening(
    query.listening,
    sortsByListening
      ? (query.listeningSort ?? defaultListeningPeriod)
      : undefined,
    now,
  )
  const listeningSource = listening?.source('track')
  const listeningCondition = listening?.condition('track', trackId)
  const listeningJoin = listeningSource
    ? sql`left join period_counts listening_counts on listening_counts.id = ${trackId}`
    : sql``
  const historyJoin = sql`${
    usesHistory
      ? sql`left join search_history on search_history.id = ${trackId}`
      : sql``
  } ${
    usesTidalHistory
      ? sql`left join tidal_history on tidal_history.id = ${trackId}`
      : sql``
  } ${
    usesSonovaultHistory
      ? sql`left join sonovault_history on sonovault_history.id = ${trackId}`
      : sql``
  }`
  const providerSort =
    allEvidenceProviders.has(sortBy) ||
    (sortBy !== 'spotifyId' && evidenceFields.has(sortBy)) ||
    sortBy === 'matchProvider'
  const diagnosticSort = providerSort
    ? sql`provider_order.value`
    : sortBy === 'spotifyLastSearch' && metadata
      ? sql`search_history.last_success`
      : sortBy === 'tidalLastMatch' && metadata
        ? sql`tidal_history.last_success`
        : sortBy === 'sonovaultLastLookup' && metadata
          ? sql`sonovault_history.last_success`
          : listening?.sort
            ? listening.sort
            : sortBy === 'spotifyCoverage'
              ? spotifyCoverageOrder
              : sortBy === 'name'
                ? sql`lower(media_item.title)`
                : sortBy === 'creator'
                  ? sql`lower(${trackCreator})`
                  : sortBy === 'spotifyId'
                    ? sql`lower(library_track.spotify_track_id)`
                    : undefined
  const direction = query.direction === 'desc' ? sql`desc` : sql`asc`
  const ordering = diagnosticSort
    ? [
        sql`${diagnosticSort} ${direction} nulls last`,
        sql`lower(media_item.title)`,
        trackId,
      ]
    : trackBrowseOrder(sortBy, query.direction)
  if (!ordering)
    throw new ServerError({
      statusCode: 422,
      message: 'Unknown track diagnostics sort.',
    })
  // Possible duplicates: most played group first, the chosen sort within each
  // group, then the track a merge keeps.
  const order = sql.join(
    query.duplicates
      ? ordering.flatMap((part, index) =>
          index ? [part] : [trackDuplicateOrder, part, trackDuplicatePosition],
        )
      : ordering,
    sql`, `,
  )
  const filters = query.filters ?? []
  const words = [...new Set(query.q?.split(/\s+/).filter(Boolean))]
  const playability = playabilityCondition(query.playability)
  const filtersByCoverage =
    playability !== undefined && query.playability !== 'direct'
  const joinsCoverage = filtersByCoverage || sortBy === 'spotifyCoverage'
  const coverageJoin = joinsCoverage
    ? sql`left join spotify_alternates coverage on coverage.id = ${trackId}`
    : sql``
  // Display alone needs only the current page's recordings. Search, filters
  // and ordering need coverage before pagination so all rows are considered.
  const needsCoverageBeforePage =
    words.length > 0 || sortBy === 'spotify' || joinsCoverage
  const sharedArtistTags = words.length > 1
  const supportingProviders = new Set<string>()
  if ((words.length && includeEvidence) || sortBy === 'matchProvider')
    for (const provider of allEvidenceProviders)
      supportingProviders.add(provider)
  else if (providerSort)
    supportingProviders.add(evidenceFields.get(sortBy)?.provider ?? sortBy)
  for (const filter of filters) {
    const column = evidenceFields.get(filter.field)
    if (column && filter.field !== 'spotifyId')
      supportingProviders.add(column.provider)
    if (
      filter.field === 'matchProvider' &&
      [
        trackMatchProviderLabels.discogs.toLowerCase(),
        trackMatchProviderLabels.noEvidence.toLowerCase(),
      ].includes(filter.value.toLowerCase())
    )
      supportingProviders.add('discogs')
  }
  // These conditions restrict the entries being reviewed. Sibling candidates
  // can still come from any source or release.
  const sources = filters.filter(
    (filter) => filter.field === 'source' && filter.mode === 'required',
  )
  const scope = [
    metadata
      ? sql`${visibleTracks} and ${catalogScopeCondition(trackId, sql`media_item.in_library`, query, 'track')}`
      : visibleLibraryTracks,
    ...trackBrowseFieldConditions(sources, [], ordinaryFields, evidenceFilter),
  ]
  if (query.creatorId)
    scope.push(sql`exists (select 1 from media_credit c where c.media_item_id = media_item.id
        and c.role = 'artist' and c.artist_id = (
          select coalesce(a.merged_into_id, a.id) from artist a
          where a.id = ${query.creatorId}))`)
  const visibleScope = sql.join(scope, sql` and `)
  const conditions = [
    visibleScope,
    ...trackBrowseFieldConditions(
      filters.filter((filter) => !sources.includes(filter)),
      query.ranges ?? [],
      trackMatchDiagnosticFields,
      evidenceFilter,
    ),
  ]
  if (playability) conditions.push(playability)
  if (freshness) conditions.push(freshness.condition)
  if (listeningCondition) conditions.push(listeningCondition)
  if (
    query.duplicates &&
    query.duplicateCautions &&
    query.duplicateCautions !== 'all'
  )
    conditions.push(trackDuplicateCautions(query.duplicateCautions))
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(sql`media_item.id in (
      ${trackBrowseSearchIds(pattern, sharedArtistTags)}
      ${
        includeEvidence
          ? sql`union all select e.id from evidence e where
        e.name ilike ${pattern} or e.creator ilike ${pattern} or e.identifier ilike ${pattern}`
          : sql``
      }
      union all select a.id from spotify_alternates a where
        a.name ilike ${pattern} or a.album_name ilike ${pattern}
    )`)
  }
  const where = sql`where ${sql.join(conditions, sql` and `)}`
  const duplicatesJoin = query.duplicates ? trackDuplicateMembership : sql``
  const count = sql`(select count(*)::int ${trackTables} ${duplicatesJoin} ${coverageJoin} ${freshness ? historyJoin : sql``} ${listeningCondition ? listeningJoin : sql``} ${where})`
  const total =
    query.limitResults === undefined
      ? count
      : sql`least(${count}, ${query.limitResults})`
  const prelude = sql`${listeningSource ? sql`period_counts as materialized (select * from ${listeningSource}),` : sql``}
    ${
      usesHistory
        ? sql`search_history as materialized (${spotifyTrackSearchHistory(userId ?? null)}),`
        : sql``
    }
    ${
      usesTidalHistory
        ? sql`tidal_history as materialized (${tidalTrackMatchHistory()}),`
        : sql``
    }
    ${
      usesSonovaultHistory
        ? sql`sonovault_history as materialized (${sonovaultLookupHistory()}),`
        : sql``
    }
    ${sharedArtistTags ? sql`browse_artist_tag_labels as materialized (${artistTagLabels()}),` : sql``} ${
      supportingProviders.size
        ? sql`
      records as not materialized (${records} ${trackTables} where ${visibleScope}),
      evidence as materialized (${trackEvidence(sql`records`, supportingProviders)}),
    `
        : sql``
    }
    ${
      needsCoverageBeforePage
        ? sql`${spotifyAlternates(
            sql`select media_item.id, media_item.source_label, library_track.spotify_track_id
              ${trackTables} where ${visibleScope}`,
            { creatorId: query.creatorId },
          )},`
        : sql``
    }`
  const rows = sql`${trackTables} ${duplicatesJoin} ${coverageJoin} ${historyJoin} ${listeningJoin}
        ${
          providerSort
            ? sql`left join (select id, min(lower(value)) as value
                from (${evidenceValues(sortBy)}) matching_values group by id) provider_order
                on provider_order.id = media_item.id`
            : sql``
        }
        ${where}`
  return {
    includeEvidence,
    needsCoverageBeforePage,
    reuseEvidence: allEvidenceProviders.size === supportingProviders.size,
    sortsByListening,
    listening,
    listeningJoin,
    prelude,
    rows,
    order,
    total,
  }
}

/** Include source-only rows here so a redundant or incorrect match can be repaired. */
export async function listTrackMatchDiagnostics(
  query: DiagnosticsQuery,
  userId?: string,
) {
  const now = new Date()
  const {
    includeEvidence,
    needsCoverageBeforePage,
    reuseEvidence,
    sortsByListening,
    listening,
    listeningJoin,
    prelude,
    rows,
    order,
    total,
  } = trackMatchDiagnosticsRows(query, userId, now)
  // A displayed count only needs to read the scrobbles of the returned rows.
  const pageListening = createBrowseListening(
    undefined,
    sortsByListening ? undefined : query.listeningSort,
    now,
  )
  const pageListeningSource = pageListening?.source(
    'track',
    sql`(select unnest(ids) as id from page_ids)`,
  )
  const pageListeningJoin = pageListeningSource
    ? sql`left join ${pageListeningSource} on listening_counts.id = ${trackId}`
    : listening?.sort
      ? listeningJoin
      : sql``
  const offset = (query.page - 1) * query.size
  const remaining =
    query.limitResults === undefined
      ? query.size
      : Math.max(0, query.limitResults - offset)
  const result = await db.execute(sql`
    with ${prelude}
    page_ids as (
      select array(
        select media_item.id ${rows}
        order by ${order} limit ${Math.min(query.size, remaining)} offset ${offset}
      ) as ids
    ),
    page as materialized (
      ${records}, positions.rank, ${pageListening?.sort ?? listening?.sort ?? sql`null::int`} as period_plays ${trackTables}
      ${pageListeningJoin}
      join unnest((select ids from page_ids)) with ordinality positions(id, rank)
        on positions.id = media_item.id
    ),
    ${
      needsCoverageBeforePage
        ? sql``
        : sql`${spotifyAlternates(sql`select id, source_label, spotify_track_id from page`, { useTargetTitles: true })},`
    }
    ${includeEvidence ? sql`page_matches as (${pageMatchEvidence(reuseEvidence)}),` : sql``}
    rows as (
      select p.*, ${includeEvidence ? sql`pm.matches` : sql`null::jsonb`} as matches,
        ${spotifyAlternateValue} as spotify_alternate,
        ${includeEvidence ? pageMergeSourceId : sql`null::text`} as merge_source_id
      from page p ${includeEvidence ? sql`left join page_matches pm on pm.id = p.id` : sql``}
      left join spotify_alternates a on a.id = p.id
    )
    select ${total} as total_count,
      coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'creator', creator, 'albumName', album_name,
        'matches', coalesce(matches, '[]'::jsonb), 'periodPlays', period_plays) ||
        case when merge_source_id is null then '{}'::jsonb else jsonb_build_object('mergeSourceId', merge_source_id) end ||
        case when spotify_alternate is null then '{}'::jsonb else jsonb_build_object('spotifyAlternate', spotify_alternate) end
        order by rank), '[]'::jsonb) as items from rows`)
  const page = z
    .object({
      total_count: z.number().int().nonnegative(),
      items: z.array(
        MatchDiagnosticsRowSchema.extend({
          periodPlays: z.number().int().nonnegative().nullable(),
        }),
      ),
    })
    .parse(result.rows[0])
  const tracks = new Map(
    (await loadTracks(page.items.map((item) => item.id))).map((track) => [
      track.id,
      track,
    ]),
  )
  return MatchDiagnosticsPageSchema.parse({
    items: page.items.map(({ periodPlays, ...item }) => {
      const track = tracks.get(item.id)
      return {
        ...item,
        track:
          track && periodPlays !== null
            ? { ...track, listeningScrobbles: periodPlays }
            : track,
      }
    }),
    providers: includeEvidence ? providers : [],
    totalCount: page.total_count,
    pageCount: Math.ceil(page.total_count / query.size),
  })
}

const MatchIdsRowSchema = z.object({
  total_count: z.number().int().nonnegative(),
  ids: z.array(z.string()),
})

/**
 * The IDs of every row the Matches query lists, in its order and up to
 * `limitResults`, with its total. One statement; the page is ignored.
 */
export async function listTrackMatchDiagnosticIds(
  query: DiagnosticsQuery,
  userId?: string,
) {
  const { prelude, rows, order, total } = trackMatchDiagnosticsRows(
    query,
    userId,
    new Date(),
  )
  const limit =
    query.limitResults === undefined ? sql`` : sql`limit ${query.limitResults}`
  const result = await db.execute(sql`
    with ${prelude}
    matching as (
      select array(select media_item.id ${rows} order by ${order} ${limit}) as ids
    )
    select ${total} as total_count, (select ids from matching) as ids`)
  const row = MatchIdsRowSchema.parse(result.rows[0])
  return { ids: row.ids, totalCount: row.total_count }
}

const DiagnosticFacetRowsSchema = z.array(
  z.object({
    field: z.string(),
    value: z.string(),
    count: z.number().int().positive(),
  }),
)
const diagnosticFacetCache = createDatabaseReadCache<
  z.infer<typeof DiagnosticFacetRowsSchema>
>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})

/** Count the same stored values the diagnostics table can search and filter. */
export async function listTrackMatchDiagnosticsFacets(input: BrowseFacetQuery) {
  const query = BrowseFacetQuerySchema.parse(input)
  const limit = Math.min(
    query.limitPerField,
    Math.floor(1000 / trackMatchDiagnosticFields.length),
  )
  const [ordinary, extra] = await Promise.all([
    listBrowseFacets(
      'track',
      { ...query, limitPerField: limit },
      { includeLastfmSourceRows: true, fields: ordinaryFields },
    ),
    diagnosticFacetCache(JSON.stringify({ ...query, limit }), async () => {
      const fields = diagnosticFields.map((field) =>
        browseFacetRows(field, evidenceValues(field.key), query, limit),
      )
      const result = await db.execute(sql`
        with records as not materialized (${records} ${trackTables} where ${visibleLibraryTracks}),
          evidence as materialized (${trackEvidence(sql`records`, allEvidenceProviders)})
        ${sql.join(fields, sql` union all `)}
      `)
      return DiagnosticFacetRowsSchema.parse(result.rows)
    }),
  ])
  return [
    ...ordinary,
    ...extra.map((row) => ({
      ...row,
      label: `${diagnosticFields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    })),
  ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
