import { and, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { ArtistProfileSchema } from '@repo/schemas/artist-profiles'
import { uniqueMusicTags } from '@repo/schemas/music-tags'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import {
  BrowsePageSliceSchema,
  type BrowseFacetQuery,
} from '@repo/schemas/browse'
import {
  ArtistSummarySchema,
  ArtistMetadataItemSchema,
  type ArtistQuery,
  type ArtistMetadataQuery,
} from '@repo/schemas/creators'
import { db } from '@/lib/db'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
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
import { normalizedTagSql, normalizeTagName } from './tag-state'

type Query = ArtistQuery | ArtistMetadataQuery
const id = sql`a.id`
const visibleMusic = sql`item.metadata->>'legacyHidden' is distinct from 'true'
  and ((item.media_type = 'album' and exists (select 1 from album release where release.media_item_id = item.id))
    or (item.media_type = 'track' and exists (select 1 from library_track recording where recording.media_item_id = item.id)))`
const visibleArtist = sql`exists (select 1 from media_credit credit
  join media_item item on item.id = credit.media_item_id
  where credit.artist_id = a.id and credit.role = 'artist' and ${visibleMusic})`
const countCache = createDatabaseReadCache<number>({
  maxEntries: 128,
  maxValueBytes: 64,
})
const FacetSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})
const facetCache = createDatabaseReadCache<z.infer<typeof FacetSchema>[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})

function pattern(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

/** Field sources remain relational so selective names are matched before memberships. */
function textRows(field: string): SQL {
  if (field === 'name') return sql`select a.id, a.name as value from artist a`
  if (field === 'playlist')
    return sql`select membership.artist_id as id, playlist.name as value
    from (${artistPlaylistCredits()}) membership
    join playlist on playlist.id = membership.playlist_id where ${visiblePlaylist}`
  if (field === 'provider')
    return sql`select state.artist_id as id, state.provider as value from artist_provider_current_state state`
  if (field === 'genre')
    return sql`select state.artist_id as id, tags.value from artist_provider_current_state state
    join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(coalesce(snapshot.normalized_data->'tags', '[]'::jsonb)) tags(value)`
  return sql`select state.artist_id as id, snapshot.normalized_data->>${field} as value from artist_provider_current_state state
    join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id`
}

function textMatch(field: string, value: string, substring = false): SQL {
  const source = textRows(field)
  const expression =
    field === 'genre' && !substring ? normalizedTagSql(sql`value`) : sql`value`
  const condition = substring
    ? sql`${expression} ilike ${pattern(value)}`
    : field === 'genre'
      ? sql`${expression} = ${normalizeTagName(value)}`
      : sql`${expression} ilike ${value.replace(/[\\%_]/g, '\\$&')}`
  return sql`${id} in (select id from (${source}) matching_values where ${condition})`
}

function numericValue(field: string): SQL {
  if (field === 'albumCount') return sql`coalesce(music_counts.album_count, 0)`
  if (field === 'trackCount') return sql`coalesce(music_counts.track_count, 0)`
  if (field === 'createdAt') return sql`extract(epoch from a.created_at) * 1000`
  return sql`coalesce(playlist_counts.playlist_count, 0)`
}

function candidates(query: Query, includeOrder: boolean): SQL {
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
      from media_credit credit join media_item item on item.id = credit.media_item_id
      where credit.role = 'artist' and ${visibleMusic} group by credit.artist_id
    ) music_counts on music_counts.artist_id = a.id`
        : sql``
    }
    ${playlists ? sql`left join (${artistPlaylistCounts()}) playlist_counts on playlist_counts.artist_id = a.id` : sql``}
    ${textSort ? sql`left join (select id, min(lower(value)) as value from (${textRows(query.sortBy)}) source group by id) sort_values on sort_values.id = a.id` : sql``}`
}

function membership(query: Query): SQL {
  const conditions: SQL[] = [visibleArtist]
  if (query.playlistIds.length)
    conditions.push(sql`${id} in (
    select memberships.artist_id from (${artistPlaylistCredits()}) memberships
    join playlist on playlist.id = memberships.playlist_id
    where ${visiblePlaylist} and playlist.id = any(${sql.param(query.playlistIds)}::text[]))`)
  for (const word of (query.q ?? '').split(/\s+/).filter(Boolean)) {
    const matches = or(
      ...artistBrowseFields
        .filter((field) => field.type === 'text')
        .map((field) => textMatch(field.key, word, true)),
      sql`a.sort_name ilike ${pattern(word)}`,
    )
    if (matches) conditions.push(matches)
  }
  const any: SQL[] = []
  for (const filter of query.filters) {
    const match = textMatch(filter.field, filter.value)
    if (filter.mode === 'required') conditions.push(match)
    else if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else any.push(match)
  }
  const anyCondition = or(...any)
  if (anyCondition) conditions.push(anyCondition)
  for (const range of query.ranges) {
    const value = numericValue(range.field)
    const bounds = and(
      sql`${value} is not null`,
      range.min === undefined ? undefined : sql`${value} >= ${range.min}`,
      range.max === undefined ? undefined : sql`${value} <= ${range.max}`,
    )
    if (bounds)
      conditions.push(
        range.includeMissing ? sql`(${value} is null or (${bounds}))` : bounds,
      )
  }
  if ('freshness' in query)
    conditions.push(...artistFreshnessConditions(id, query.freshness))
  return and(...conditions) ?? sql`true`
}

