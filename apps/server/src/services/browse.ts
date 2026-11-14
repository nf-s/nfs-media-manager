import { and, eq, sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import {
  albumBrowseFields,
  filmBrowseFields,
  trackBrowseFields,
  BrowseFieldSchema,
  BrowseFacetQuerySchema,
  type BrowseFacetQuery,
  type BrowseField,
} from '@repo/schemas/browse'
import type { AlbumQuery, FilmQuery } from '@repo/schemas/media'
import { trackAlbumLinkLabels, type TrackQuery } from '@repo/schemas/tracks'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { mediaItem, album, film, libraryTrack } from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { normalizedTagSql, normalizeTagName } from './tag-state'
import { albumAddedDateExpression } from './album-added-dates'
import { createBrowseListening } from './browse-listening'
import {
  linkedTrackFieldExpression,
  trackSourcesExpression,
} from './track-values'

type MediaType = 'album' | 'film' | 'track'

const countCache = createDatabaseReadCache<number>({
  maxEntries: 128,
  maxValueBytes: 64,
})
const facetCache = createDatabaseReadCache<z.infer<typeof FacetRowSchema>[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})
const dialect = new PgDialect()

export type BrowseQueryOptions = {
  conditions?: SQL[]
  sort?: { field: BrowseField; expression: SQL; missingFirst?: boolean }
}

export async function listBrowseFields(
  mediaType: MediaType,
): Promise<BrowseField[]> {
  // Tracks are not scraped, so no provider adds fields to them.
  if (mediaType === 'track') return [...trackBrowseFields]
  const base = mediaType === 'album' ? albumBrowseFields : filmBrowseFields
  const plugins = await listLoadedScrapePlugins()
  const extra = plugins
    .filter((plugin) => plugin.manifest.mediaTypes.includes(mediaType))
    .flatMap((plugin) => plugin.manifest.browseFields ?? [])
    .map((field) => BrowseFieldSchema.parse(field))
  return [...base, ...extra]
}

// Playlists an album is in: as a member, or through a linked library track.
const albumPlaylistIds = sql`(
  select pi.playlist_id from playlist_item pi
  where pi.media_item_id = ${mediaItem.id}
  union
  select pi.playlist_id from library_track lt
  join playlist_item pi on pi.media_item_id = lt.media_item_id
  where lt.album_media_item_id = ${mediaItem.id})`

function trackValueExpression(key: string): SQL | null {
  switch (key) {
    case 'source':
      return trackSourcesExpression(sql`${mediaItem.id}`, true)
    case 'releaseDate':
      return sql`to_jsonb(extract(epoch from coalesce(${mediaItem.releaseDate}, (select am.release_date from media_item am where am.id = ${libraryTrack.albumMediaItemId}))) * 1000)`
    case 'album':
      return sql`to_jsonb(coalesce(${libraryTrack.albumName}, (select am.title from media_item am where am.id = ${libraryTrack.albumMediaItemId})))`
    case 'albumLink':
      return sql`to_jsonb(case when ${libraryTrack.albumMediaItemId} is null then ${trackAlbumLinkLabels.unlinked}::text else ${trackAlbumLinkLabels.linked}::text end)`
    case 'dateAdded':
      return sql`to_jsonb(extract(epoch from ${libraryTrack.dateAdded}) * 1000)`
    case 'durationSec':
      return sql`to_jsonb(coalesce(${libraryTrack.durationSec}, ${linkedTrackFieldExpression('duration_sec', sql`${libraryTrack.albumMediaItemId}`, sql`${mediaItem.title}`)}))`
    case 'scrobbles':
      return sql`to_jsonb(${libraryTrack.scrobbleCount})`
    case 'lastListenedAt':
      return sql`to_jsonb(extract(epoch from ${libraryTrack.lastListenedAt}) * 1000)`
    case 'genre':
      // A track has no tags of its own; it shows its library album's.
      return sql`(select jsonb_agg(distinct t.name order by t.name) from media_item_tag mt join tag t on t.id = mt.tag_id where mt.media_item_id = ${libraryTrack.albumMediaItemId} and t.media_type = 'album' and not t.hidden)`
    default:
      return null
  }
}

