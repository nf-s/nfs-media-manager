import { and, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { ArtistProfileSchema } from '@repo/schemas/artist-profiles'
import { uniqueMusicTags } from '@repo/schemas/music-tags'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { formatTagName } from '@repo/schemas/tags'
import {
  BrowsePageSliceSchema,
  type BrowseFacetQuery,
} from '@repo/schemas/browse'
import {
  ArtistSummarySchema,
  ArtistMetadataItemSchema,
  type ArtistListeningHistogramQuery,
  type ArtistQuery,
  type ArtistMetadataQuery,
} from '@repo/schemas/creators'
import {
  defaultListeningPeriod,
  listeningHistogramEdges,
  ListeningHistogramSchema,
} from '@repo/schemas/listening'
import { rangeCondition } from '@/lib/browse-range'
import { db } from '@/lib/db'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { measureRequestPhase } from '@/lib/request-log'
import {
  artistPlaylistCredits,
  artistArtwork,
  artistPlaylistCounts,
  visiblePlaylist,
} from './artist-library'
import {
  artistFreshnessConditions,
  artistLastScrapedAt,
  loadArtistMetadata,
} from './artist-metadata'
import { providerDisplayNames, providerWordMatch } from './provider-names'
import {
  createArtistBrowseListening,
  type ArtistBrowseListening,
} from './artist-browse-listening'
import { listeningPeriodBounds } from './browse-listening'
import { listeningHistoryStart } from './listening-series'
import { matchingTagNames } from './music-tags'
import { tagAncestorKeys, visibleSubtagCounts } from './tag-hierarchy'
import { normalizedTagSql, normalizeTagName } from './tag-state'

type Query = ArtistQuery | ArtistMetadataQuery
const id = sql`a.id`
const musicCredits = sql`media_credit credit
  join media_item item on item.id = credit.media_item_id
  left join album release on item.media_type = 'album' and release.media_item_id = item.id
  left join library_track recording on item.media_type = 'track' and recording.media_item_id = item.id`
const visibleMusic = sql`credit.role = 'artist' and item.metadata->>'legacyHidden' is distinct from 'true'
  and (release.media_item_id is not null or recording.media_item_id is not null)`
// A merged artist is a name another artist keeps, not an artist of its own.
const visibleArtist = sql`a.merged_into_id is null and exists (select 1 from ${musicCredits}
  where credit.artist_id = a.id and ${visibleMusic})`
const countCache = createDatabaseReadCache<number>({
  maxEntries: 128,
  maxValueBytes: 64,
})
const FacetSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})
type Facet = z.infer<typeof FacetSchema> & { subtags?: number }
const facetCache = createDatabaseReadCache<Facet[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})

/**
 * One row per artist and scrobble linked to a library album or library track
 * credited to the artist, counted once: the same link as the artist's
 * listening chart and stored scrobble count. `artists` narrows `c.artist_id`.
 */
function artistScrobbles(artists: SQL): SQL {
  const credited = sql`c.role = 'artist' and ${artists}
    and m.metadata->>'legacyHidden' is distinct from 'true'`
  return sql`select c.artist_id, s.id, s.listened_at
    from media_credit c join media_item m on m.id = c.media_item_id
    join lastfm_scrobble s on s.album_media_item_id = c.media_item_id
    where m.media_type = 'album' and ${credited}
    union
    select c.artist_id, s.id, s.listened_at
    from media_credit c join media_item m on m.id = c.media_item_id
    join lastfm_track_link l on l.track_media_item_id = c.media_item_id
    join lastfm_scrobble s on s.username = l.username
      and s.artist_key = l.artist_key and s.track_key = l.track_key
    where m.media_type = 'track' and ${credited}`
}

/** UTC calendar months as `YYYY-MM`, oldest first, from `from` to the month of `now`. */
function monthKeys(from: string, now: Date) {
  const [year = NaN, month = NaN] = from.split('-').map(Number)
  const count =
    (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() - (month - 1) + 1
  return Array.from({ length: Math.max(1, count) }, (_, index) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index + 1 - count, 1),
    )
      .toISOString()
      .slice(0, 7),
  )
}

function pattern(value: string, substring = true) {
  const escaped = value.replace(/[\\%_]/g, '\\$&')
  return substring ? `%${escaped}%` : escaped
}