function ordering(query: Query): SQL {
  let value: SQL
  if (query.sortBy === 'lastScrapedAt' && 'provider' in query && query.provider)
    value = artistLastScrapedAt(id, query.provider)
  else if (query.sortBy === 'name')
    value = sql`lower(coalesce(a.sort_name, a.name))`
  else if (
    ['createdAt', 'albumCount', 'trackCount', 'playlistCount'].includes(
      query.sortBy,
    )
  )
    value = numericValue(query.sortBy)
  else value = sql`sort_values.value`
  const nulls =
    query.sortBy === 'lastScrapedAt' && query.direction === 'asc'
      ? sql`nulls first`
      : sql`nulls last`
  return sql`${value} ${query.direction === 'asc' ? sql`asc` : sql`desc`} ${nulls}, a.id asc`
}

const IdSchema = z.array(z.object({ id: z.string() }))
const ArtistRowSchema = ArtistSummarySchema.extend({
  createdAt: z.coerce.date(),
})

async function loadArtists(ids: string[]) {
  if (!ids.length) return []
  const requested = sql`any(${sql.param(ids)}::text[])`
  const [result, profiles] = await Promise.all([
    db.execute(sql`with counts as (
      select credit.artist_id, count(*) filter (where item.media_type = 'album')::int as albums,
        count(*) filter (where item.media_type = 'track')::int as tracks
      from media_credit credit join media_item item on item.id = credit.media_item_id
      where credit.artist_id = ${requested} and credit.role = 'artist' and ${visibleMusic} group by credit.artist_id
    ), playlists as (
      select memberships.artist_id, count(distinct playlist.id)::int as count,
        array_agg(distinct playlist.name order by playlist.name) as names
      from (${artistPlaylistCredits(requested)}) memberships
      join playlist on playlist.id = memberships.playlist_id where ${visiblePlaylist} group by memberships.artist_id
    ) select a.id, a.name, a.sort_name as "sortName", a.created_at at time zone 'UTC' as "createdAt",
      coalesce(counts.albums,0) as "albumCount", coalesce(counts.tracks,0) as "trackCount",
      coalesce(playlists.count,0) as "playlistCount", ${artistArtwork(id)} as "artworkUrl",
      jsonb_build_object('playlist',coalesce(playlists.names,'{}'::text[])) as browse
      from artist a left join counts on counts.artist_id = a.id left join playlists on playlists.artist_id = a.id
      where a.id = ${requested}`),
    db.execute(sql`select state.artist_id as id, state.provider, snapshot.normalized_data as profile
      from artist_provider_current_state state join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      where state.artist_id = ${requested} order by snapshot.created_at desc, snapshot.id desc`),
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

export async function listArtistBrowsePage(query: Query) {
  const offset = (query.page - 1) * query.size
  const remaining =
    query.limitResults === undefined
      ? query.size + 1
      : Math.max(0, Math.min(query.size + 1, query.limitResults - offset))
  const result = remaining
    ? await db.execute(
        sql`select a.id from ${candidates(query, true)} where ${membership(query)} order by ${ordering(query)} limit ${remaining} offset ${offset}`,
      )
    : { rows: [] }
  const ids = IdSchema.parse(result.rows).map((row) => row.id)
  return BrowsePageSliceSchema(ArtistSummarySchema).parse({
    items: await loadArtists(ids.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: ids.length > query.size,
  })
}

export async function countArtistBrowse(query: Query) {
  const { limitResults } = query
  const filters = {
    q: query.q,
    filters: query.filters,
    ranges: query.ranges,
    playlistIds: query.playlistIds,
    freshness: 'freshness' in query ? query.freshness : undefined,
  }
  const total = await countCache(JSON.stringify(filters), async () => {
    const result = await db.execute(
      sql`select count(*)::int as count from ${candidates(query, false)} where ${membership(query)}`,
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

export async function listArtistMetadataBrowsePage(query: ArtistMetadataQuery) {
  const page = await listArtistBrowsePage(query)
  const metadata = await loadArtistMetadata(page.items.map((item) => item.id))
  return BrowsePageSliceSchema(ArtistMetadataItemSchema).parse({
    ...page,
    items: page.items.map((item) => ({
      ...item,
      providers: metadata.filter((row) => row.artistId === item.id),
    })),
  })
}

export async function listArtistBrowseFacets(query: BrowseFacetQuery) {
  const fields = artistBrowseFields.filter((field) => field.type === 'text')
  const rows = await facetCache(JSON.stringify(query), async () => {
    const queries = fields.map((field) => {
      const words = (query.q ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .filter(
          (word) =>
            field.key === 'name' ||
            !`${field.label}:`.toLowerCase().includes(word.toLowerCase()),
        )
      const matches = and(
        ...words.map(
          (word) => sql`values_for_field.value ilike ${pattern(word)}`,
        ),
      )
      const group =
        field.key === 'genre'
          ? normalizedTagSql(sql`values_for_field.value`)
          : sql`lower(values_for_field.value)`
      return sql`(select ${field.key}::text as field, min(values_for_field.value) as value, count(distinct a.id)::int as count
        from (${textRows(field.key)}) values_for_field join artist a on a.id = values_for_field.id
        where ${visibleArtist} and values_for_field.value is not null and values_for_field.value <> '' ${matches ? sql`and ${matches}` : sql``}
        group by ${group} order by case when lower(min(values_for_field.value)) = ${(query.q ?? '').toLowerCase()} then 0 else 1 end, count desc, value asc limit ${query.limitPerField})`
    })
    return z
      .array(FacetSchema)
      .parse((await db.execute(sql.join(queries, sql` union all `))).rows)
  })
  return rows
    .map((row) => ({
      ...row,
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
