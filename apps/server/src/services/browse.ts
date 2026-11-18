import { and, eq, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { alias, PgDialect } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import {
  albumBrowseFields,
  filmBrowseFields,
  trackBrowseFields,
  BrowseFieldSchema,
  BrowseFacetQuerySchema,
  type BrowseFacetQuery,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import type { AlbumQuery, FilmQuery } from '@repo/schemas/media'
import {
  trackAlbumLinkLabels,
  trackSourceLabels,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import { PersonRoleSchema } from '@repo/schemas/common'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { mediaItem, album, film, libraryTrack, mediaCredit } from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { normalizedTagSql, normalizeTagName } from './tag-state'
import { albumAddedDateExpression } from './album-added-dates'
import { createBrowseListening } from './browse-listening'
import {
  albumFirstTagRows,
  albumsWithEnoughTags,
  artistTagMemberships,
  firstArtistTag,
  firstMusicTag,
  matchingTagNames,
  sparseAlbumTags,
} from './music-tags'
import {
  albumTrackDurationExpression,
  redundantLastfmTrackIds,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
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
const trackSortAlbum = alias(mediaItem, 'track_sort_album')
const trackSortAlbumName = sql`lower(coalesce(nullif(trim(${trackSortAlbum.title}), ''), nullif(trim(${libraryTrack.albumName}), '')))`

export type BrowseQueryOptions = {
  conditions?: SQL[]
  sort?: { field: BrowseField; expression: SQL; missingFirst?: boolean }
  includeLastfmSourceRows?: boolean
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
  where lt.album_media_item_id = ${mediaItem.id}
  union
  select pi.playlist_id from track t
  join playlist_item pi on pi.media_item_id = t.track_media_item_id
  where t.album_media_item_id = ${mediaItem.id})`

function albumPlaylistRows(condition = sql`true`): SQL {
  const membership = sql`from playlist p join playlist_item pi on pi.playlist_id = p.id`
  const where = sql`where p.kind = 'playlist' and ${condition}`
  return sql`select pi.media_item_id as id, p.name as value ${membership} ${where}
    union all select lt.album_media_item_id, p.name ${membership}
      join library_track lt on lt.media_item_id = pi.media_item_id ${where}
    union all select t.album_media_item_id, p.name ${membership}
      join track t on t.track_media_item_id = pi.media_item_id ${where}`
}

function trackValueExpression(key: string): SQL | null {
  switch (key) {
    case 'source':
      return trackSourcesExpression(sql`${mediaItem.id}`, true)
    case 'spotifyMatch':
      return sql`to_jsonb(${trackSpotifyMatchExpression(sql`${libraryTrack.spotifyTrackId}`, sql`${mediaItem.sourceLabel}`, true)})`
    case 'releaseDate':
      return sql`to_jsonb(extract(epoch from coalesce(${mediaItem.releaseDate}, (select am.release_date from media_item am where am.id = ${libraryTrack.albumMediaItemId}))) * 1000)`
    case 'album':
      return sql`to_jsonb(coalesce(${libraryTrack.albumName}, (select am.title from media_item am where am.id = ${libraryTrack.albumMediaItemId})))`
    case 'albumLink':
      return sql`to_jsonb(case when ${libraryTrack.albumMediaItemId} is null then ${trackAlbumLinkLabels.unlinked}::text else ${trackAlbumLinkLabels.linked}::text end)`
    case 'dateAdded':
      return sql`to_jsonb(extract(epoch from ${libraryTrack.dateAdded}) * 1000)`
    case 'durationSec':
      return sql`to_jsonb(coalesce(${libraryTrack.durationSec}, ${albumTrackDurationExpression(sql`${libraryTrack.mediaItemId}`, sql`${libraryTrack.albumMediaItemId}`)}))`
    case 'scrobbles':
      return sql`to_jsonb(${libraryTrack.scrobbleCount})`
    case 'lastListenedAt':
      return sql`to_jsonb(extract(epoch from ${libraryTrack.lastListenedAt}) * 1000)`
    case 'albumTag':
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
    case 'albumTag':
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
  if (key === 'title') return sql`${mediaItem.title}`
  if (key === 'summary') return sql`${mediaItem.summary}`
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
  if ((mediaType === 'album' || mediaType === 'track') && key === 'artistTag') {
    const names = matchingTagNames(normalizeTagName(value), 'album')
    return sql`${mediaItem.id} in (
      select artist_tag.media_item_id from (${artistTagMemberships(mediaType, true)}) artist_tag
      where artist_tag.name_key in (${names})
    )`
  }
  if (key === 'genre' || key === 'keyword' || key === 'albumTag') {
    // Resolve merged names once for this library, not once per media/tag pair.
    const name = normalizeTagName(value)
    // A track is matched on the tags of its library album.
    const tagged =
      mediaType === 'track'
        ? sql`${libraryTrack.albumMediaItemId}`
        : sql`${mediaItem.id}`
    const tagType = mediaType === 'track' ? 'album' : mediaType
    const releaseMatch = sql`coalesce(${tagged} in (
      select mt.media_item_id from media_item_tag mt join tag t on t.id = mt.tag_id
      where t.media_type = ${tagType} and ${normalizedTagSql(sql`t.name`)} in (
        ${matchingTagNames(name, tagType)}
      )
    ), false)`
    if (key !== 'albumTag' && (mediaType === 'album' || mediaType === 'track'))
      return sql`(${releaseMatch} or (${sparseAlbumTags(tagged)} and ${matchesValue('artistTag', value, mediaType)}))`
    return releaseMatch
  }
  if (mediaType === 'album' && key === 'playlist')
    return sql`coalesce(${mediaItem.id} in (
      select id from (${albumPlaylistRows(sql`lower(p.name) = ${match}`)}) memberships
    ), false)`
  if (key === 'playlist' || key === 'collection')
    return sql`exists (select 1 from playlist_item pi join playlist p on p.id = pi.playlist_id where pi.media_item_id = ${mediaItem.id} and p.kind = ${key} and lower(p.name) = ${match})`
  if (key === 'provider')
    return sql`exists (select 1 from provider_reference r where r.media_item_id = ${mediaItem.id} and lower(r.provider) = ${match})`
  const expression = valueExpression(key, mediaType)
  return sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${expression}) = 'array' then ${expression} else jsonb_build_array(${expression}) end) filter_value(value) where lower(filter_value.value) = ${match})`
}

function browseFieldConditions(
  mediaType: MediaType,
  filters: BrowseFilter[],
  ranges: BrowseRange[],
  fields: ReadonlyMap<string, BrowseField>,
  extraMatch?: (filter: BrowseFilter) => SQL | undefined,
) {
  const conditions: SQL[] = []
  const any: SQL[] = []
  for (const filter of filters) {
    if (fields.get(filter.field)?.type !== 'text')
      throw new ServerError({ statusCode: 422, message: 'Unknown text filter' })
    const match =
      extraMatch?.(filter) ??
      matchesValue(filter.field, filter.value, mediaType)
    if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else if (filter.mode === 'required') conditions.push(match)
    else any.push(match)
  }
  if (any.length) conditions.push(sql`(${sql.join(any, sql` or `)})`)
  for (const range of ranges) {
    const field = fields.get(range.field)
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
  return conditions
}

/** Apply ordinary and source-evidence filters as one set of Browse predicates. */
export function trackBrowseFieldConditions(
  filters: BrowseFilter[],
  ranges: BrowseRange[],
  fields: BrowseField[],
  extraMatch: (filter: BrowseFilter) => SQL | undefined,
) {
  return browseFieldConditions(
    'track',
    filters,
    ranges,
    new Map(fields.map((field) => [field.key, field])),
    extraMatch,
  )
}

function browseTextSearchIds(
  mediaType: MediaType,
  fields: BrowseField[],
  search: string,
  sharedArtistTags: boolean,
) {
  // Album tags and artist tags together cover the default music Tags field.
  const expressions = fields
    .filter(
      (field) =>
        field.type === 'text' &&
        !(
          (mediaType === 'album' || mediaType === 'track') &&
          field.key === 'genre'
        ),
    )
    .map(
      (field) => sql`select id from (
      ${textRows(field.key, mediaType, { includeArchived: true, sharedArtistTags })}
    ) searchable_values where value ilike ${search}`,
    )
  return sql.join(expressions, sql` union all `)
}

export function trackBrowseSearchIds(
  search: string,
  sharedArtistTags: boolean,
) {
  return browseTextSearchIds(
    'track',
    trackBrowseFields,
    search,
    sharedArtistTags,
  )
}

// The Last.fm source filter also powers the import matching table and its links.
function requestsLastfmSource(query: BrowseQuery) {
  return query.filters.some(
    (filter) =>
      filter.field === 'source' &&
      filter.mode !== 'exclude' &&
      filter.value.toLowerCase() === trackSourceLabels.lastfm.toLowerCase(),
  )
}

async function browseQueries(
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
  if (
    mediaType === 'track' &&
    !options.includeLastfmSourceRows &&
    !requestsLastfmSource(query)
  )
    conditions.push(sql`(${mediaItem.sourceLabel} is distinct from 'lastfm' or not exists (
      ${redundantLastfmTrackIds(sql`${mediaItem.id}`)}
    ))`)
  if (query.creatorId) {
    const role = 'creatorRole' in query ? query.creatorRole : undefined
    const roles =
      mediaType === 'film'
        ? role
          ? [role]
          : PersonRoleSchema.options
        : ['artist']
    conditions.push(
      sql`exists (select 1 from ${mediaCredit} where ${and(
        eq(mediaCredit.mediaItemId, mediaItem.id),
        eq(mediaCredit.artistId, query.creatorId),
        inArray(mediaCredit.role, roles),
      )})`,
    )
  }
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
  conditions.push(
    ...browseFieldConditions(mediaType, filters, query.ranges, byKey),
  )
  // Every word must appear in at least one text field; words may match
  // different fields.
  const music = mediaType === 'album' || mediaType === 'track'
  const words = new Set(query.q?.split(/\s+/).filter(Boolean))
  const sharedArtistTags = music && words.size > 1
  const database = sharedArtistTags
    ? db.with(
        db.$with('browse_artist_tags', {}).as(artistTagMemberships(mediaType)),
      )
    : db
  for (const word of words) {
    const search = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(
      sql`${mediaItem.id} in (${browseTextSearchIds(mediaType, fields, search, sharedArtistTags)})`,
    )
  }
  const where = and(...conditions)
  const albumTagOrder =
    mediaType === 'album' && sortField.key === 'genre'
      ? albumFirstTagRows()
      : mediaType === 'album' && sortField.key === 'artistTag'
        ? sql`select media_item_id, min(name) as name
        from (${artistTagMemberships('album')}) artist_tags group by media_item_id`
        : undefined
  const sort =
    sortField.key === 'listeningScrobbles' && listening?.sort
      ? listening.sort
      : options.sort?.field.key === sortField.key
        ? options.sort.expression
        : albumTagOrder
          ? sql`lower(album_tag_order.name)`
          : browseSortExpression(sortField, mediaType)
  const missing =
    options.sort?.field.key === sortField.key && options.sort.missingFirst
      ? sql`nulls first`
      : sql`nulls last`
  const order =
    query.direction === 'asc'
      ? sql`${sort} asc ${missing}`
      : sql`${sort} desc ${missing}`
  // Library tracks always have a subtype row, also required by loadTracks.
  // The inner join lets their date ordering use an index before pagination.
  // Other libraries do not read track columns.
  const trackJoin =
    mediaType === 'track'
      ? eq(libraryTrack.mediaItemId, mediaItem.id)
      : sql`false`
  const base = (rank: SQL<number> = sql<number>`0`) => {
    const query = database
      .select({
        id: mediaItem.id,
        listeningScrobbles: listening?.sort ?? sql<null>`null`,
        rank: rank.as('rank'),
      })
      .from(mediaItem)
      .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
      .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
    const tracks =
      mediaType === 'track'
        ? query
            .innerJoin(libraryTrack, trackJoin)
            .leftJoin(
              trackSortAlbum,
              eq(trackSortAlbum.id, libraryTrack.albumMediaItemId),
            )
        : query.leftJoin(libraryTrack, trackJoin)
    const sorted = albumTagOrder
      ? tracks.leftJoin(
          sql`(${albumTagOrder}) album_tag_order`,
          sql`album_tag_order.media_item_id = ${mediaItem.id}`,
        )
      : tracks
    return listening
      ? sorted.leftJoin(
          listening.source,
          sql`listening_counts.album_media_item_id = ${mediaItem.id}`,
        )
      : sorted
  }
  // Cache the raw count by the actual predicate, including caller SQL options.
  // Page, ordering and result caps do not change membership; IDs stay uncached.
  // A listening sort without a listening filter leaves the count alone.
  const countedListening = listening?.condition ? listening : undefined
  async function readCount() {
    const total = await countCache(
      JSON.stringify(
        dialect.sqlToQuery(sql`${countedListening?.source ?? sql``} ${where}`),
      ),
      async () => {
        const query = database
          .select({ value: sql<number>`count(*)::int` })
          .from(mediaItem)
          .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
          .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
        const tracks =
          mediaType === 'track'
            ? query.innerJoin(libraryTrack, trackJoin)
            : query.leftJoin(libraryTrack, trackJoin)
        const rows = await (
          countedListening
            ? tracks.leftJoin(
                countedListening.source,
                sql`listening_counts.album_media_item_id = ${mediaItem.id}`,
              )
            : tracks
        ).where(where)
        return rows[0]?.value ?? 0
      },
    )
    return Math.min(total, query.limitResults ?? Number.MAX_SAFE_INTEGER)
  }
  const offset = (query.page - 1) * query.size
  const naturalOrder =
    mediaType === 'track' ? trackNaturalOrder(sortField.key) : []

  async function readPage(limit: number) {
    const rows = await base()
      .where(where)
      .orderBy(order, ...naturalOrder, mediaItem.id)
      .limit(limit)
      .offset(offset)
    const items = rows.slice(0, query.size)
    return {
      ids: items.map((row) => row.id),
      listeningScrobbles: listening?.sort
        ? new Map(items.map((row) => [row.id, row.listeningScrobbles ?? 0]))
        : undefined,
      hasMore: rows.length > query.size,
    }
  }
  /**
   * The IDs at the given zero-based positions of the ordered result. One pass
   * numbers the rows as far as the deepest position, where a page for each
   * position would order the result again every time.
   */
  async function readPositions(positions: number[]) {
    const ranks = [...new Set(positions)]
      .filter((position) => position < (query.limitResults ?? Infinity))
      .map((position) => position + 1)
    if (!ranks.length) return []
    const ordering = sql.join(
      [order, ...naturalOrder, sql`${mediaItem.id}`],
      sql`, `,
    )
    const ranked = base(sql<number>`row_number() over (order by ${ordering})`)
      .where(where)
      .as('ranked')
    const rows = await database
      .select({ id: ranked.id, rank: sql<number>`${ranked.rank}::int` })
      .from(ranked)
      .where(
        and(
          // Compared uncast, the upper bound lets PostgreSQL stop numbering
          // at the deepest rank.
          lte(ranked.rank, Math.max(...ranks)),
          inArray(ranked.rank, ranks),
        ),
      )
    return rows.map((row) => ({ id: row.id, position: row.rank - 1 }))
  }
  return { offset, readCount, readPage, readPositions }
}

type BrowseQuery = AlbumQuery | FilmQuery | TrackQuery

export async function queryBrowseIds(
  mediaType: MediaType,
  query: BrowseQuery,
  options: BrowseQueryOptions = {},
) {
  const { offset, readCount, readPage } = await browseQueries(
    mediaType,
    query,
    options,
  )
  const totalCount = await readCount()
  const { ids, listeningScrobbles } = await readPage(
    Math.min(query.size, Math.max(0, totalCount - offset)),
  )
  return {
    ids,
    listeningScrobbles,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  }
}

/** One extra ID determines whether the page can continue without an exact count. */
export async function queryBrowsePageIds(
  mediaType: MediaType,
  query: BrowseQuery,
) {
  const { offset, readPage } = await browseQueries(mediaType, query)
  const remaining =
    query.limitResults === undefined
      ? query.size + 1
      : Math.max(0, query.limitResults - offset)
  if (!remaining)
    return { ids: [], listeningScrobbles: undefined, hasMore: false }
  return readPage(Math.min(query.size + 1, remaining))
}

/** The IDs at arbitrary positions of a browse query's order, in one read. */
export async function queryBrowsePositions(
  mediaType: MediaType,
  query: BrowseQuery,
  positions: number[],
) {
  const { readPositions } = await browseQueries(mediaType, query)
  return readPositions(positions)
}

export async function queryBrowseCount(
  mediaType: MediaType,
  query: BrowseQuery,
  options: BrowseQueryOptions = {},
) {
  const { readCount } = await browseQueries(mediaType, query, options)
  return { totalCount: await readCount() }
}

/**
 * The query Clear filters leaves on a Browse page, or null when nothing is
 * filtered. The archived toggle and navigation scopes such as a tag stay.
 */
function unfilteredBrowseQuery<Query extends BrowseQuery>(
  query: Query,
): Query | null {
  const filtered =
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.limitResults !== undefined ||
    query.creatorId !== undefined ||
    ('listening' in query && query.listening !== undefined)
  if (!filtered) return null
  return {
    ...query,
    q: undefined,
    filters: [],
    ranges: [],
    limitResults: undefined,
    creatorId: undefined,
    creatorRole: undefined,
    listening: undefined,
  }
}

/** The filtered count and, for "N of M", the count without the page's filters. */
export async function queryBrowseCounts(
  mediaType: MediaType,
  query: BrowseQuery,
) {
  const unfiltered = unfilteredBrowseQuery(query)
  const [{ totalCount }, scope] = await Promise.all([
    queryBrowseCount(mediaType, query),
    unfiltered
      ? queryBrowseCount(mediaType, unfiltered, {
          includeLastfmSourceRows:
            mediaType === 'track' && requestsLastfmSource(query),
        })
      : undefined,
  ])
  return {
    totalCount,
    unfilteredCount: scope?.totalCount ?? totalCount,
  }
}

function directSortExpression(key: string, mediaType: MediaType): SQL | null {
  if (mediaType === 'album' && key === 'dateAdded')
    return albumAddedDateExpression
  if (mediaType === 'track') {
    const id = sql`${mediaItem.id}`
    if (key === 'genre')
      return sql`lower(${firstMusicTag(id, sql`${libraryTrack.albumMediaItemId}`)})`
    if (key === 'artistTag') return sql`lower(${firstArtistTag(id)})`
    if (key === 'artist') return firstTrackArtist(id)
    if (key === 'album') return trackSortAlbumName
    if (key === 'releaseDate')
      return sql`coalesce(${trackSortAlbum.releaseDate}, ${mediaItem.releaseDate})`
    if (key === 'dateAdded') return sql`${libraryTrack.dateAdded}`
    if (key === 'scrobbles') return sql`${libraryTrack.scrobbleCount}`
    if (key === 'lastListenedAt') return sql`${libraryTrack.lastListenedAt}`
  }
  if (key === 'releaseDate' && mediaType !== 'track')
    return sql`${mediaItem.releaseDate}`
  return null
}

function browseSortExpression(field: BrowseField, mediaType: MediaType) {
  return (
    directSortExpression(field.key, mediaType) ??
    (field.type === 'text'
      ? sql`lower(${textExpression(field.key, mediaType)})`
      : numericExpression(field.key, mediaType))
  )
}

/** Ordering for an ordinary track field over media_item, library_track and track_sort_album. */
export function trackBrowseOrder(
  sortBy: string,
  direction: TrackQuery['direction'],
) {
  const field = trackBrowseFields.find((entry) => entry.key === sortBy)
  if (!field) return
  return [
    sql`${browseSortExpression(field, 'track')} ${direction === 'desc' ? sql`desc` : sql`asc`} nulls last`,
    ...trackNaturalOrder(sortBy),
    sql`${mediaItem.id}`,
  ]
}

function firstTrackArtist(mediaItemId: SQL) {
  return sql`(select lower(a.name)
    from media_credit c join artist a on a.id = c.artist_id
    where c.media_item_id = ${mediaItemId} and c.role = 'artist'
    order by c.billing_order, a.name limit 1)`
}

/** Keep ties in a release together and in their stored playing order. */
function trackNaturalOrder(primary: string) {
  const albumId = sql`${libraryTrack.albumMediaItemId}`
  const artist = firstTrackArtist(sql`coalesce(${albumId}, ${mediaItem.id})`)
  const albumDate = sql`case when ${albumId} is null then ${mediaItem.releaseDate}
    else ${trackSortAlbum.releaseDate} end`
  const position = sql`(select min(t.position) from track t
    where t.track_media_item_id = ${mediaItem.id} and t.album_media_item_id = ${albumId})`
  const withinAlbum = [
    albumId,
    sql`case when ${albumId} is null then ${libraryTrack.spotifyAlbumId} end`,
    position,
    sql`lower(${mediaItem.title})`,
  ]
  const year = sql`extract(year from ${albumDate})`
  const grouped =
    primary === 'artist'
      ? [year, trackSortAlbumName]
      : primary === 'album'
        ? [albumDate]
        : primary === 'releaseDate'
          ? [artist, trackSortAlbumName]
          : [artist, year, trackSortAlbumName]
  return [...grouped, ...withinAlbum].map((key) => sql`${key} asc nulls last`)
}

/** Search and facets read values before aggregation so PostgreSQL can index them. */
function textRows(
  key: string,
  mediaType: MediaType,
  options: {
    includeArchived?: boolean
    normalizeTags?: boolean
    sharedArtistTags?: boolean
  } = {},
): SQL {
  const visible = options.includeArchived
    ? sql`media_item.media_type = ${mediaType}`
    : sql`media_item.media_type = ${mediaType} and media_item.metadata->>'legacyHidden' is distinct from 'true'`
  if (key === 'title')
    return sql`select media_item.id, media_item.title as value from media_item where ${visible}`
  if (key === 'summary')
    return sql`select media_item.id, media_item.summary as value from media_item where ${visible}`
  if (['artist', 'director', 'actor', 'writer'].includes(key))
    return sql`select media_item.id, a.name as value from media_item join media_credit c on c.media_item_id = media_item.id join artist a on a.id = c.artist_id where ${visible} and c.role = ${key}`
  if (mediaType === 'track' && key === 'album')
    return sql`select media_item.id, lt.album_name as value from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.album_name is not null
      union all
      select media_item.id, am.title as value from media_item join library_track lt on lt.media_item_id = media_item.id join media_item am on am.id = lt.album_media_item_id where ${visible} and lt.album_name is null`
  if (mediaType === 'track' && key === 'source')
    return sql`select media_item.id, ${trackSourceLabels.spotify}::text as value from media_item join playlist_item pi on pi.media_item_id = media_item.id join playlist p on p.id = pi.playlist_id where ${visible} and p.source = 'spotify'
      union all
      select media_item.id, ${trackSourceLabels['spotify-liked']}::text as value from media_item join playlist_item pi on pi.media_item_id = media_item.id join playlist p on p.id = pi.playlist_id where ${visible} and p.source = 'spotify-liked'
      union all
      select media_item.id, ${trackSourceLabels.album}::text as value from media_item join track t on t.track_media_item_id = media_item.id where ${visible}
      union all
      select media_item.id, ${trackSourceLabels.lastfm}::text as value from media_item join lastfm_track_source s on s.track_media_item_id = media_item.id where ${visible}`
  if (mediaType === 'track' && key === 'albumLink')
    return sql`select media_item.id, ${trackAlbumLinkLabels.linked}::text as value from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.album_media_item_id is not null
      union all
      select media_item.id, ${trackAlbumLinkLabels.unlinked}::text as value from media_item left join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.album_media_item_id is null`
  if (mediaType === 'track' && key === 'spotifyMatch')
    return sql`select media_item.id,
      ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`media_item.source_label`, true)} as value
      from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible}`
  const tagName = options.normalizeTags
    ? normalizedTagSql(sql`t.name`)
    : sql`t.name`
  if (
    (mediaType === 'album' || mediaType === 'track') &&
    (key === 'genre' || key === 'artistTag')
  ) {
    const mediaId = sql`media_item.id`
    const albumId =
      mediaType === 'track' ? sql`lt.album_media_item_id` : mediaId
    const value = options.normalizeTags
      ? sql`artist_tag.name_key`
      : sql`artist_tag.name`
    const trackJoin =
      mediaType === 'track'
        ? sql`join library_track lt on lt.media_item_id = media_item.id`
        : sql``
    const membership = options.sharedArtistTags
      ? sql`select media_item_id, name, name_key from browse_artist_tags`
      : artistTagMemberships(mediaType)
    const artistSource = sql`select media_item.id, ${value} as value
      from (${membership}) artist_tag
      join media_item on media_item.id = artist_tag.media_item_id ${trackJoin}
      where ${visible}`
    if (key === 'artistTag') return artistSource
    return sql`${textRows('albumTag', mediaType, options)}
      union all ${artistSource} and (${albumId} is null or ${albumId} not in (${albumsWithEnoughTags()}))`
  }
  if (mediaType === 'track' && key === 'albumTag')
    return sql`select media_item.id, ${tagName} as value from media_item join library_track lt on lt.media_item_id = media_item.id join media_item_tag mt on mt.media_item_id = lt.album_media_item_id join tag t on t.id = mt.tag_id where ${visible} and t.media_type = 'album' and not t.hidden`
  if (mediaType === 'album' && key === 'playlist')
    return sql`select media_item.id, member.value from media_item
      join (${albumPlaylistRows()}) member on member.id = media_item.id where ${visible}`
  if (key === 'genre' || key === 'keyword' || key === 'albumTag')
    return sql`select media_item.id, ${tagName} as value from media_item join media_item_tag mt on mt.media_item_id = media_item.id join tag t on t.id = mt.tag_id where ${visible} and t.media_type = media_item.media_type and not t.hidden`
  if (key === 'playlist' || key === 'collection')
    return sql`select media_item.id, p.name as value from media_item join playlist_item pi on pi.media_item_id = media_item.id join playlist p on p.id = pi.playlist_id where ${visible} and p.kind = ${key}`
  if (key === 'provider')
    return sql`select media_item.id, r.provider as value from media_item join provider_reference r on r.media_item_id = media_item.id where ${visible}`
  if (key === 'source')
    return sql`select media_item.id, coalesce(media_item.source_label, film.source_kind) as value from media_item left join film on film.media_item_id = media_item.id where ${visible}`
  const value = valueExpression(key, mediaType)
  const trackColumns =
    mediaType === 'track'
      ? sql`left join library_track on library_track.media_item_id = media_item.id`
      : sql``
  return sql`select media_item.id, v.value from media_item left join film on film.media_item_id = media_item.id ${trackColumns}
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(${value}) = 'array' then ${value} else jsonb_build_array(${value}) end) v(value)
    where ${visible}`
}

const FacetRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})

export async function listBrowseFacets(
  mediaType: MediaType,
  input: Partial<BrowseFacetQuery> = {},
  options: { includeLastfmSourceRows?: boolean } = {},
) {
  const query = BrowseFacetQuerySchema.parse(input)
  const fields = (await listBrowseFields(mediaType)).filter(
    (field) => field.type === 'text' && field.filterable,
  )
  const rows = await facetCache(
    JSON.stringify([mediaType, fields, query, options]),
    () => queryBrowseFacets(mediaType, fields, query, options),
  )
  return rows
    .map((row) => ({
      ...row,
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function browseFacetRows(
  field: BrowseField,
  source: SQL,
  query: BrowseFacetQuery,
  limit: number,
  visibility = sql``,
) {
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const matches = words
    .filter(
      (word) =>
        field.key === 'title' ||
        !`${field.label}:`.toLowerCase().includes(word),
    )
    .map((word) => sql`value ilike ${`%${word.replace(/[\\%_]/g, '\\$&')}%`}`)
  const search = matches.length ? sql`and ${and(...matches)}` : sql``
  // Limit each field independently so common values never crowd out other fields.
  return sql`(select ${field.key}::text as field, value, count(distinct id)::int as count
    from (${source}) values_for_field
    where value is not null and value <> '' ${search} ${visibility}
    group by value
    order by case when lower(value) = ${query.q?.toLowerCase() ?? ''} then 0 else 1 end,
      count desc, value asc
    limit ${limit})`
}

async function queryBrowseFacets(
  mediaType: MediaType,
  fields: BrowseField[],
  query: BrowseFacetQuery,
  options: { includeLastfmSourceRows?: boolean },
) {
  if (!fields.length) return []
  const limit = Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / fields.length)),
  )
  const sharedArtistTags = mediaType === 'album' || mediaType === 'track'
  const sources = sharedArtistTags
    ? sql`with browse_artist_tags as materialized (${artistTagMemberships(mediaType)})`
    : sql``
  const redundant =
    mediaType === 'track' && !options.includeLastfmSourceRows
      ? sql`, redundant_lastfm_tracks as materialized (${redundantLastfmTrackIds()})`
      : sql``
  const queries = fields.map((field) => {
    const source = textRows(field.key, mediaType, {
      normalizeTags: true,
      sharedArtistTags,
    })
    // Choosing the Last.fm source explicitly includes its retained source rows.
    const visibility =
      mediaType !== 'track' || options.includeLastfmSourceRows
        ? sql``
        : field.key === 'source'
          ? sql`and (value = ${trackSourceLabels.lastfm} or id not in (select id from redundant_lastfm_tracks))`
          : sql`and id not in (select id from redundant_lastfm_tracks)`
    return browseFacetRows(
      field,
      source,
      query,
      limit,
      options.includeLastfmSourceRows && mediaType === 'track'
        ? sql`and id in (select media_item_id from library_track)`
        : visibility,
    )
  })
  const result = await db.execute(
    sql`${sources}${redundant} ${sql.join(queries, sql` union all `)}`,
  )
  return z.array(FacetRowSchema).parse(result.rows)
}