/** Field sources remain relational so selective names are matched before memberships. */
function textRows(
  field: string,
  options: { playlistFilter?: SQL; distinctPlaylists?: boolean } = {},
): SQL {
  if (field === 'name') return sql`select a.id, a.name as value from artist a`
  if (field === 'playlist') {
    const credits = artistPlaylistCredits(undefined, options.playlistFilter)
    // Facets need the artist and playlist pair only, even across several credits.
    const members = options.distinctPlaylists
      ? sql`select distinct artist_id, playlist_id from (${credits}) credits`
      : credits
    return sql`select membership.artist_id as id, playlist.name as value
    from (${members}) membership
    join playlist on playlist.id = membership.playlist_id
    ${options.playlistFilter ? sql`` : sql`where ${visiblePlaylist}`}`
  }
  if (field === 'provider')
    return sql`select state.artist_id as id, state.provider as value from artist_provider_current_state state`
  if (field === 'genre')
    return sql`select state.artist_id as id, tags.value from artist_provider_current_state state
    join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(coalesce(snapshot.normalized_data->'tags', '[]'::jsonb)) tags(value)`
  return sql`select state.artist_id as id, snapshot.normalized_data->>${field} as value from artist_provider_current_state state
    join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id`
}

function textMatchRows(field: string, value: string, substring = false): SQL {
  const name = pattern(value, substring)
  if (field === 'playlist') {
    return sql`select artist_id as id from (${artistPlaylistCredits(
      undefined,
      sql`playlist.name ilike ${name}`,
    )}) matching_playlists`
  }
  const source = textRows(field)
  const condition =
    field === 'genre' && !substring
      ? // A tag also matches the visible tags beneath it in the album hierarchy.
        sql`${normalizedTagSql(sql`value`)} in (${matchingTagNames(normalizeTagName(value), 'album')})`
      : sql`value ilike ${name}`
  return sql`select id from (${source}) matching_values where ${condition}`
}

/** Keep disjunctions inside the matching set so PostgreSQL can use a semi join. */
function anyTextMatch(sources: SQL[]) {
  return sql`${id} in (
    select distinct id from (${sql.join(sources, sql` union all `)}) matches
  )`
}

function numericValue(field: string): SQL {
  if (field === 'albumCount') return sql`coalesce(music_counts.album_count, 0)`
  if (field === 'trackCount') return sql`coalesce(music_counts.track_count, 0)`
  // Stored by refreshArtistListeningTotals; counting it per request is slow.
  if (field === 'scrobbles') return sql`a.scrobble_count`
  if (field === 'createdAt') return sql`extract(epoch from a.created_at) * 1000`
  return sql`coalesce(playlist_counts.playlist_count, 0)`
}

/** The period rows are counted and sorted over, when one applies. */
function listeningSortPeriod(query: Query) {
  return (
    query.listeningSort ??
    (query.sortBy === 'listeningScrobbles' ? defaultListeningPeriod : undefined)
  )
}

function candidates(
  query: Query,
  includeOrder: boolean,
  listening?: ArtistBrowseListening,
): SQL {
  const required = new Set(query.ranges.map((range) => range.field))
  if (includeOrder) required.add(query.sortBy)
  const music = required.has('albumCount') || required.has('trackCount')
  const playlists = required.has('playlistCount')
  const textSort =
    includeOrder &&
    artistBrowseFields.some(
      (field) =>
        field.key === query.sortBy &&
        field.type === 'text' &&
        field.key !== 'name',
    )
  return sql`artist a
    ${
      music
        ? sql`left join (select credit.artist_id,
      count(*) filter (where item.media_type = 'album')::int as album_count,
      count(*) filter (where item.media_type = 'track')::int as track_count
      from ${musicCredits}
      where ${visibleMusic} group by credit.artist_id
    ) music_counts on music_counts.artist_id = a.id`
        : sql``
    }
    ${playlists ? sql`left join (${artistPlaylistCounts()}) playlist_counts on playlist_counts.artist_id = a.id` : sql``}
    ${textSort ? sql`left join (select id, min(lower(value)) as value from (${textRows(query.sortBy)}) source group by id) sort_values on sort_values.id = a.id` : sql``}
    ${listening?.join ?? sql``}`
}