function valueExpression(key: string, mediaType: MediaType): SQL {
  const trackValue = mediaType === 'track' ? trackValueExpression(key) : null
  if (trackValue) return trackValue
  if (mediaType === 'album' && key === 'playlist')
    return sql`(select jsonb_agg(p.name order by p.name) from playlist p where p.kind = 'playlist' and p.id in ${albumPlaylistIds})`
  switch (key) {
    case 'title':
      return sql`to_jsonb(${mediaItem.title})`
    case 'summary':
      return sql`to_jsonb(${mediaItem.summary})`
    case 'releaseDate':
      return sql`to_jsonb(extract(epoch from ${mediaItem.releaseDate}) * 1000)`
    case 'updatedAt':
      return sql`to_jsonb(extract(epoch from ${mediaItem.updatedAt}) * 1000)`
    case 'dateAdded':
      return sql`to_jsonb(extract(epoch from case when ${mediaItem.mediaType} = 'film' then coalesce(${film.dateAdded}, ${mediaItem.createdAt}) else ${albumAddedDateExpression} end) * 1000)`
    case 'durationSec':
      return sql`to_jsonb(${album.durationSec})`
    case 'trackCount':
      return sql`to_jsonb(${album.trackCount})`
    case 'runtimeMinutes':
      return sql`to_jsonb(${film.runtimeMinutes})`
    case 'budget':
      return sql`to_jsonb(${film.budget})`
    case 'boxOffice':
      return sql`to_jsonb(${film.boxOffice})`
    case 'source':
      return sql`to_jsonb(coalesce(${mediaItem.sourceLabel}, ${film.sourceKind}))`
    case 'watched':
      return sql`to_jsonb(case when ${film.watched} then 'Yes'::text else 'No'::text end)`
    case 'identification':
      return sql`to_jsonb(case when exists (select 1 from provider_reference r where r.media_item_id = ${mediaItem.id} and ((r.reference_type = 'imdb' and r.external_id ~ '^tt[0-9]+$') or (r.reference_type = 'tmdb' and r.external_id ~ '^[0-9]+$'))) then 'Identified'::text else 'Needs ID'::text end)`
    case 'artist':
    case 'director':
    case 'actor':
    case 'writer':
      return sql`(select jsonb_agg(a.name order by c.billing_order, a.name) from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = ${mediaItem.id} and c.role = ${key})`
    case 'genre':
    case 'keyword':
      return sql`(select jsonb_agg(distinct t.name order by t.name) from media_item_tag mt join tag t on t.id = mt.tag_id where mt.media_item_id = ${mediaItem.id} and t.media_type = ${mediaItem.mediaType} and not t.hidden)`
    case 'playlist':
    case 'collection':
      return sql`(select jsonb_agg(p.name order by p.name) from playlist_item pi join playlist p on p.id = pi.playlist_id where pi.media_item_id = ${mediaItem.id} and p.kind = ${key})`
    case 'provider':
      return sql`(select jsonb_agg(distinct r.provider) from provider_reference r where r.media_item_id = ${mediaItem.id})`
    default:
      return sql`(${mediaItem.metadata}->'browse'->${key}::text)`
  }
}

function textExpression(key: string, mediaType: MediaType): SQL {
  const value = valueExpression(key, mediaType)
  return sql`case when jsonb_typeof(${value}) = 'array' then ${value}->>0 else ${value} #>> '{}' end`
}

function numericExpression(key: string, mediaType: MediaType): SQL {
  const value = valueExpression(key, mediaType)
  return sql`case when jsonb_typeof(${value}) = 'number' then (${value} #>> '{}')::numeric else null end`
}

