import { sql, type SQL } from 'drizzle-orm'
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
import { artistTagMemberships } from './music-tags'
import { loadTracks } from './tracks'

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
      case when r.source_label = 'spotify' then r.name else entry->>'title' end as name,
      case when r.source_label = 'spotify' then r.creator else
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
        and r.source_label is distinct from 'spotify'
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
  library_track.spotify_track_id, ${trackAlbumName} as album_name, ${trackCreator} as creator`
// The album alias is also used by the shared Tracks Browse ordering.
const trackTables = sql`from media_item join library_track on library_track.media_item_id = media_item.id
  left join media_item track_sort_album on track_sort_album.id = library_track.album_media_item_id`
const visibleTracks = sql`media_item.media_type = 'track'
  and media_item.metadata->>'legacyHidden' is distinct from 'true'`
const diagnosticFields = trackMatchDiagnosticFields.filter(
  (field) => !trackBrowseFields.some((browse) => browse.key === field.key),
)

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
    sql`coalesce(m.spotify, false)`,
    sql`coalesce(m.lastfm, false)`,
    sql`coalesce(m.discogs, false)`,
  )
  return sql`select r.id, p.value from records r
    left join (
      select id, bool_or(provider = 'spotify') as spotify, bool_or(provider = 'lastfm') as lastfm,
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
    where e.provider = ${field}`
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

type DiagnosticsQuery = Omit<TrackMatchDiagnosticsQuery, 'filters' | 'ranges'> &
  Partial<Pick<TrackMatchDiagnosticsQuery, 'filters' | 'ranges'>>

/** Include source-only rows here so a redundant or incorrect match can be repaired. */
export async function listTrackMatchDiagnostics(query: DiagnosticsQuery) {
  const sortBy = query.sortBy
  const providerSort =
    allEvidenceProviders.has(sortBy) ||
    (sortBy !== 'spotifyId' && evidenceFields.has(sortBy)) ||
    sortBy === 'matchProvider'
  const diagnosticSort = providerSort
    ? sql`provider_order.value`
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
  const order = sql.join(ordering, sql`, `)
  const filters = query.filters ?? []
  const words = [...new Set(query.q?.split(/\s+/).filter(Boolean))]
  const sharedArtistTags = words.length > 1
  const supportingProviders = new Set<string>()
  if (words.length || sortBy === 'matchProvider')
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
  const conditions = [
    visibleTracks,
    ...trackBrowseFieldConditions(
      filters,
      query.ranges ?? [],
      trackMatchDiagnosticFields,
      evidenceFilter,
    ),
  ]
  if (query.creatorId)
    conditions.push(sql`exists (
    select 1 from media_credit c where c.media_item_id = media_item.id
      and c.role = 'artist' and c.artist_id = ${query.creatorId}
  )`)
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(sql`media_item.id in (
      ${trackBrowseSearchIds(pattern, sharedArtistTags)} union all
      select e.id from evidence e where
        e.name ilike ${pattern} or e.creator ilike ${pattern} or e.identifier ilike ${pattern}
    )`)
  }
  const where = sql`where ${sql.join(conditions, sql` and `)}`
  const offset = (query.page - 1) * query.size
  const remaining =
    query.limitResults === undefined
      ? query.size
      : Math.max(0, query.limitResults - offset)
  const count = sql`(select count(*)::int ${trackTables} ${where})`
  const total =
    query.limitResults === undefined
      ? count
      : sql`least(${count}, ${query.limitResults})`
  const reuseEvidence = allEvidenceProviders.size === supportingProviders.size
  const result = await db.execute(sql`
    with ${sharedArtistTags ? sql`browse_artist_tags as materialized (${artistTagMemberships('track')}),` : sql``} ${
      supportingProviders.size
        ? sql`
      records as not materialized (${records} ${trackTables} where ${visibleTracks}),
      evidence as materialized (${trackEvidence(sql`records`, supportingProviders)}),
    `
        : sql``
    }
    page_ids as (
      select array(
        select media_item.id ${trackTables}
        ${
          providerSort
            ? sql`left join (select id, min(lower(value)) as value
                from (${evidenceValues(sortBy)}) matching_values group by id) provider_order
                on provider_order.id = media_item.id`
            : sql``
        }
        ${where}
        order by ${order} limit ${Math.min(query.size, remaining)} offset ${offset}
      ) as ids
    ),
    page as materialized (
      ${records}, positions.rank ${trackTables}
      join unnest((select ids from page_ids)) with ordinality positions(id, rank)
        on positions.id = media_item.id
    ),
    page_matches as (
      select e.id, jsonb_agg(jsonb_build_object('provider', e.provider, 'name', e.name,
        'creator', e.creator, 'identifier', e.identifier) ||
        case when e.provider = 'lastfm' then jsonb_build_object('artistKey', e.artist_key, 'trackKey', e.track_key)
        when e.album_id is not null then jsonb_build_object('albumId', e.album_id)
        else '{}'::jsonb end order by e.provider, e.name, e.creator, e.identifier, e.album_id) as matches
      from ${reuseEvidence ? sql`evidence` : sql`(${trackEvidence(sql`page`, allEvidenceProviders)})`} e
      join page p on p.id = e.id group by e.id
    ),
    rows as (
      select p.*, pm.matches,
        (select min(source_id) from (
          select s.track_media_item_id as source_id from lastfm_track_source s where s.track_media_item_id = p.id
          union
          select s.track_media_item_id from lastfm_track_link l join lastfm_track_source s
            using (username, artist_key, track_key) where l.track_media_item_id = p.id
        ) ids join media_item source on source.id = ids.source_id
        where source.source_label is distinct from 'spotify' and source.metadata->>'legacyHidden' is distinct from 'true'
          and (ids.source_id = p.id or (p.source_label = 'spotify' and p.spotify_track_id is not null))
        having count(*) = 1) as merge_source_id
      from page p left join page_matches pm on pm.id = p.id
    )
    select ${total} as total_count,
      coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'creator', creator, 'albumName', album_name,
        'matches', coalesce(matches, '[]'::jsonb)) ||
        case when merge_source_id is null then '{}'::jsonb else jsonb_build_object('mergeSourceId', merge_source_id) end
        order by rank), '[]'::jsonb) as items from rows`)
  const page = z
    .object({
      total_count: z.number().int().nonnegative(),
      items: z.array(MatchDiagnosticsRowSchema),
    })
    .parse(result.rows[0])
  const tracks = new Map(
    (await loadTracks(page.items.map((item) => item.id))).map((track) => [
      track.id,
      track,
    ]),
  )
  return MatchDiagnosticsPageSchema.parse({
    items: page.items.map((item) => ({ ...item, track: tracks.get(item.id) })),
    providers,
    totalCount: page.total_count,
    pageCount: Math.ceil(page.total_count / query.size),
  })
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
      { includeLastfmSourceRows: true },
    ),
    diagnosticFacetCache(JSON.stringify({ ...query, limit }), async () => {
      const fields = diagnosticFields.map((field) =>
        browseFacetRows(field, evidenceValues(field.key), query, limit),
      )
      const result = await db.execute(sql`
        with records as not materialized (${records} ${trackTables} where ${visibleTracks}),
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