function membership(query: Query, listening?: ArtistBrowseListening): SQL {
  const conditions: SQL[] = [visibleArtist]
  if (query.playlistIds.length)
    conditions.push(sql`${id} in (
    select artist_id from (${artistPlaylistCredits(
      undefined,
      sql`playlist.id = any(${sql.param(query.playlistIds)}::text[])`,
    )}) memberships)`)
  for (const word of (query.q ?? '').split(/\s+/).filter(Boolean)) {
    conditions.push(
      anyTextMatch([
        ...artistBrowseFields
          .filter((field) => field.type === 'text')
          .map((field) => textMatchRows(field.key, word, true)),
        sql`select id from artist where sort_name ilike ${pattern(word)}`,
      ]),
    )
  }
  const any: SQL[] = []
  for (const filter of query.filters) {
    const match = textMatchRows(filter.field, filter.value)
    if (filter.mode === 'required') conditions.push(sql`${id} in (${match})`)
    else if (filter.mode === 'exclude')
      conditions.push(
        sql`not exists (select 1 from (${match}) excluded where excluded.id = ${id})`,
      )
    else any.push(match)
  }
  if (any.length) conditions.push(anyTextMatch(any))
  for (const range of query.ranges)
    conditions.push(rangeCondition(range, numericValue(range.field)))
  if ('freshness' in query)
    conditions.push(...artistFreshnessConditions(id, query.freshness))
  if (listening?.condition) conditions.push(listening.condition)
  return and(...conditions) ?? sql`true`
}

function ordering(query: Query, listening?: ArtistBrowseListening): SQL {
  let value: SQL
  if (query.sortBy === 'lastScrapedAt' && 'provider' in query && query.provider)
    value = artistLastScrapedAt(id, query.provider)
  else if (query.sortBy === 'listeningScrobbles' && listening?.sort)
    value = listening.sort
  else if (query.sortBy === 'name')
    value = sql`lower(coalesce(a.sort_name, a.name))`
  else if (
    [
      'createdAt',
      'albumCount',
      'trackCount',
      'scrobbles',
      'playlistCount',
    ].includes(query.sortBy)
  )
    value = numericValue(query.sortBy)
  else value = sql`sort_values.value`
  const nulls =
    query.sortBy === 'lastScrapedAt' && query.direction === 'asc'
      ? sql`nulls first`
      : sql`nulls last`
  return sql`${value} ${query.direction === 'asc' ? sql`asc` : sql`desc`} ${nulls}, a.id asc`
}

const IdSchema = z.array(
  z.object({
    id: z.string(),
    listeningScrobbles: z.number().int().nonnegative().optional(),
  }),
)
const ArtistRowSchema = ArtistSummarySchema.extend({
  createdAt: z.coerce.date(),
})
const ListeningRowsSchema = z
  .array(
    z.object({
      history_from: z.string().nullable(),
      months: z.array(
        z.object({
          artist: z.string(),
          month: z.string(),
          count: z.number().int().positive(),
        }),
      ),
    }),
  )
  .length(1)

/**
 * Each requested artist's scrobbles per month, from the month of the
 * earliest stored scrobble of anything to the current month, in one grouped
 * read of the artists' scrobbles. Every artist's months cover that same
 * period, with zero for a month without scrobbles.
 */
async function loadArtistListening(ids: string[], requested: SQL, now: Date) {
  const result = await db.execute(sql`select
      ${listeningHistoryStart} as history_from,
      coalesce((
        select json_agg(json_build_object('artist', artist_id, 'month', month, 'count', count))
        from (
          select artist_id, to_char(date_trunc('month', listened_at), 'YYYY-MM') as month,
            count(*)::int as count
          from (${artistScrobbles(sql`c.artist_id = ${requested}`)}) linked
          group by 1, 2
        ) months
      ), '[]'::json) as months`)
  const [row] = ListeningRowsSchema.parse(result.rows)
  const keys = monthKeys(
    row?.history_from ?? now.toISOString().slice(0, 10),
    now,
  )
  const index = new Map(keys.map((key, position) => [key, position]))
  const listening = new Map(ids.map((id) => [id, keys.map(() => 0)]))
  for (const { artist, month, count } of row?.months ?? []) {
    const months = listening.get(artist)
    const position = index.get(month)
    if (months && position !== undefined) months[position] = count
  }
  return listening
}

