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
  TrackSourceSchema,
  trackAlbumLinkLabels,
  trackSourceLabels,
  type TrackQuery,
} from '@repo/schemas/tracks'
import {
  defaultListeningPeriod,
  listeningHistogramEdges,
  type ListeningHistogram,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import { PersonRoleSchema } from '@repo/schemas/common'
import { formatTagName } from '@repo/schemas/tags'
import { rangeCondition, timestampRangeCondition } from '@/lib/browse-range'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { checksumJson } from '@/lib/media-utils'
import {
  mediaItem,
  album,
  film,
  libraryTrack,
  mediaCredit,
  mediaOverride,
} from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { albumMatchRejectionField } from './album-match-rejections'
import { normalizedTagSql, normalizeTagName } from './tag-state'
import { tagAncestorRows, visibleSubtagCounts } from './tag-hierarchy'
import { albumAddedDateExpression } from './album-added-dates'
import { createBrowseListening, type BrowseListening } from './browse-listening'
import {
  firstMusicTagRows,
  albumsWithEnoughTags,
  artistTagFacetKeys,
  artistTagMemberships,
  firstArtistTag,
  firstMusicTag,
  mediaIdsWithArtistTag,
  matchingTagNames,
  sparseAlbumTags,
} from './music-tags'
import {
  albumTrackDurationExpression,
  redundantLastfmTrackIds,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
} from './track-values'
import {
  recordingCount,
  recordingDates,
  recordingGroupProjection,
  recordingGroupValue,
  recordingListening,
  recordingMemberships,
  recordingRepresentatives,
  recordingVersionMembers,
  RecordingGroupPositionRowsSchema,
  RecordingGroupRowsSchema,
  type RecordingGroup,
  type RecordingGroupRow,
} from './recording-groups'

type MediaType = 'album' | 'film' | 'track'

const countCache = createDatabaseReadCache<number>({
  maxEntries: 128,
  maxValueBytes: 64,
})
const recordingPageCache = createDatabaseReadCache<RecordingGroupRow[]>({
  maxEntries: 32,
  maxValueBytes: 32 * 1024,
})
const facetCache = createDatabaseReadCache<FacetRow[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})
const histogramCache = createDatabaseReadCache<number[]>({
  maxEntries: 64,
  maxValueBytes: 256,
})
const dialect = new PgDialect()
const trackSortAlbum = alias(mediaItem, 'track_sort_album')
const trackSortAlbumName = sql`lower(coalesce(nullif(trim(${trackSortAlbum.title}), ''), nullif(trim(${libraryTrack.albumName}), '')))`

type BrowsePosition = {
  id: string
  position: number
  recordingGroup?: RecordingGroup
  listeningScrobbles?: number
}

const TrackRankRowsSchema = z.array(
  z.object({
    id: z.string(),
    rank: z.number().int().positive(),
    listeningScrobbles: z.number().int().nonnegative().nullable(),
  }),
)

/** The one-based histogram bar of a count: how many edges are at or below it. */
function listeningBar(value: SQL, edges: readonly number[]) {
  return sql<number>`width_bucket(${value}, array[${sql.join(
    edges.map((edge) => sql`${edge}::int`),
    sql`, `,
  )}])::int`
}

const HistogramRowsSchema = z.array(
  z.object({
    bar: z.number().int().positive(),
    count: z.number().int().nonnegative(),
  }),
)

function listeningHistogramCounts(edges: readonly number[], rows: unknown) {
  const bars = new Map(
    HistogramRowsSchema.parse(rows).map((row) => [row.bar, row.count]),
  )
  return edges.map((_, index) => bars.get(index + 1) ?? 0)
}

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
      return trackSourcesExpression(
        sql`${mediaItem.id}`,
        sql`${mediaItem.metadata}`,
        true,
      )
    case 'spotifyMatch':
      return sql`to_jsonb(${trackSpotifyMatchExpression(sql`${libraryTrack.spotifyTrackId}`, sql`${mediaItem.sourceLabel}`, true)})`
    case 'album':
      return sql`to_jsonb(coalesce(${libraryTrack.albumName}, (select am.title from media_item am where am.id = ${libraryTrack.albumMediaItemId})))`
    case 'albumLink':
      return sql`to_jsonb(case when ${libraryTrack.albumMediaItemId} is null then ${trackAlbumLinkLabels.unlinked}::text else ${trackAlbumLinkLabels.linked}::text end)`
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
    case 'ratingMetacriticValue':
    case 'ratingMetacriticVotes':
      if (mediaType === 'album')
        return sql`(case when not exists (
          select 1 from ${mediaOverride} where ${mediaOverride.mediaItemId} = ${mediaItem.id}
            and ${mediaOverride.field} = ${albumMatchRejectionField}
            and ${mediaOverride.value}->>'provider' = 'google-custom-search'
            and ${mediaOverride.value}->>'referenceType' = 'metacritic-url'
        ) then ${mediaItem.metadata}->'browse'->${key}::text end)`
      return sql`(${mediaItem.metadata}->'browse'->${key}::text)`
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
  // Built-in metrics have typed columns. Keep them visible to PostgreSQL for
  // range scans and evaluate release fallbacks only when their field is used.
  switch (key) {
    case 'dateAdded':
      if (mediaType === 'track')
        return sql`extract(epoch from ${libraryTrack.dateAdded}) * 1000`
      if (mediaType === 'film')
        return sql`extract(epoch from coalesce(${film.dateAdded}, ${mediaItem.createdAt})) * 1000`
      return sql`extract(epoch from ${albumAddedDateExpression}) * 1000`
    case 'releaseDate':
      return mediaType === 'track'
        ? sql`extract(epoch from coalesce(${mediaItem.releaseDate}, (select am.release_date from media_item am where am.id = ${libraryTrack.albumMediaItemId}))) * 1000`
        : sql`extract(epoch from ${mediaItem.releaseDate}) * 1000`
    case 'updatedAt':
      return sql`extract(epoch from ${mediaItem.updatedAt}) * 1000`
    case 'durationSec':
      return mediaType === 'track'
        ? sql`coalesce(${libraryTrack.durationSec}, ${albumTrackDurationExpression(sql`${libraryTrack.mediaItemId}`, sql`${libraryTrack.albumMediaItemId}`)})`
        : sql`${album.durationSec}`
    case 'trackCount':
      return sql`${album.trackCount}`
    case 'runtimeMinutes':
      return sql`${film.runtimeMinutes}`
    case 'budget':
      return sql`${film.budget}`
    case 'boxOffice':
      return sql`${film.boxOffice}`
    case 'scrobbles':
      if (mediaType === 'track') return sql`${libraryTrack.scrobbleCount}`
      break
    case 'lastListenedAt':
      if (mediaType === 'track')
        return sql`extract(epoch from ${libraryTrack.lastListenedAt}) * 1000`
      break
  }
  const value = valueExpression(key, mediaType)
  return sql`case when jsonb_typeof(${value}) = 'number' then (${value} #>> '{}')::numeric else null end`
}