function matchesValue(key: string, value: string, mediaType: MediaType): SQL {
  const match = sql`lower(${value}::text)`
  if (['artist', 'director', 'actor', 'writer'].includes(key)) {
    return sql`exists (select 1 from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = ${mediaItem.id} and c.role = ${key} and lower(a.name) = ${match})`
  }
  if (key === 'genre' || key === 'keyword') {
    // Resolve merged names once for this library, not once per media/tag pair.
    const name = normalizeTagName(value)
    // A track is matched on the tags of its library album.
    const tagged =
      mediaType === 'track'
        ? sql`${libraryTrack.albumMediaItemId}`
        : sql`${mediaItem.id}`
    const tagType = mediaType === 'track' ? 'album' : mediaType
    return sql`${tagged} in (
      select mt.media_item_id from media_item_tag mt join tag t on t.id = mt.tag_id
      where t.media_type = ${tagType} and ${normalizedTagSql(sql`t.name`)} in (
        select ${name}::text
        union select ${normalizedTagSql(sql`target.name`)}
          from tag_identity i join tag target on target.id = i.tag_id
          where i.media_type = ${tagType} and target.media_type = ${tagType} and i.normalized_name = ${name}
        union select ${normalizedTagSql(sql`target.name`)}
          from tag_alias a join tag original on original.id = a.source_tag_id join tag target on target.id = a.target_tag_id
          where original.media_type = ${tagType} and target.media_type = ${tagType} and ${normalizedTagSql(sql`original.name`)} = ${name}
      )
    )`
  }
  if (mediaType === 'album' && key === 'playlist')
    return sql`exists (select 1 from playlist p where p.kind = 'playlist' and lower(p.name) = ${match} and p.id in ${albumPlaylistIds})`
  if (key === 'playlist' || key === 'collection')
    return sql`exists (select 1 from playlist_item pi join playlist p on p.id = pi.playlist_id where pi.media_item_id = ${mediaItem.id} and p.kind = ${key} and lower(p.name) = ${match})`
  if (key === 'provider')
    return sql`exists (select 1 from provider_reference r where r.media_item_id = ${mediaItem.id} and lower(r.provider) = ${match})`
  const expression = valueExpression(key, mediaType)
  return sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${expression}) = 'array' then ${expression} else jsonb_build_array(${expression}) end) filter_value(value) where lower(filter_value.value) = ${match})`
}

export async function queryBrowseIds(
  mediaType: MediaType,
  query: AlbumQuery | FilmQuery | TrackQuery,
  options: BrowseQueryOptions = {},
) {
  const fields = await listBrowseFields(mediaType)
  const listeningFilter = 'listening' in query ? query.listening : undefined
  const listeningPeriod =
    'listeningSort' in query ? query.listeningSort : undefined
  if (
    mediaType !== 'album' &&
    (listeningFilter ||
      listeningPeriod ||
      query.sortBy === 'listeningScrobbles')
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Listening controls are only available for albums',
    })
  const listening =
    mediaType === 'album'
      ? createBrowseListening(
          listeningFilter,
          listeningPeriod ??
            (query.sortBy === 'listeningScrobbles'
              ? defaultListeningPeriod
              : undefined),
        )
      : undefined
  if (listening?.sort)
    fields.push({
      key: 'listeningScrobbles',
      label: 'Scrobbles in period',
      type: 'number',
      filterable: false,
    })
  if (options.sort) fields.push(options.sort.field)
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const sortField = byKey.get(query.sortBy)
  if (!sortField)
    throw new ServerError({ statusCode: 422, message: 'Unknown sort field' })
  const conditions: SQL[] = [eq(mediaItem.mediaType, mediaType)]
  if (listening?.condition) conditions.push(listening.condition)
  conditions.push(...(options.conditions ?? []))
  if (!('includeArchived' in query) || query.includeArchived !== 'true')
    conditions.push(
      sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
    )
  const filters = [...query.filters]
  if ('tag' in query && query.tag)
    filters.push({ field: 'genre', value: query.tag, mode: 'required' })
  if ('sourceKind' in query && query.sourceKind)
    conditions.push(eq(film.sourceKind, query.sourceKind))
  const any: SQL[] = []
  for (const filter of filters) {
    if (byKey.get(filter.field)?.type !== 'text')
      throw new ServerError({ statusCode: 422, message: 'Unknown text filter' })
    const match = matchesValue(filter.field, filter.value, mediaType)
    if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else if (filter.mode === 'required') conditions.push(match)
    else any.push(match)
  }
  if (any.length) conditions.push(sql`(${sql.join(any, sql` or `)})`)
  for (const range of query.ranges) {
    const field = byKey.get(range.field)
    if (!field || field.type === 'text' || range.field === 'listeningScrobbles')
      throw new ServerError({
        statusCode: 422,
        message: 'Unknown numeric filter',
      })
    const value = numericExpression(range.field, mediaType)
    const bounds: SQL[] = [sql`${value} is not null`]
    if (range.min !== undefined) bounds.push(sql`${value} >= ${range.min}`)
    if (range.max !== undefined) bounds.push(sql`${value} <= ${range.max}`)
    const predicate = sql`(${sql.join(bounds, sql` and `)})`
    conditions.push(
      range.includeMissing
        ? sql`(${predicate} or ${value} is null)`
        : predicate,
    )
  }
  // Every word must appear in at least one text field; words may match
  // different fields.
  const textFields = fields.filter((field) => field.type === 'text')
  for (const word of new Set(query.q?.split(/\s+/).filter(Boolean))) {
    const search = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    const expressions = textFields.map(
      (field) =>
        sql`(${valueExpression(field.key, mediaType)} #>> '{}') ilike ${search}`,
    )
    conditions.push(sql`(${sql.join(expressions, sql` or `)})`)
  }
  const where = and(...conditions)
  const sort =
    sortField.key === 'listeningScrobbles' && listening?.sort
      ? listening.sort
      : options.sort?.field.key === sortField.key
        ? options.sort.expression
        : sortField.type === 'text'
          ? sql`lower(${textExpression(sortField.key, mediaType)})`
          : numericExpression(sortField.key, mediaType)
  const missing =
    options.sort?.field.key === sortField.key && options.sort.missingFirst
      ? sql`nulls first`
      : sql`nulls last`
  const order =
    query.direction === 'asc'
      ? sql`${sort} asc ${missing}`
      : sql`${sort} desc ${missing}`
  // Only a track query reads track columns; the others join nothing.
  const trackJoin =
    mediaType === 'track'
      ? eq(libraryTrack.mediaItemId, mediaItem.id)
      : sql`false`
  const base = () => {
    const query = db
      .select({
        id: mediaItem.id,
        listeningScrobbles: listening?.sort ?? sql<null>`null`,
      })
      .from(mediaItem)
      .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
      .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
      .leftJoin(libraryTrack, trackJoin)
    return listening
      ? query.leftJoin(
          listening.source,
          sql`listening_counts.album_media_item_id = ${mediaItem.id}`,
        )
      : query
  }
  // Cache the raw count by the actual predicate, including caller SQL options.
  // Page, ordering and result caps do not change membership; IDs stay uncached.
  const total = await countCache(
    JSON.stringify(
      dialect.sqlToQuery(sql`${listening?.source ?? sql``} ${where}`),
    ),
    async () => {
      const query = db
        .select({ value: sql<number>`count(*)::int` })
        .from(mediaItem)
        .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
        .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
        .leftJoin(libraryTrack, trackJoin)
      const rows = await (
        listening
          ? query.leftJoin(
              listening.source,
              sql`listening_counts.album_media_item_id = ${mediaItem.id}`,
            )
          : query
      ).where(where)
      return rows[0]?.value ?? 0
    },
  )
  const offset = (query.page - 1) * query.size
  const totalCount = Math.min(
    total,
    query.limitResults ?? Number.MAX_SAFE_INTEGER,
  )
  const rows = await base()
    .where(where)
    .orderBy(order, mediaItem.id)
    .limit(Math.min(query.size, Math.max(0, totalCount - offset)))
    .offset(offset)
  return {
    ids: rows.map((row) => row.id),
    listeningScrobbles: listening?.sort
      ? new Map(rows.map((row) => [row.id, row.listeningScrobbles ?? 0]))
      : undefined,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  }
}

const FacetRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})

export async function listBrowseFacets(
  mediaType: MediaType,
  input: Partial<BrowseFacetQuery> = {},
) {
  const query = BrowseFacetQuerySchema.parse(input)
  const fields = (await listBrowseFields(mediaType)).filter(
    (field) => field.type === 'text' && field.filterable,
  )
  const rows = await facetCache(
    JSON.stringify([mediaType, fields, query]),
    () => queryBrowseFacets(mediaType, fields, query),
  )
  return rows
    .map((row) => ({
      ...row,
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

async function queryBrowseFacets(
  mediaType: MediaType,
  fields: BrowseField[],
  query: BrowseFacetQuery,
) {
  if (!fields.length) return []
  const limit = Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / fields.length)),
  )
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const queries = fields.map((field) => {
    const value = valueExpression(field.key, mediaType)
    const trackColumns =
      mediaType === 'track'
        ? sql`left join library_track on library_track.media_item_id = media_item.id`
        : sql``
    let source: SQL = sql`select media_item.id, v.value from media_item left join film on film.media_item_id = media_item.id ${trackColumns}
      cross join lateral jsonb_array_elements_text(case when jsonb_typeof(${value}) = 'array' then ${value} else jsonb_build_array(${value}) end) v(value)
      where media_item.media_type = ${mediaType} and media_item.metadata->>'legacyHidden' is distinct from 'true'`
    const visible = sql`media_item.media_type = ${mediaType} and media_item.metadata->>'legacyHidden' is distinct from 'true'`
    if (['artist', 'director', 'actor', 'writer'].includes(field.key)) {
      source = sql`select media_item.id, a.name as value from media_item join media_credit c on c.media_item_id = media_item.id join artist a on a.id = c.artist_id where ${visible} and c.role = ${field.key}`
    } else if (mediaType === 'track' && field.key === 'genre') {
      source = sql`select media_item.id, ${normalizedTagSql(sql`t.name`)} as value from media_item join library_track lt on lt.media_item_id = media_item.id join media_item_tag mt on mt.media_item_id = lt.album_media_item_id join tag t on t.id = mt.tag_id where ${visible} and t.media_type = 'album' and not t.hidden`
    } else if (mediaType === 'album' && field.key === 'playlist') {
      source = sql`select media_item.id, p.name as value from media_item join (
        select pi.media_item_id as id, pi.playlist_id from playlist_item pi
        union
        select lt.album_media_item_id, pi.playlist_id from library_track lt
        join playlist_item pi on pi.media_item_id = lt.media_item_id
        where lt.album_media_item_id is not null
      ) member on member.id = media_item.id join playlist p on p.id = member.playlist_id where ${visible} and p.kind = 'playlist'`
    } else if (field.key === 'genre' || field.key === 'keyword') {
      source = sql`select media_item.id, ${normalizedTagSql(sql`t.name`)} as value from media_item join media_item_tag mt on mt.media_item_id = media_item.id join tag t on t.id = mt.tag_id where ${visible} and t.media_type = media_item.media_type and not t.hidden`
    } else if (field.key === 'playlist' || field.key === 'collection') {
      source = sql`select media_item.id, p.name as value from media_item join playlist_item pi on pi.media_item_id = media_item.id join playlist p on p.id = pi.playlist_id where ${visible} and p.kind = ${field.key}`
    } else if (field.key === 'provider') {
      source = sql`select media_item.id, r.provider as value from media_item join provider_reference r on r.media_item_id = media_item.id where ${visible}`
    }
    const matches = words
      .filter(
        (word) =>
          field.key === 'title' ||
          !`${field.label}:`.toLowerCase().includes(word),
      )
      .map((word) => sql`value ilike ${`%${word.replace(/[\\%_]/g, '\\$&')}%`}`)
    const search = matches.length ? sql`and ${and(...matches)}` : sql``
    // Limit each field independently so common tags never crowd out titles or
    // rarer fields. Search the full value set before counting and limiting.
    return sql`(select ${field.key}::text as field, value, count(distinct id)::int as count
      from (${source}) values_for_field
      where value is not null and value <> '' ${search}
      group by value
      order by case when lower(value) = ${query.q?.toLowerCase() ?? ''} then 0 else 1 end,
        count desc, value asc
      limit ${limit})`
  })
  const result = await db.execute(sql.join(queries, sql` union all `))
  return z.array(FacetRowSchema).parse(result.rows)
}