async function loadArtists(
  ids: string[],
  listeningScrobbles?: Map<string, number>,
  { includeListeningMonths = true } = {},
) {
  if (!ids.length) return []
  const requested = sql`any(${sql.param(ids)}::text[])`
  const [result, profiles, listening] = await Promise.all([
    db.execute(sql`with counts as (
      select credit.artist_id, count(*) filter (where item.media_type = 'album')::int as albums,
        count(*) filter (where item.media_type = 'track')::int as tracks
      from ${musicCredits}
      where credit.artist_id = ${requested} and ${visibleMusic} group by credit.artist_id
    ), playlists as (
      select memberships.artist_id, count(distinct playlist.id)::int as count,
        array_agg(distinct playlist.name order by playlist.name) as names
      from (${artistPlaylistCredits(requested)}) memberships
      join playlist on playlist.id = memberships.playlist_id where ${visiblePlaylist} group by memberships.artist_id
    ) select a.id, a.name, a.sort_name as "sortName", a.created_at at time zone 'UTC' as "createdAt",
      a.scrobble_count as "scrobbleCount",
      coalesce(counts.albums,0) as "albumCount", coalesce(counts.tracks,0) as "trackCount",
      coalesce(playlists.count,0) as "playlistCount", ${artistArtwork(id)} as "artworkUrl",
      jsonb_build_object('playlist',coalesce(playlists.names,'{}'::text[])) as browse
      from artist a left join counts on counts.artist_id = a.id left join playlists on playlists.artist_id = a.id
      where a.id = ${requested}`),
    db.execute(sql`select state.artist_id as id, state.provider, snapshot.normalized_data as profile
      from artist_provider_current_state state join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      where state.artist_id = ${requested} order by snapshot.created_at desc, snapshot.id desc`),
    includeListeningMonths
      ? loadArtistListening(ids, requested, new Date())
      : undefined,
  ])
  const parsedProfiles = z
    .array(
      z.object({
        id: z.string(),
        provider: z.string(),
        profile: ArtistProfileSchema,
      }),
    )
    .parse(profiles.rows)
  const rows = z.array(ArtistRowSchema).parse(result.rows)
  const byId = new Map(
    rows.map((row) => {
      const sources = parsedProfiles.filter((profile) => profile.id === row.id)
      return [
        row.id,
        {
          ...row,
          createdAt: row.createdAt.toISOString(),
          ...(listeningScrobbles
            ? { listeningScrobbles: listeningScrobbles.get(row.id) ?? 0 }
            : {}),
          ...(listening
            ? { listeningMonths: listening.get(row.id) ?? [] }
            : {}),
          browse: {
            ...row.browse,
            genre: uniqueMusicTags(
              sources.flatMap((source) => source.profile.tags),
            ),
            country: [
              ...new Set(
                sources.flatMap((source) =>
                  source.profile.country ? [source.profile.country] : [],
                ),
              ),
            ],
            type: [
              ...new Set(
                sources.flatMap((source) =>
                  source.profile.type ? [source.profile.type] : [],
                ),
              ),
            ],
            provider: sources.map((source) => source.provider),
          },
        },
      ]
    }),
  )
  return ids.flatMap((artistId) => {
    const item = byId.get(artistId)
    return item ? [item] : []
  })
}

/**
 * The matching artist IDs; ordered and with their `listeningScrobbles` in the
 * sort period when a limit or offset applies.
 */
export function artistBrowseIdsQuery(
  query: Query,
  limit = query.limitResults,
  offset?: number,
  now = new Date(),
): SQL {
  const paginate = limit !== undefined || offset !== undefined
  const listening = createArtistBrowseListening(
    query.listening,
    paginate ? listeningSortPeriod(query) : undefined,
    now,
  )
  const sorted = listening?.sort
    ? sql`, ${listening.sort} as "listeningScrobbles"`
    : sql``
  return sql`select a.id${sorted} from ${candidates(query, paginate, listening)}
    where ${membership(query, listening)}
    ${paginate ? sql`order by ${ordering(query, listening)}` : sql``}
    ${limit === undefined ? sql`` : sql`limit ${limit}`}
    ${offset === undefined ? sql`` : sql`offset ${offset}`}`
}