function matchesValue(key: string, value: string, mediaType: MediaType): SQL {
  const match = sql`lower(${value}::text)`
  if (mediaType === 'track' && key === 'source') {
    const source = TrackSourceSchema.options.find(
      (source) =>
        trackSourceLabels[source].toLowerCase() === value.toLowerCase(),
    )
    switch (source) {
      case 'album':
        return sql`exists (select 1 from track t where t.track_media_item_id = ${mediaItem.id})`
      case 'lastfm':
        return sql`exists (select 1 from lastfm_track_source s where s.track_media_item_id = ${mediaItem.id})`
      case 'spotify':
      case 'spotify-liked':
        return sql`exists (select 1 from playlist_item pi join playlist p on p.id = pi.playlist_id
          where pi.media_item_id = ${mediaItem.id} and p.source = ${source})`
      case 'spotify-search':
        return sql`coalesce(${mediaItem.metadata} ? 'spotifyTrackSearch', false)`
      case undefined:
        return sql`false`
    }
  }
  if (['artist', 'director', 'actor', 'writer'].includes(key)) {
    return sql`exists (select 1 from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = ${mediaItem.id} and c.role = ${key} and lower(a.name) = ${match})`
  }
  if ((mediaType === 'album' || mediaType === 'track') && key === 'artistTag')
    return sql`${mediaType === 'track' ? libraryTrack.mediaItemId : mediaItem.id} in (${mediaIdsWithArtistTag(normalizeTagName(value))})`
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
    const timestamp =
      range.field === 'releaseDate' && mediaType !== 'track'
        ? sql`${mediaItem.releaseDate}`
        : range.field === 'dateAdded' && mediaType === 'track'
          ? sql`${libraryTrack.dateAdded}`
          : undefined
    conditions.push(
      timestamp
        ? timestampRangeCondition(range, timestamp)
        : rangeCondition(range, numericExpression(range.field, mediaType)),
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

function browseRanks(positions: number[], limitResults?: number) {
  return [...new Set(positions)]
    .filter((position) => position < (limitResults ?? Infinity))
    .map((position) => position + 1)
}

function groupedTrackBrowse(
  query: TrackQuery,
  where: SQL | undefined,
  sort: SQL,
  naturalOrder: SQL[],
  sharedArtistTags: boolean,
  orderRows: SQL | undefined,
  listening: BrowseListening | undefined,
  countedListening: BrowseListening | undefined,
  versionId?: string,
) {
  const matches = db
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(
      versionId !== undefined
        ? and(
            where,
            sql`${mediaItem.id} in (select id from recording_version_tracks)`,
          )
        : where,
    )
  const memberships = sql`with ${
    sharedArtistTags
      ? sql`browse_artist_tags as (${artistTagMemberships('track')}), `
      : sql``
  }${recordingMemberships(matches, { creatorId: query.creatorId, versionId })}`
  const groupRanges = query.ranges.flatMap((range) => {
    const value = recordingGroupValue(range.field)
    if (!value) return []
    return rangeCondition(
      range,
      range.field === 'scrobbles'
        ? value
        : sql`extract(epoch from ${value}) * 1000`,
    )
  })
  const groupKey = sql`g.group_key`
  const groupConditions = (requested?: BrowseListening) =>
    and(...groupRanges, requested?.condition('recording', groupKey))
  const groupJoins = (requested?: BrowseListening, members?: SQL) => {
    const source = requested?.source('recording', members)
    return source
      ? sql`left join ${source} on listening_counts.id = ${groupKey}`
      : sql``
  }
  const groupCondition = groupConditions(listening)
  const groupPredicate = groupCondition ? sql`where ${groupCondition}` : sql``
  const groupListening = groupJoins(listening)
  const countedGroupCondition = groupConditions(countedListening)
  const countedGroupListening = groupJoins(countedListening)
  const listeningValue = sql`${listening?.sort ?? sql`null::int`} as listening_scrobbles`
  // Period counts are added up over every matching track of a group.
  const members = sql`${memberships}, ${recordingVersionMembers}`
  const scoped = listening ? members : memberships
  const representatives = recordingRepresentatives()
  const groupStats = sql`${representatives}, ${recordingListening}`
  const grouped = sql`${scoped}, ${groupStats}`
  const hasListeningRange = query.ranges.some(
    (range) => range.field === 'scrobbles' || range.field === 'lastListenedAt',
  )
  const rangeStats = hasListeningRange
    ? groupStats
    : sql`${representatives}, ${recordingDates}`
  const rangeMemberships = groupRanges.length
    ? sql`${members}, ${rangeStats}`
    : members
  const rangeGroups = groupRanges.length
    ? hasListeningRange
      ? sql`recording_stats`
      : sql`recording_dates`
    : sql`(select distinct group_key from recording_members)`
  // The period count is a group value too; rows carry it as a column.
  const listeningSorted =
    query.sortBy === 'listeningScrobbles' ? listening?.sort : undefined
  const groupSort = recordingGroupValue(query.sortBy) ?? listeningSorted
  const rowSort = listeningSorted
    ? sql`g.listening_scrobbles`
    : (groupSort ?? sql`g.primary_value`)
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const primaryOrdering = (primary: SQL) =>
    sql`${primary} ${direction} nulls last`
  const ordering = (primary: SQL) =>
    sql.join(
      [primaryOrdering(primary), ...naturalOrder, sql`${mediaItem.id}`],
      sql`, `,
    )
  const trackColumns = sql`
    join ${libraryTrack} on ${libraryTrack.mediaItemId} = ${mediaItem.id}
    left join ${mediaItem} as ${trackSortAlbum} on ${trackSortAlbum.id} = ${libraryTrack.albumMediaItemId}`
  const orderRowsJoin = orderRows
    ? sql`left join (${orderRows}) field_order on field_order.media_item_id = ${mediaItem.id}`
    : sql``
  // Resolve release order only for rows that can reach the page. Keep every
  // tie at the boundary so page and position reads use the same total order.
  function groupRows(bound: number) {
    const columns = groupSort ? sql`` : sql`, ${sort} as primary_value`
    const sortJoins = groupSort
      ? sql``
      : sql`join ${mediaItem} on ${mediaItem.id} = g.id ${trackColumns} ${orderRowsJoin}`
    return sql`from (
      select g.*, ${listeningValue}${columns}
      from recording_stats g
      ${groupListening} ${sortJoins} ${groupPredicate}
      order by ${primaryOrdering(groupSort ?? sort)}
      fetch first (${bound}) rows with ties
    ) g join ${mediaItem} on ${mediaItem.id} = g.id ${trackColumns}`
  }
  const offset = (query.page - 1) * query.size

  async function readCount() {
    const counted = countedGroupCondition
      ? sql`${rangeMemberships} select count(*)::int as value from ${rangeGroups} g
        ${countedGroupListening} where ${countedGroupCondition}`
      : sql`${memberships} ${recordingCount}`
    const total = await countCache(
      checksumJson(dialect.sqlToQuery(counted)),
      async () => {
        const { rows } = await db.execute(counted)
        return z
          .object({ value: z.number().int().nonnegative() })
          .parse(rows[0]).value
      },
    )
    return Math.min(total, query.limitResults ?? Number.MAX_SAFE_INTEGER)
  }

  async function readPage(limit: number) {
    const page = sql`${grouped}
      select ${recordingGroupProjection}, g.listening_scrobbles
      ${groupRows(offset + limit)}
      order by ${ordering(rowSort)} limit ${limit} offset ${offset}`
    const rows = await recordingPageCache(
      checksumJson(dialect.sqlToQuery(page)),
      async () => RecordingGroupRowsSchema.parse((await db.execute(page)).rows),
    )
    const items = rows.slice(0, query.size)
    return {
      ids: items.map((row) => row.id),
      listeningScrobbles: listening?.sort
        ? new Map(items.map((row) => [row.id, row.listening_scrobbles ?? 0]))
        : undefined,
      recordingGroups: new Map(items.map((row) => [row.id, row])),
      hasMore: rows.length > query.size,
    }
  }

  async function readPositions(positions: number[]): Promise<BrowsePosition[]> {
    const ranks = browseRanks(positions, query.limitResults)
    if (!ranks.length) return []
    const deepest = Math.max(...ranks)
    const { rows } = await db.execute(sql`${grouped}, ranked as (
      select ${recordingGroupProjection}, g.listening_scrobbles,
        row_number() over (order by ${ordering(rowSort)}) as rank
      ${groupRows(deepest)}
    ) select id, version_count, scrobbles, last_listened_at, date_added,
        listening_scrobbles, rank::int
      from ranked where rank <= ${deepest} and ${inArray(sql`rank`, ranks)} order by rank`)
    return RecordingGroupPositionRowsSchema.parse(rows).map(
      ({ rank, listening_scrobbles, ...recordingGroup }) => ({
        id: recordingGroup.id,
        position: rank - 1,
        recordingGroup,
        ...(listening?.sort
          ? { listeningScrobbles: listening_scrobbles ?? 0 }
          : {}),
      }),
    )
  }

  async function readVersions(id: string) {
    const targetMembers = sql`target_recording_members`
    const target = sql`(select group_key from recording_members where id = ${id})`
    const scopedVersions = sql`${countedGroupCondition ? rangeMemberships : members},
      target_recording_members as materialized (
        select id, group_key from recording_members where group_key = ${target}
      )`
    const eligibleGroups = countedGroupCondition
      ? sql`, eligible as (
          select g.group_key from ${rangeGroups} g
          ${groupJoins(countedListening, targetMembers)}
          where g.group_key = ${target} and ${countedGroupCondition}
        )`
      : sql``
    // Versions are tracks, so they carry and sort by their own counts.
    const versionSource = listening?.sort
      ? listening.source('track', targetMembers)
      : undefined
    const versionListening = versionSource
      ? sql`left join ${versionSource} on listening_counts.id = m.id`
      : sql``
    const { rows } = await db.execute(sql`${scopedVersions}${eligibleGroups}
    select m.id, ${listeningValue} from ${targetMembers} m
    ${countedGroupCondition ? sql`join eligible on eligible.group_key = m.group_key` : sql``}
    join ${mediaItem} on ${mediaItem.id} = m.id ${trackColumns} ${orderRowsJoin} ${versionListening}
    order by ${ordering(sort)} limit ${query.size + 1} offset ${offset}`)
    const versions = z
      .array(
        z.object({
          id: z.string(),
          listening_scrobbles: z.number().int().nonnegative().nullable(),
        }),
      )
      .parse(rows)
      .slice(0, query.size)
    return {
      ids: versions.map((row) => row.id),
      listeningScrobbles: listening?.sort
        ? new Map(versions.map((row) => [row.id, row.listening_scrobbles ?? 0]))
        : undefined,
      hasMore: rows.length > query.size,
    }
  }

  /** Recording groups per bar of the sort period's count, in one read. */
  async function readHistogram(value: SQL, edges: readonly number[]) {
    const counted = sql`${rangeMemberships} select ${listeningBar(value, edges)} as bar,
      count(*)::int as count from ${rangeGroups} g ${groupListening} ${groupPredicate}
      group by bar`
    return histogramCache(checksumJson(dialect.sqlToQuery(counted)), async () =>
      listeningHistogramCounts(edges, (await db.execute(counted)).rows),
    )
  }
  const listeningSort = listening?.sort

  return {
    offset,
    readCount,
    readPage,
    readPositions,
    readVersions,
    readHistogram: listeningSort
      ? (edges: readonly number[]) => readHistogram(listeningSort, edges)
      : undefined,
  }
}

async function browseQueries(
  mediaType: MediaType,
  query: AlbumQuery | FilmQuery | TrackQuery,
  options: BrowseQueryOptions = {},
  versionId?: string,
) {
  const fields = await listBrowseFields(mediaType)
  const listeningFilter = 'listening' in query ? query.listening : undefined
  const listeningPeriod =
    'listeningSort' in query ? query.listeningSort : undefined
  if (
    mediaType === 'film' &&
    (listeningFilter ||
      listeningPeriod ||
      query.sortBy === 'listeningScrobbles')
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Listening controls are not available for films',
    })
  const now = new Date()
  const listening =
    mediaType === 'film'
      ? undefined
      : createBrowseListening(
          listeningFilter,
          listeningPeriod ??
            (query.sortBy === 'listeningScrobbles'
              ? defaultListeningPeriod
              : undefined),
          now,
        )
  // Only listening rules affect the total. Keep sort periods out of its read.
  const countedListening = listening?.sort
    ? createBrowseListening(listeningFilter, undefined, now)
    : listening
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
  const groupedTrackQuery =
    mediaType === 'track' && 'groupRecordings' in query && query.groupRecordings
      ? query
      : undefined
  const conditions: SQL[] = [eq(mediaItem.mediaType, mediaType)]
  // A playlist member already has a library identity.
  const hideRedundant =
    mediaType === 'track' &&
    !options.includeLastfmSourceRows &&
    !requestsLastfmSource(query) &&
    !query.filters.some(
      (chip) => chip.field === 'playlist' && chip.mode === 'required',
    )
  const visibleTrack = hideRedundant
    ? sql`(${mediaItem.sourceLabel} is distinct from 'lastfm' or
    ${mediaItem.id} not in (${redundantLastfmTrackIds()}))`
    : undefined
  if (visibleTrack && groupedTrackQuery) conditions.push(visibleTrack)
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
    ...browseFieldConditions(
      mediaType,
      filters,
      groupedTrackQuery
        ? query.ranges.filter((range) => !recordingGroupValue(range.field))
        : query.ranges,
      byKey,
    ),
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
  const orderRows =
    versionId || (mediaType === 'track' && query.creatorId)
      ? undefined
      : browseOrderRows(mediaType, sortField.key)
  const sort =
    sortField.key === 'listeningScrobbles' && listening?.sort
      ? listening.sort
      : options.sort?.field.key === sortField.key
        ? options.sort.expression
        : orderRows
          ? sql`lower(field_order.name)`
          : browseSortExpression(sortField, mediaType)
  const naturalOrder =
    mediaType === 'track' ? trackNaturalOrder(sortField.key) : []
  if (groupedTrackQuery)
    return groupedTrackBrowse(
      groupedTrackQuery,
      where,
      sort,
      naturalOrder,
      sharedArtistTags,
      orderRows,
      listening,
      countedListening,
      versionId,
    )
  const order = fieldOrder(sort, sortField.key, query.direction, options.sort)
  // Library tracks always have a subtype row, also required by loadTracks.
  // The inner join lets their date ordering use an index before pagination.
  // Other libraries do not read track columns.
  const trackJoin =
    mediaType === 'track'
      ? eq(libraryTrack.mediaItemId, mediaItem.id)
      : sql`false`
  const listeningJoin = sql`listening_counts.id = ${mediaItem.id}`
  const listeningSubject = mediaType === 'track' ? 'track' : 'album'
  const itemConditions = (requested?: BrowseListening) =>
    and(where, requested?.condition(listeningSubject, sql`${mediaItem.id}`))
  // An ordered Added page can stop at its limit. Probe only source records
  // encountered while walking that index, keeping full-set work for counts.
  const pageVisibility =
    hideRedundant &&
    query.sortBy === 'dateAdded' &&
    query.direction === 'desc' &&
    !query.filters.length
      ? sql`(${mediaItem.sourceLabel} is distinct from 'lastfm' or not exists (
        ${redundantLastfmTrackIds(sql`${mediaItem.id}`)}
      ))`
      : visibleTrack
  const pageWhere = and(itemConditions(listening), pageVisibility)
  const pageSource = listening?.source(listeningSubject)
  const countWhere = and(itemConditions(countedListening), visibleTrack)
  const countSource = countedListening?.source(listeningSubject)
  const base = (rank: SQL<number> = sql<number>`0`, ordinal?: SQL<number>) => {
    const query = database
      .select({
        id: mediaItem.id,
        listeningScrobbles: sql<
          number | null
        >`${listening?.sort ?? sql`null`}`.as('listening_scrobbles'),
        ...(ordinal ? { ordinal: ordinal.as('ordinal') } : {}),
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
    const sorted = orderRows
      ? tracks.leftJoin(
          sql`(${orderRows}) field_order`,
          sql`field_order.media_item_id = ${mediaItem.id}`,
        )
      : tracks
    return pageSource ? sorted.leftJoin(pageSource, listeningJoin) : sorted
  }
  // Cache the raw count by the actual predicate, including caller SQL options.
  // Page, ordering and result caps do not change membership; IDs stay uncached.
  async function readCount() {
    const total = await countCache(
      checksumJson(
        dialect.sqlToQuery(sql`${countSource ?? sql``} ${countWhere}`),
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
          countSource ? tracks.leftJoin(countSource, listeningJoin) : tracks
        ).where(countWhere)
        return rows[0]?.value ?? 0
      },
    )
    return Math.min(total, query.limitResults ?? Number.MAX_SAFE_INTEGER)
  }
  const offset = (query.page - 1) * query.size
  const indexedTrackOrder =
    mediaType === 'track' &&
    (sortField.key === 'title' || sortField.key === 'dateAdded') &&
    options.sort?.field.key !== sortField.key

  async function readTrackRanks(
    ranks: number[] | { first: number; last: number },
  ) {
    const last = Array.isArray(ranks) ? Math.max(...ranks) : ranks.last
    const requested = Array.isArray(ranks)
      ? sql`= any(${sql.param(ranks)}::bigint[])`
      : sql`between ${ranks.first}::bigint and ${last}::bigint`
    const primaryRanks = Array.isArray(ranks)
      ? sql`in (select rank from primary_tracks where ordinal ${requested})`
      : sql`between (select rank from primary_tracks where ordinal = ${ranks.first}::bigint)
          and ${last}::bigint`
    const prefix = base(
      sql<number>`rank() over (order by ${order})`,
      sql<number>`row_number() over (order by ${order})`,
    )
      .where(and(itemConditions(listening), visibleTrack))
      .orderBy(order)
    // Walk the primary order without resolving the release order of skipped
    // rows. Every row tied with a requested rank must be available, including
    // ties before the first requested rank and after the last one.
    const result = await db.execute(sql`with primary_tracks as materialized (
        ${prefix} fetch first (${last}) rows with ties
      ), selected_tracks as materialized (
        select id, listening_scrobbles, rank as first_rank from primary_tracks
        where rank ${primaryRanks}
      ), ranked_tracks as (
        select p.id, p.listening_scrobbles,
          p.first_rank + row_number() over (
            partition by p.first_rank
            order by ${sql.join([...naturalOrder, sql`${mediaItem.id}`], sql`, `)}
          ) - 1 as rank
        from selected_tracks p
        join ${mediaItem} on ${mediaItem.id} = p.id
        join ${libraryTrack} on ${libraryTrack.mediaItemId} = p.id
        left join ${mediaItem} as ${trackSortAlbum}
          on ${trackSortAlbum.id} = ${libraryTrack.albumMediaItemId}
      )
      select id, listening_scrobbles as "listeningScrobbles", rank::int
      from ranked_tracks where rank ${requested} order by rank`)
    return TrackRankRowsSchema.parse(result.rows)
  }

  async function readPage(limit: number) {
    // Keep the direct limit for early pages, where there are few ties to skip.
    const rows =
      indexedTrackOrder && limit > 0 && offset >= 3 * limit
        ? await readTrackRanks({ first: offset + 1, last: offset + limit })
        : await base()
            .where(pageWhere)
            .orderBy(order, ...naturalOrder, mediaItem.id)
            .limit(limit)
            .offset(offset)
    const items = rows.slice(0, query.size)
    return {
      ids: items.map((row) => row.id),
      listeningScrobbles: listening?.sort
        ? new Map(items.map((row) => [row.id, row.listeningScrobbles ?? 0]))
        : undefined,
      recordingGroups: undefined,
      hasMore: rows.length > query.size,
    }
  }
  /**
   * The IDs at the given zero-based positions of the ordered result. One pass
   * numbers the rows as far as the deepest position, where a page for each
   * position would order the result again every time.
   */
  async function readPositions(positions: number[]): Promise<BrowsePosition[]> {
    const ranks = browseRanks(positions, query.limitResults)
    if (!ranks.length) return []
    const deepest = Math.max(...ranks)
    if (indexedTrackOrder && deepest >= 4 * ranks.length)
      return (await readTrackRanks(ranks)).map((row) => ({
        id: row.id,
        position: row.rank - 1,
        ...(listening?.sort
          ? { listeningScrobbles: row.listeningScrobbles ?? 0 }
          : {}),
      }))
    const ordering = sql.join(
      [order, ...naturalOrder, sql`${mediaItem.id}`],
      sql`, `,
    )
    const ranked = base(sql<number>`row_number() over (order by ${ordering})`)
      .where(pageWhere)
      .as('ranked')
    const rows = await database
      .select({
        id: ranked.id,
        rank: sql<number>`${ranked.rank}::int`,
        listeningScrobbles: ranked.listeningScrobbles,
      })
      .from(ranked)
      .where(
        and(
          // Compared uncast, the upper bound lets PostgreSQL stop numbering
          // at the deepest rank.
          lte(ranked.rank, deepest),
          inArray(ranked.rank, ranks),
        ),
      )
    return rows.map((row) => ({
      id: row.id,
      position: row.rank - 1,
      ...(listening?.sort
        ? { listeningScrobbles: row.listeningScrobbles ?? 0 }
        : {}),
    }))
  }
  /** Items per bar of the sort period's count, in one aggregate read. */
  async function readHistogram(edges: readonly number[]) {
    const items = base().where(pageWhere).as('histogram_items')
    return histogramCache(
      checksumJson([
        edges,
        dialect.sqlToQuery(sql`${pageSource ?? sql``} ${pageWhere}`),
      ]),
      async () =>
        listeningHistogramCounts(
          edges,
          await database
            .select({
              bar: listeningBar(sql`${items.listeningScrobbles}`, edges),
              count: sql<number>`count(*)::int`,
            })
            .from(items)
            // By position: the bar's edges are separate parameters each time.
            .groupBy(sql`1`),
        ),
    )
  }
  return {
    offset,
    readCount,
    readPage,
    readPositions,
    readVersions: undefined,
    readHistogram: listening?.sort ? readHistogram : undefined,
  }
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
  const { ids, listeningScrobbles, recordingGroups } = await readPage(
    Math.min(query.size, Math.max(0, totalCount - offset)),
  )
  return {
    ids,
    listeningScrobbles,
    recordingGroups,
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
    return {
      ids: [],
      listeningScrobbles: undefined,
      recordingGroups: undefined,
      hasMore: false,
    }
  return readPage(Math.min(query.size + 1, remaining))
}

/** Bounded pages of release rows from the current recording's filtered membership. */
export async function queryTrackRecordingVersions(
  id: string,
  query: TrackQuery,
) {
  const { readVersions } = await browseQueries(
    'track',
    { ...query, groupRecordings: true },
    undefined,
    id,
  )
  return readVersions
    ? readVersions(id)
    : { ids: [], listeningScrobbles: undefined, hasMore: false }
}

/**
 * How many items of a browse query fall in each bar of the period's count.
 * The query's own listening rules, page, sort and result cap are left out;
 * every other filter stays. Grouped tracks count recording groups.
 */
export async function queryListeningHistogram(
  mediaType: 'album' | 'track',
  query: AlbumQuery | TrackQuery,
  period: ListeningPeriod,
): Promise<ListeningHistogram> {
  const edges = listeningHistogramEdges[mediaType]
  const { readHistogram } = await browseQueries(mediaType, {
    ...query,
    listening: undefined,
    listeningSort: period,
    sortBy: 'listeningScrobbles',
    limitResults: undefined,
    page: 1,
  })
  if (!readHistogram)
    throw new ServerError({ statusCode: 422, message: 'Choose a period' })
  return { edges: [...edges], counts: await readHistogram(edges) }
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
    queryBrowseCount(mediaType, { ...query, limitResults: undefined }),
    unfiltered
      ? queryBrowseCount(mediaType, unfiltered, {
          includeLastfmSourceRows:
            mediaType === 'track' && requestsLastfmSource(query),
        })
      : undefined,
  ])
  return {
    totalCount: Math.min(totalCount, query.limitResults ?? totalCount),
    unfilteredCount: scope?.totalCount ?? totalCount,
  }
}

/** Multi-valued fields sort by their first displayed label. Read memberships once. */
function browseOrderRows(mediaType: MediaType, key: string): SQL | undefined {
  if (mediaType !== 'film' && key === 'genre')
    return firstMusicTagRows(mediaType)
  if (mediaType !== 'film' && key === 'artistTag')
    return sql`select media_item_id, min(name) as name
      from (${artistTagMemberships(mediaType)}) tags group by media_item_id`
  if (
    key === 'playlist' ||
    key === 'collection' ||
    key === 'albumTag' ||
    (mediaType === 'film' && (key === 'genre' || key === 'keyword')) ||
    (mediaType === 'track' && key === 'source')
  )
    return sql`select id as media_item_id, min(value) as name from (
      ${textRows(key, mediaType, { includeArchived: true })}
    ) memberships group by id`
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

function fieldOrder(
  value: SQL,
  key: string,
  direction: TrackQuery['direction'],
  override?: BrowseQueryOptions['sort'],
) {
  // Titles are required. Native descending null order permits a backward title index scan.
  const missingFirst =
    override?.field.key === key
      ? override.missingFirst
      : key === 'title' && direction === 'desc'
  return sql`${value} ${direction === 'desc' ? sql`desc` : sql`asc`} ${missingFirst ? sql`nulls first` : sql`nulls last`}`
}

/** Ordering for an ordinary track field over media_item, library_track and track_sort_album. */
export function trackBrowseOrder(
  sortBy: string,
  direction: TrackQuery['direction'],
) {
  const field = trackBrowseFields.find((entry) => entry.key === sortBy)
  if (!field) return
  return [
    fieldOrder(browseSortExpression(field, 'track'), sortBy, direction),
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
    // Facets also list each tag's parents, counted over all their subtags.
    rollUpTags?: boolean
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
      select media_item.id, ${trackSourceLabels.lastfm}::text as value from media_item join lastfm_track_source s on s.track_media_item_id = media_item.id where ${visible}
      union all
      select media_item.id, ${trackSourceLabels['spotify-search']}::text as value from media_item where ${visible} and media_item.metadata ? 'spotifyTrackSearch'`
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
    const trackJoin =
      mediaType === 'track'
        ? sql`join library_track lt on lt.media_item_id = media_item.id`
        : sql``
    const membership = options.sharedArtistTags
      ? sql`select media_item_id, name, name_key from browse_artist_tags`
      : artistTagMemberships(mediaType)
    const artistRows = sql`select media_item.id, artist_tag.name as value
      from (${membership}) artist_tag
      join media_item on media_item.id = artist_tag.media_item_id ${trackJoin}
      where ${visible}`
    // Release tags stand alone on an album that has enough of them.
    const sparse =
      key === 'artistTag'
        ? sql``
        : sql` and (${albumId} is null or ${albumId} not in (${albumsWithEnoughTags()}))`
    if (key === 'artistTag') return artistRows
    return sql`${textRows('albumTag', mediaType, options)}
      union all ${artistRows}${sparse}`
  }
  if (key === 'genre' || key === 'keyword' || key === 'albumTag') {
    const tagType = mediaType === 'track' ? 'album' : mediaType
    // A track is listed under the tags of its library album.
    const membership =
      mediaType === 'track'
        ? sql`join library_track lt on lt.media_item_id = media_item.id join media_item_tag mt on mt.media_item_id = lt.album_media_item_id`
        : sql`join media_item_tag mt on mt.media_item_id = media_item.id`
    const direct = sql`select media_item.id, ${tagName} as value from media_item ${membership} join tag t on t.id = mt.tag_id where ${visible} and t.media_type = ${tagType} and not t.hidden`
    if (!options.rollUpTags) return direct
    return sql`${direct}
      union all select media_item.id, ancestor.ancestor_key as value from media_item ${membership}
        join (${tagAncestorRows(tagType)}) ancestor on ancestor.tag_id = mt.tag_id
        where ${visible}`
  }
  if (mediaType === 'album' && key === 'playlist')
    return sql`select media_item.id, member.value from media_item
      join (${albumPlaylistRows()}) member on member.id = media_item.id where ${visible}`
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
type FacetRow = z.infer<typeof FacetRowSchema> & { subtags?: number }
const musicTagFacetFields = ['genre', 'albumTag', 'artistTag']
const tagFacetFields = [...musicTagFacetFields, 'keyword']

const releaseTagFacetKeys = sql`select t.id as tag_id, ${normalizedTagSql(sql`t.name`)} as value
  from tag t where t.media_type = 'album' and not t.hidden
  union all select tag_id, ancestor_key from (${tagAncestorRows('album')}) ancestors`

function musicTagFacetRows(key: string, mediaType: 'album' | 'track') {
  const track = mediaType === 'track'
  const albumId = track ? sql`lt.album_media_item_id` : sql`media_item.id`
  const items = track
    ? sql`media_item join library_track lt on lt.media_item_id = media_item.id`
    : sql`media_item`
  const visible = sql`media_item.media_type = ${mediaType}
    and media_item.metadata->>'legacyHidden' is distinct from 'true'`
  const release = sql`select media_item.id, labels.value from ${items}
    join media_item_tag mt on mt.media_item_id = ${albumId}
    join browse_release_facet_keys labels on labels.tag_id = mt.tag_id
    where ${visible}`
  if (key === 'albumTag') return release
  const artist = sql`select media_item.id, labels.value from ${items}
    join media_credit c on c.media_item_id = media_item.id and c.role = 'artist'
    join browse_artist_facet_keys labels on labels.artist_id = c.artist_id
    where ${visible}`
  if (key === 'artistTag') return artist
  return sql`${release} union all ${artist}
    and (${albumId} is null or ${albumId} not in (${albumsWithEnoughTags()}))`
}

export async function listBrowseFacets(
  mediaType: MediaType,
  input: Partial<BrowseFacetQuery> = {},
  options: { includeLastfmSourceRows?: boolean; fields?: BrowseField[] } = {},
) {
  const query = BrowseFacetQuerySchema.parse(input)
  const fields = (options.fields ?? (await listBrowseFields(mediaType))).filter(
    (field) => field.type === 'text' && field.filterable,
  )
  const rows = await facetCache(
    JSON.stringify([mediaType, fields, query, options]),
    () => queryBrowseFacets(mediaType, fields, query, options),
  )
  return rows
    .map((row) => ({
      ...row,
      // A tag value is its normalized name; the label shows the display name.
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${tagFacetFields.includes(row.field) ? formatTagName(row.value) : row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function browseFacetRows(
  field: BrowseField,
  source: SQL,
  query: BrowseFacetQuery,
  limit: number,
  visibility = sql``,
  counting:
    | 'distinctItems'
    | 'uniqueRows'
    | 'deduplicateRows' = 'distinctItems',
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
  const values = sql`from (${source}) values_for_field
    where value is not null and value <> '' ${search} ${visibility}`
  // Music tag rows can overlap through several source tags or credits. Let
  // PostgreSQL deduplicate those item/value pairs before grouping by value.
  const distinctValues =
    counting === 'deduplicateRows'
      ? sql`from (select distinct value, id ${values}) distinct_items`
      : values
  const count =
    counting === 'distinctItems' ? sql`count(distinct id)` : sql`count(*)`
  // Limit each field independently so common values never crowd out other fields.
  return sql`(select ${field.key}::text as field, value, ${count}::int as count
    ${distinctValues}
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
): Promise<FacetRow[]> {
  if (!fields.length) return []
  const limit = Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / fields.length)),
  )
  const music = mediaType === 'album' || mediaType === 'track'
  const sources: SQL[] = []
  if (music && fields.some((field) => musicTagFacetFields.includes(field.key)))
    sources.push(
      sql`browse_artist_facet_keys as materialized (${artistTagFacetKeys(mediaType)})`,
      sql`browse_release_facet_keys as materialized (${releaseTagFacetKeys})`,
    )
  if (mediaType === 'track' && !options.includeLastfmSourceRows)
    sources.push(
      sql`redundant_lastfm_tracks as materialized (${redundantLastfmTrackIds()})`,
    )
  const queries = fields.map((field) => {
    const musicTagFacet = music && musicTagFacetFields.includes(field.key)
    const source = musicTagFacet
      ? musicTagFacetRows(field.key, mediaType)
      : textRows(field.key, mediaType, {
          normalizeTags: true,
          rollUpTags: true,
        })
    // Choosing the Last.fm source explicitly includes its retained source rows.
    const visibility =
      mediaType !== 'track' || options.includeLastfmSourceRows
        ? sql``
        : field.key === 'source'
          ? sql`and (value = ${trackSourceLabels.lastfm} or id not in (select id from redundant_lastfm_tracks))`
          : sql`and id not in (select id from redundant_lastfm_tracks)`
    const uniqueValuePerItem =
      field.key === 'title' ||
      (mediaType === 'track'
        ? ['album', 'albumLink', 'spotifyMatch'].includes(field.key)
        : field.key === 'source')
    return browseFacetRows(
      field,
      source,
      query,
      limit,
      options.includeLastfmSourceRows && mediaType === 'track'
        ? sql`and id in (select media_item_id from library_track)`
        : visibility,
      musicTagFacet
        ? 'deduplicateRows'
        : uniqueValuePerItem
          ? 'uniqueRows'
          : 'distinctItems',
    )
  })
  const result = await db.execute(
    sql`${sources.length ? sql`with ${sql.join(sources, sql`, `)}` : sql``}
      ${sql.join(queries, sql` union all `)}`,
  )
  const rows: FacetRow[] = z.array(FacetRowSchema).parse(result.rows)
  // A tag with subtags is counted over all of them; say how many there are.
  const subtags = await visibleSubtagCounts(
    mediaType === 'track' ? 'album' : mediaType,
    [
      ...new Set(
        rows
          .filter((row) => tagFacetFields.includes(row.field))
          .map((row) => row.value),
      ),
    ],
  )
  return rows.map((row) => {
    const count = tagFacetFields.includes(row.field)
      ? subtags.get(row.value)
      : undefined
    return count === undefined ? row : { ...row, subtags: count }
  })
}