async function readArtistBrowsePage(query: Query) {
  const offset = (query.page - 1) * query.size
  const remaining =
    query.limitResults === undefined
      ? query.size + 1
      : Math.max(0, Math.min(query.size + 1, query.limitResults - offset))
  const result = remaining
    ? await db.execute(artistBrowseIdsQuery(query, remaining, offset))
    : { rows: [] }
  const rows = IdSchema.parse(result.rows)
  const items = rows.slice(0, query.size)
  const listeningScrobbles = listeningSortPeriod(query)
    ? new Map(items.map((row) => [row.id, row.listeningScrobbles ?? 0]))
    : undefined
  return {
    ids: items.map((row) => row.id),
    listeningScrobbles,
    page: {
      page: query.page,
      size: query.size,
      hasMore: rows.length > query.size,
    },
  }
}

export async function listArtistBrowsePage(query: Query) {
  const { ids, listeningScrobbles, page } = await readArtistBrowsePage(query)
  return BrowsePageSliceSchema(ArtistSummarySchema).parse({
    ...page,
    items: await loadArtists(ids, listeningScrobbles),
  })
}

export async function countArtistBrowse(query: Query, now = new Date()) {
  const { limitResults } = query
  // A listening sort period without rules leaves the count alone.
  const listening = createArtistBrowseListening(query.listening, undefined, now)
  const filters = {
    q: query.q,
    filters: query.filters,
    ranges: query.ranges,
    playlistIds: query.playlistIds,
    freshness: 'freshness' in query ? query.freshness : undefined,
    listening: query.listening && {
      match: query.listening.match,
      rules: query.listening.rules.map((rule) => ({
        min: rule.min,
        max: rule.max,
        bounds: listeningPeriodBounds(rule.period, now),
      })),
    },
  }
  const total = await countCache(JSON.stringify(filters), async () => {
    const result = await db.execute(
      sql`select count(*)::int as count from ${candidates(query, false, listening)}
        where ${membership(query, listening)}`,
    )
    return (
      z
        .array(z.object({ count: z.number().int().nonnegative() }))
        .parse(result.rows)[0]?.count ?? 0
    )
  })
  return {
    totalCount:
      limitResults === undefined ? total : Math.min(total, limitResults),
  }
}

/**
 * The filtered count and, for "N of M", the count Clear filters leaves:
 * without search, filters, ranges, playlists, listening rules or a result
 * limit.
 */
export async function artistBrowseCounts(query: ArtistQuery) {
  const filtered =
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.playlistIds.length > 0 ||
    query.listening !== undefined
  const [{ totalCount }, unfiltered] = await Promise.all([
    countArtistBrowse({ ...query, limitResults: undefined }),
    filtered
      ? countArtistBrowse({
          ...query,
          q: undefined,
          filters: [],
          ranges: [],
          playlistIds: [],
          limitResults: undefined,
          listening: undefined,
        })
      : undefined,
  ])
  return {
    totalCount: Math.min(totalCount, query.limitResults ?? totalCount),
    unfilteredCount: unfiltered?.totalCount ?? totalCount,
  }
}

export async function listArtistMetadataBrowsePage(query: ArtistMetadataQuery) {
  const { ids, listeningScrobbles, page } = await measureRequestPhase(
    'ids',
    () => readArtistBrowsePage(query),
  )
  const [artists, metadata] = await measureRequestPhase('hydrate', () =>
    Promise.all([
      loadArtists(ids, listeningScrobbles, { includeListeningMonths: false }),
      loadArtistMetadata(ids),
    ]),
  )
  return BrowsePageSliceSchema(ArtistMetadataItemSchema).parse({
    ...page,
    items: artists.map((item) => ({
      ...item,
      providers: metadata.filter((row) => row.artistId === item.id),
    })),
  })
}

/**
 * How many artists matching the query, without its listening rules, have
 * each number of scrobbles in the period, by bar of the artist histogram. One
 * grouped read counts every bar.
 */
export async function artistListeningHistogram(
  { period, ...query }: ArtistListeningHistogramQuery,
  now = new Date(),
) {
  const edges = listeningHistogramEdges.artist
  const listening = createArtistBrowseListening(undefined, period, now)
  const value = listening?.sort ?? sql`0`
  const bars = edges.map((edge, index) => {
    const next = edges[index + 1]
    return next === undefined
      ? sql`count(*) filter (where ${value} >= ${edge})::int`
      : sql`count(*) filter (where ${value} >= ${edge} and ${value} < ${next})::int`
  })
  const unruled = { ...query, listening: undefined }
  const result =
    await db.execute(sql`select array[${sql.join(bars, sql`, `)}] as counts
    from ${candidates(unruled, false, listening)} where ${membership(unruled)}`)
  const [row] = z
    .array(z.object({ counts: z.array(z.number().int().nonnegative()) }))
    .length(1)
    .parse(result.rows)
  return ListeningHistogramSchema.parse({
    edges: [...edges],
    counts: row?.counts ?? edges.map(() => 0),
  })
}

export async function listArtistBrowseFacets(query: BrowseFacetQuery) {
  const fields = artistBrowseFields.filter((field) => field.type === 'text')
  const providerNames = await providerDisplayNames()
  const rows = await facetCache(
    JSON.stringify([query, [...providerNames]]),
    async () => {
      const queries = fields.map((field) => {
        const words = (query.q ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .filter(
            (word) =>
              field.key === 'name' ||
              !`${field.label}:`.toLowerCase().includes(word.toLowerCase()),
          )
        // A provider is also found by its display name.
        const matchWords = (value: SQL) =>
          and(
            ...words.map((word) => {
              const matches = sql`${value} ilike ${pattern(word)}`
              return field.key === 'provider'
                ? providerWordMatch(value, word, matches, providerNames)
                : matches
            }),
          )
        const playlistFilter =
          field.key === 'playlist' ? matchWords(sql`playlist.name`) : undefined
        const matches = playlistFilter
          ? undefined
          : matchWords(sql`values_for_field.value`)
        // Tags are grouped by normalized name; a tag is also counted under
        // each visible album tag above it, as its filter matches them.
        const tags = field.key === 'genre'
        const group = tags
          ? sql`values_for_field.value`
          : sql`lower(values_for_field.value)`
        const source = tags
          ? sql`select id, value from artist_tag_keys
          union all
          select artist_tag_keys.id, ancestor.ancestor_key as value from artist_tag_keys
          join (${tagAncestorKeys('album', true)}) ancestor on ancestor.descendant_key = artist_tag_keys.value`
          : textRows(field.key, { playlistFilter, distinctPlaylists: true })
        return sql`(select ${field.key}::text as field, min(artist_values.value) as value, count(*)::int as count
        from (
          select ${group} as value_key, min(values_for_field.value) as value
          from (${source}) values_for_field join visible_artists a on a.id = values_for_field.id
          where values_for_field.value is not null and values_for_field.value <> '' ${matches ? sql`and ${matches}` : sql``}
          group by value_key, a.id
        ) artist_values
        group by artist_values.value_key
        order by case when lower(min(artist_values.value)) = ${(query.q ?? '').toLowerCase()} then 0 else 1 end, count desc, value asc limit ${query.limitPerField})`
      })
      // Normalize a stored label once across the artists and providers using it.
      const result = await db.execute(sql`with visible_artists as materialized (
      select a.id from artist a where ${visibleArtist}
    ), raw_artist_tags as materialized (
      select distinct id, value from (${textRows('genre')}) artist_tags
    ), normalized_tag_labels as materialized (
      select value as raw_name, ${normalizedTagSql(sql`value`)} as value
      from (select distinct value from raw_artist_tags) labels
    ), artist_tag_keys as materialized (
      select raw.id, labels.value from raw_artist_tags raw
      join normalized_tag_labels labels on labels.raw_name = raw.value
    ) ${sql.join(queries, sql` union all `)}`)
      const facets: Facet[] = z.array(FacetSchema).parse(result.rows)
      // A tag with subtags is counted over all of them; say how many there are.
      const subtags = await visibleSubtagCounts('album', [
        ...new Set(
          facets.filter((row) => row.field === 'genre').map((row) => row.value),
        ),
      ])
      return facets.map((row) => {
        const count = row.field === 'genre' ? subtags.get(row.value) : undefined
        return count === undefined ? row : { ...row, subtags: count }
      })
    },
  )
  return rows
    .map((row) => ({
      ...row,
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${
        row.field === 'genre'
          ? formatTagName(row.value)
          : row.field === 'provider'
            ? (providerNames.get(row.value) ?? row.value)
            : row.value
      }`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
