import {
  and,
  eq,
  inArray,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
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
  TrackQuerySchema,
  TrackSourceSchema,
  trackAlbumLinkLabels,
  trackSourceLabels,
  trackSpotifyMatchLabels,
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
import { measureRequestPhase, setRequestBrowseProfile } from '@/lib/request-log'
import { ServerError } from '@/lib/error'
import {
  canReadDatabaseWithoutCache,
  createDatabaseReadCache,
} from '@/lib/database-read-cache'
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
import { currentArtistId } from './artist-names'
import { createBrowseListening, type BrowseListening } from './browse-listening'
import {
  firstMusicTagRows,
  albumsWithEnoughTags,
  artistTagFacetKeys,
  artistTagLabels,
  artistTagMemberships,
  firstArtistTag,
  firstMusicTag,
  mediaIdsWithArtistTag,
  matchingTagNames,
} from './music-tags'
import {
  albumTrackDurationExpression,
  redundantLastfmTrackIds,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
} from './track-values'
import {
  trackDuplicateMembership,
  trackDuplicateOrder,
  trackDuplicatePosition,
} from './track-duplicate-refresh'
import {
  readRecordingBrowseOrder,
  recordingBrowseOrderRows,
  recordingCount,
  recordingDates,
  recordingGroupProjection,
  recordingGroupValue,
  recordingListening,
  recordingMemberships,
  recordingRepresentatives,
  recordingVersionMembers,
  refreshRecordingBrowseOrder,
  RecordingGroupPositionRowsSchema,
  RecordingGroupRowsSchema,
  type RecordingGroup,
  type RecordingGroupRow,
  type RecordingOrderMaintenanceSource,
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

function readBrowseTotal(
  query: BrowseQuery,
  predicate: SQL,
  load: () => Promise<number>,
) {
  // Rolling rules bind the current instant and can change without a write.
  if (
    'listening' in query &&
    query.listening?.rules.some(({ period }) => period.kind === 'rolling')
  ) {
    return load()
  }
  return countCache(checksumJson(dialect.sqlToQuery(predicate)), load)
}

const trackSortAlbum = alias(mediaItem, 'track_sort_album')
const trackReleaseColumns = {
  id: mediaItem.id,
  title: mediaItem.title,
  releaseDate: mediaItem.releaseDate,
  albumId: libraryTrack.albumMediaItemId,
  albumName: libraryTrack.albumName,
  spotifyAlbumId: libraryTrack.spotifyAlbumId,
}

function trackAlbumSortName(albumName: SQLWrapper) {
  return sql`lower(coalesce(nullif(trim(${trackSortAlbum.title}), ''), nullif(trim(${albumName}), '')))`
}

const trackSortAlbumName = trackAlbumSortName(libraryTrack.albumName)

type BrowsePosition = {
  id: string
  position: number
  recordingGroup?: RecordingGroup
  listeningScrobbles?: number
}

const TrackPageRowSchema = z.object({
  id: z.string(),
  listeningScrobbles: z.number().int().nonnegative().nullable(),
})
const TrackPageRowsSchema = z.array(TrackPageRowSchema)
const TrackRankRowsSchema = z.array(
  TrackPageRowSchema.extend({ rank: z.number().int().positive() }),
)
const trackRankSortFields = new Set([
  'title',
  'artist',
  'album',
  'playlist',
  'genre',
  'albumTag',
  'artistTag',
  'releaseDate',
  'dateAdded',
  'durationSec',
])
const boundedTrackPageSortFields = new Set([
  'artist',
  'album',
  'releaseDate',
  'durationSec',
])
const trackArtistProbeLimit = 1024

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
  if (key === 'title') return sql`lower(${mediaItem.title}) = ${match}`
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
      return sql`(${releaseMatch} or (${matchesValue('artistTag', value, mediaType)}
        and (${tagged} is null or ${tagged} not in (${albumsWithEnoughTags()}))))`
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

function browseSearchWords(query: BrowseQuery) {
  return new Set(query.q?.split(/\s+/).filter(Boolean))
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
    .map((field) => {
      if (field.key === 'artistTag' && mediaType !== 'film') {
        // Match the canonical display labels before expanding media credits.
        const labels = sharedArtistTags
          ? sql`select artist_id, name from browse_artist_tag_labels`
          : artistTagLabels()
        return sql`select c.media_item_id as id from media_credit c
          join media_item m on m.id = c.media_item_id
          where m.media_type = ${mediaType} and c.role = 'artist'
            and c.artist_id in (
              select artist_id from (${labels}) search_labels where name ilike ${search}
            )`
      }
      const rows = sql`select id from (
        ${textRows(field.key, mediaType, { includeArchived: true })}
      ) searchable_values where value ilike ${search}`
      if (mediaType !== 'track' || field.key !== 'spotifyMatch') return rows
      // Source and album-link rows use literal labels that PostgreSQL can
      // check once. Guard the Spotify match CASE with the same fixed labels.
      const labels = Object.values(trackSpotifyMatchLabels).map(
        (label) => sql`${label}::text ilike ${search}`,
      )
      return sql`${rows} and (${sql.join(labels, sql` or `)})`
    })
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

// OFFSET 0 keeps the release lookups keyed by each tied track when the
// planner underestimates the size of the primary sort's boundary.
function trackReleaseLookups(trackId: SQL) {
  return sql`join lateral (select * from ${mediaItem} where ${mediaItem.id} = ${trackId} offset 0)
      ${mediaItem} on true
    join lateral (select * from ${libraryTrack} where ${libraryTrack.mediaItemId} = ${trackId} offset 0)
      ${libraryTrack} on true
    left join lateral (select * from ${mediaItem} where ${mediaItem.id} = ${libraryTrack.albumMediaItemId} offset 0)
      ${trackSortAlbum} on true`
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
  defaultScope: boolean,
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
      ? sql`browse_artist_tag_labels as (${artistTagLabels()}), `
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
  const groupJoins = (
    requested?: BrowseListening,
    members?: SQL,
    bounded?: SQL,
  ) => {
    const source = requested?.source('recording', members)
    const unbounded = bounded && requested?.source('recording')
    if (source && unbounded)
      return sql`left join (
        select * from ${source} where ${bounded}
        union all select * from ${unbounded} where not ${bounded}
      ) listening_counts on listening_counts.id = ${groupKey}`
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
  const dynamicLifetimeOrder = query.sortBy === 'scrobbles' && !!listening
  // A displayed period total does not affect lifetime order. When filtering
  // only by presence or absence, use the same exact predicate as the count.
  const deferPeriodCounts =
    dynamicLifetimeOrder &&
    !!listening?.sort &&
    !countedListening?.source('recording')
  const lifetimeCondition = deferPeriodCounts
    ? countedGroupCondition
    : groupCondition
  const lifetimePredicate = lifetimeCondition
    ? sql`where ${lifetimeCondition}`
    : sql``
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
  function groupRows(
    bound: number,
    listeningJoin = groupListening,
    periodPage = false,
  ) {
    const columns = groupSort ? sql`` : sql`, ${sort} as primary_value`
    const sortJoins = groupSort
      ? sql``
      : sql`join ${mediaItem} on ${mediaItem.id} = g.id ${trackColumns} ${orderRowsJoin}`
    const releaseJoins = periodPage
      ? trackReleaseLookups(sql`g.id`)
      : sql`join ${mediaItem} on ${mediaItem.id} = g.id ${trackColumns}`
    return sql`from (
      select g.*, ${listeningValue}${columns}
      from recording_stats g
      ${listeningJoin} ${sortJoins} ${groupPredicate}
      order by ${primaryOrdering(groupSort ?? sort)}
      fetch first (${bound}) rows with ties
    ) g ${releaseJoins}`
  }

  function lifetimeRows(ranks: number[] | { first: number; last: number }) {
    const last = Array.isArray(ranks) ? Math.max(...ranks) : ranks.last
    const primary = primaryOrdering(sql`g.scrobbles`)
    const ordinalRange = Array.isArray(ranks)
      ? inArray(sql`ordinal`, ranks)
      : sql`ordinal = ${ranks.first}`
    const primaryRange = Array.isArray(ranks)
      ? sql`first_rank in (select first_rank from primary_recordings where ${ordinalRange})`
      : sql`first_rank >= (select first_rank from primary_recordings where ${ordinalRange})`
    const requested = Array.isArray(ranks)
      ? inArray(sql`rank`, ranks)
      : sql`rank between ${ranks.first} and ${last}`
    // Only resolve release order in primary tie sets that can overlap the
    // requested ranks. In particular, a deep page skips earlier tie sets.
    const ranked = sql`${grouped}, primary_recordings as materialized (
      select g.*, ${deferPeriodCounts ? sql`null::int as listening_scrobbles` : listeningValue},
        rank() over (order by ${primary}) as first_rank,
        row_number() over (order by ${primary}) as ordinal
      from recording_stats g
      ${deferPeriodCounts ? sql`` : groupListening} ${lifetimePredicate}
      order by ${primary} fetch first (${last}) rows with ties
    ), ranked_recordings as (
      select g.*, first_rank + row_number() over (
        partition by first_rank
        order by ${sql.join([...naturalOrder, sql`${mediaItem.id}`], sql`, `)}
      ) - 1 as rank
      from (select * from primary_recordings where ${primaryRange}) g
      ${trackReleaseLookups(sql`g.id`)}
    )`
    if (!deferPeriodCounts)
      return sql`${ranked}
        select ${recordingGroupProjection}, g.listening_scrobbles, g.rank::int
        from ranked_recordings g where ${requested} order by g.rank`
    return projectSelectedListening(
      ranked,
      sql`select * from ranked_recordings where ${requested}`,
    )
  }
  const offset = (query.page - 1) * query.size
  const useStoredScope =
    defaultScope &&
    !query.q &&
    !query.filters.length &&
    !query.ranges.length &&
    !query.creatorId &&
    !('tag' in query && query.tag) &&
    !('includeArchived' in query && query.includeArchived === 'true') &&
    versionId === undefined
  const useStoredOrder =
    useStoredScope && query.sortBy === 'scrobbles' && !listening
  const useStoredMembership = useStoredScope && dynamicLifetimeOrder
  const storedRank =
    query.direction === 'asc' ? sql`g.ascending_rank` : sql`g.descending_rank`
  // A singleton needs no side row. All listening eligibility still reads
  // linked events, so rolling windows and partly imported history stay exact.
  const storedMemberships = sql`with recording_members as not materialized (
    select id, id as group_key from recording_browse_order where version_count = 1
    union all
    select track_id, recording_id from recording_browse_order_member
  )`
  const storedGroups = sql`(select o.*, o.id as group_key from recording_browse_order o)`

  function projectSelectedListening(prefix: SQL, selected: SQL) {
    return sql`${prefix}, selected_recordings as materialized (${selected}),
      selected_members as materialized (
        select m.id, m.group_key from recording_members m
        join selected_recordings s using (group_key)
      )
      select ${recordingGroupProjection}, ${listeningValue}, g.rank::int
      from selected_recordings g ${groupJoins(listening, sql`selected_members`)}
      order by g.rank`
  }

  function boundedPresencePage({
    offset,
    limit,
  }: {
    offset: number
    limit: number
  }) {
    const needed = offset + limit
    const maximumProbe = 1024
    if (needed > maximumProbe / 2 || !countedGroupCondition) return
    // Keep presence tests correlated to one stored rank and its members.
    const presence = countedListening?.multiRulePresenceCondition(
      (period) => sql`exists (
        select 1 from (
          select g.id as id where g.version_count = 1
          union all
          select track_id from recording_browse_order_member
          where recording_id = g.id and g.version_count > 1
        ) member
        join lastfm_track_link listening_link on listening_link.track_media_item_id = member.id
        join lastfm_scrobble using (username, artist_key, track_key)
        where ${period}
        offset 0
      )`,
    )
    if (!presence) return

    const probe = Math.max(256, Math.min(maximumProbe, needed * 5))
    const prefix = sql`${storedMemberships},
      eligible_prefix as materialized (
        select g.*, ${storedRank} as rank
        from (
          select g.* from ${storedGroups} g
          order by ${storedRank} limit ${probe}
        ) g where ${presence} order by ${storedRank} limit ${needed}
      ),
      prefix_filled as materialized (
        select count(*) = ${needed} as filled from eligible_prefix
      ),
      eligible_library as materialized (
        select g.*, ${storedRank} as rank
        from ${storedGroups} g ${countedGroupListening}
        where not (select filled from prefix_filled) and ${countedGroupCondition}
      )`
    // Compute the full set only when the prefix has too few matches. Apply
    // the page limit afterwards to avoid a repeated scan of listening totals.
    const selected = sql`
      (select * from eligible_prefix where (select filled from prefix_filled)
        order by rank limit ${limit} offset ${offset})
      union all
      (select * from eligible_library order by rank limit ${limit} offset ${offset})`
    return listening?.sort
      ? projectSelectedListening(prefix, selected)
      : sql`${prefix}
        select ${recordingGroupProjection}, null::int as listening_scrobbles, g.rank::int
        from (${selected}) g order by g.rank`
  }

  function storedLifetimeRows(
    page: { offset: number; limit: number } | number[],
  ) {
    const positions = Array.isArray(page)
    if (!positions) {
      const bounded = boundedPresencePage(page)
      if (bounded) return bounded
    }
    // Dynamic eligibility leaves gaps in published ranks.
    const denseRank = positions && !!lifetimeCondition
    const rank = denseRank
      ? sql`row_number() over (order by ${storedRank})`
      : storedRank
    const condition =
      lifetimeCondition ??
      (positions
        ? inArray(storedRank, page)
        : sql`${storedRank} > ${page.offset}::bigint
          and ${storedRank} <= ${page.offset + page.limit}::bigint`)
    const limit = !lifetimeCondition
      ? sql``
      : positions
        ? sql`limit ${Math.max(...page)}`
        : sql`limit ${page.limit} offset ${page.offset}`
    const ranked = sql`select g.*, ${rank} as rank,
      ${deferPeriodCounts ? sql`null::int as listening_scrobbles` : listeningValue}
      from ${storedGroups} g ${deferPeriodCounts ? sql`` : groupListening}
      where ${condition} order by ${storedRank} ${limit}`
    const selected = denseRank
      ? sql`select * from (${ranked}) ranked where ${inArray(sql`rank`, page)}`
      : ranked
    if (deferPeriodCounts)
      return projectSelectedListening(storedMemberships, selected)
    return sql`${storedMemberships}
      select ${recordingGroupProjection}, g.listening_scrobbles, g.rank::int
      from (${selected}) g order by g.rank`
  }

  function completeOrder() {
    const ties = trackNaturalOrder('scrobbles', {
      artist: sql`artist_order.name`,
      position: sql`position_order.position`,
    })
    const ascending = sql.join(
      [sql`g.scrobbles asc nulls last`, ...ties, sql`${mediaItem.id}`],
      sql`, `,
    )
    const descending = sql.join(
      [sql`g.scrobbles desc nulls last`, ...ties, sql`${mediaItem.id}`],
      sql`, `,
    )
    return {
      prefix: sql`${grouped},
      published_members as (
        insert into recording_browse_order_member (track_id, recording_id)
        select m.id, r.id from recording_group_members m
        join recording_group_representatives r using (group_key)
        where r.version_count > 1
      ),
      order_tracks as materialized (
        select g.*, lt.album_media_item_id, coalesce(lt.album_media_item_id, g.id) as credit_id
        from recording_stats g join library_track lt on lt.media_item_id = g.id
      ),
      artist_order as (
        ${firstTrackArtistRows(sql`select distinct credit_id from order_tracks`)}
      ),
      position_order as (
        select g.id, min(t.position) as position from order_tracks g
        join track t on t.track_media_item_id = g.id and t.album_media_item_id = g.album_media_item_id
        group by g.id
      )`,
      rows: sql`select g.id, g.version_count, g.scrobbles, g.last_listened_at, g.date_added,
        row_number() over (order by ${ascending})::int,
        row_number() over (order by ${descending})::int
      from order_tracks g join ${mediaItem} on ${mediaItem.id} = g.id ${trackColumns}
      left join artist_order on artist_order.media_item_id = g.credit_id
      left join position_order on position_order.id = g.id`,
    }
  }

  async function readCount() {
    // The frontend strips sort controls from count requests.
    if (
      useStoredOrder ||
      useStoredMembership ||
      (useStoredScope && countedListening)
    ) {
      const predicate = countedGroupCondition
        ? sql`${storedMemberships} select count(*)::int from ${storedGroups} g
          ${countedGroupListening} where ${countedGroupCondition}`
        : undefined
      const cached = await readRecordingBrowseOrder(undefined, predicate)
      const total = predicate ? cached?.filtered_count : cached?.total_count
      if (total != null)
        return Math.min(total, query.limitResults ?? Number.MAX_SAFE_INTEGER)
    }
    const counted = countedGroupCondition
      ? sql`${rangeMemberships} select count(*)::int as value from ${rangeGroups} g
        ${countedGroupListening} where ${countedGroupCondition}`
      : sql`${memberships} ${recordingCount}`
    const total = await readBrowseTotal(query, counted, async () => {
      const { rows } = await db.execute(counted)
      return z.object({ value: z.number().int().nonnegative() }).parse(rows[0])
        .value
    })
    return Math.min(total, query.limitResults ?? Number.MAX_SAFE_INTEGER)
  }

  async function readPage(limit: number) {
    let rows: RecordingGroupRow[] | undefined
    if ((useStoredOrder || useStoredMembership) && limit > 0) {
      const selected = useStoredMembership
        ? storedLifetimeRows({ offset, limit })
        : recordingBrowseOrderRows(
            storedRank,
            sql`${storedRank} > ${offset}::bigint and ${storedRank} <= ${offset + limit}::bigint`,
          )
      const cached = await readRecordingBrowseOrder(selected)
      const stored =
        cached && cached.total_count !== null
          ? cached.rows
          : cached?.can_refresh
            ? await refreshRecordingBrowseOrder(completeOrder(), selected)
            : undefined
      if (stored) rows = RecordingGroupRowsSchema.parse(stored)
    }
    // Count the linked names of selective first-page matches. Reuse the title
    // lookup bound to keep name preaggregation for broad filters.
    const candidatePeriodPage = Boolean(
      offset === 0 &&
      listeningSorted &&
      !query.creatorId &&
      versionId === undefined &&
      (query.q || query.filters.some((chip) => chip.mode !== 'exclude')),
    )
    const pageListening = candidatePeriodPage
      ? groupJoins(
          listening,
          sql`recording_members`,
          sql`(select bounded from recording_title_scope)`,
        )
      : groupListening
    const page = dynamicLifetimeOrder
      ? lifetimeRows({ first: offset + 1, last: offset + limit })
      : sql`${grouped}
      select ${recordingGroupProjection}, g.listening_scrobbles
      ${groupRows(offset + limit, pageListening, candidatePeriodPage)}
      order by ${ordering(rowSort)} limit ${limit} offset ${offset}`
    const read = async () =>
      RecordingGroupRowsSchema.parse((await db.execute(page)).rows)
    rows ??=
      dynamicLifetimeOrder &&
      (query.listening?.rules.some(({ period }) => period.kind === 'rolling') ||
        query.listeningSort?.kind === 'rolling')
        ? await read()
        : await recordingPageCache(checksumJson(dialect.sqlToQuery(page)), read)
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
    const cached =
      useStoredOrder || useStoredMembership
        ? await readRecordingBrowseOrder(
            useStoredMembership
              ? storedLifetimeRows(ranks)
              : recordingBrowseOrderRows(
                  storedRank,
                  inArray(storedRank, ranks),
                ),
          )
        : undefined
    const rows =
      cached && cached.total_count !== null
        ? cached.rows
        : RecordingGroupPositionRowsSchema.parse(
            (
              await db.execute(
                dynamicLifetimeOrder
                  ? lifetimeRows(ranks)
                  : sql`${grouped}, ranked as (
      select ${recordingGroupProjection}, g.listening_scrobbles,
        row_number() over (order by ${ordering(rowSort)}) as rank
      ${groupRows(deepest)}
    ) select id, version_count, scrobbles, last_listened_at, date_added,
        listening_scrobbles, rank::int
      from ranked where rank <= ${deepest} and ${inArray(sql`rank`, ranks)} order by rank`,
              )
            ).rows,
          )
    return rows.map(({ rank, listening_scrobbles, ...recordingGroup }) => ({
      id: recordingGroup.id,
      position: rank - 1,
      recordingGroup,
      ...(listening?.sort
        ? { listeningScrobbles: listening_scrobbles ?? 0 }
        : {}),
    }))
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
    refreshStoredOrder: useStoredOrder
      ? async (source: RecordingOrderMaintenanceSource) =>
          (await refreshRecordingBrowseOrder(
            completeOrder(),
            undefined,
            source,
          )) !== undefined
      : undefined,
    readHistogram: listeningSort
      ? (edges: readonly number[]) => readHistogram(listeningSort, edges)
      : undefined,
  }
}

async function browseQueries(
  mediaType: MediaType,
  input: AlbumQuery | FilmQuery | TrackQuery,
  options: BrowseQueryOptions = {},
  versionId?: string,
) {
  // A merged artist name reads as the artist it was merged into.
  const query = input.creatorId
    ? { ...input, creatorId: await currentArtistId(db, input.creatorId) }
    : input
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
  // Possible duplicates: members of stored groups, most played group first.
  // A Last.fm track hidden behind its match is one of them.
  const duplicates =
    mediaType === 'track' && 'duplicates' in query && query.duplicates === true
  const groupedTrackQuery =
    mediaType === 'track' &&
    'groupRecordings' in query &&
    query.groupRecordings &&
    !duplicates
      ? query
      : undefined
  const conditions: SQL[] = [eq(mediaItem.mediaType, mediaType)]
  if (duplicates) conditions.push(trackDuplicateMembership)
  // A playlist member already has a library identity.
  const hideRedundant =
    mediaType === 'track' &&
    !duplicates &&
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
  let creatorCredit: SQL | undefined
  if (query.creatorId) {
    const role = 'creatorRole' in query ? query.creatorRole : undefined
    const roles =
      mediaType === 'film'
        ? role
          ? [role]
          : PersonRoleSchema.options
        : ['artist']
    creatorCredit = sql`exists (select 1 from ${mediaCredit} where ${and(
      eq(mediaCredit.mediaItemId, mediaItem.id),
      eq(mediaCredit.artistId, query.creatorId),
      inArray(mediaCredit.role, roles),
    )})`
    conditions.push(creatorCredit)
  }
  conditions.push(...(options.conditions ?? []))
  if (!('includeArchived' in query) || query.includeArchived !== 'true')
    conditions.push(
      sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
    )
  // An edition is listed under the first album of its record unless asked for.
  if (
    mediaType === 'album' &&
    (!('editions' in query) || query.editions !== 'true')
  )
    conditions.push(sql`not exists (select 1 from ${album} edition
      where edition.media_item_id = ${mediaItem.id}
        and edition.edition_of_id is not null)`)
  const filters = [...query.filters]
  if ('tag' in query && query.tag)
    filters.push({ field: 'genre', value: query.tag, mode: 'required' })
  if ('sourceKind' in query && query.sourceKind)
    conditions.push(eq(film.sourceKind, query.sourceKind))
  const filterRanges = groupedTrackQuery
    ? query.ranges.filter((range) => !recordingGroupValue(range.field))
    : query.ranges
  // Every word must appear in at least one text field; words may match
  // different fields.
  const music = mediaType === 'album' || mediaType === 'track'
  const words = browseSearchWords(query)
  const sharedArtistTags = music && words.size > 1
  const database = sharedArtistTags
    ? db.with(db.$with('browse_artist_tag_labels', {}).as(artistTagLabels()))
    : db
  const searchConditions: SQL[] = []
  for (const word of words) {
    const search = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    searchConditions.push(
      sql`${mediaItem.id} in (${browseTextSearchIds(mediaType, fields, search, sharedArtistTags)})`,
    )
  }
  const whereWithFilters = (
    extraMatch?: (filter: BrowseFilter) => SQL | undefined,
  ) =>
    and(
      ...conditions,
      ...browseFieldConditions(
        mediaType,
        filters,
        filterRanges,
        byKey,
        extraMatch,
      ),
      ...searchConditions,
    )
  const where = whereWithFilters()
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
      !options.conditions?.length &&
        !options.includeLastfmSourceRows &&
        !options.sort,
      versionId,
    )
  const fieldSort = fieldOrder(
    sort,
    sortField.key,
    query.direction,
    options.sort,
  )
  // The chosen sort orders the tracks within each group.
  const order = duplicates
    ? sql.join(
        [trackDuplicateOrder, fieldSort, trackDuplicatePosition],
        sql`, `,
      )
    : fieldSort
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
  // An ordered Added page can stop at its limit. For creator scopes, keep
  // the cheap indexed credit test before probes of redundant Last.fm rows.
  // PostgreSQL can otherwise test those probes before joining artist credits.
  const creatorTrackScope = mediaType === 'track' && !!creatorCredit
  const nonredundantTrack = sql`not exists (
    ${redundantLastfmTrackIds(sql`${mediaItem.id}`)})`
  const scopedTrackVisibility = hideRedundant
    ? creatorTrackScope
      ? sql`case when ${mediaItem.sourceLabel} is distinct from 'lastfm' then true
          when ${creatorCredit} then ${nonredundantTrack}
          else false end`
      : sql`(${mediaItem.sourceLabel} is distinct from 'lastfm' or ${nonredundantTrack})`
    : undefined
  const addedTrackVisibility =
    query.sortBy === 'dateAdded' && query.direction === 'desc'
      ? scopedTrackVisibility
      : visibleTrack
  const pageMembership = itemConditions(listening)
  const pageWhere = and(
    pageMembership,
    creatorTrackScope
      ? scopedTrackVisibility
      : query.filters.length
        ? visibleTrack
        : addedTrackVisibility,
  )
  const pageSource = listening?.source(listeningSubject)
  const countWhere = and(
    itemConditions(countedListening),
    creatorTrackScope ? scopedTrackVisibility : visibleTrack,
  )
  const countSource = countedListening?.source(listeningSubject)
  const base = ({
    rank = sql<number>`0`,
    ordinal,
    primary,
    releaseColumns = false,
  }: {
    rank?: SQL<number>
    ordinal?: SQL<number>
    primary?: SQL
    releaseColumns?: boolean
  } = {}) => {
    const query = database
      .select({
        ...(releaseColumns ? trackReleaseColumns : { id: mediaItem.id }),
        listeningScrobbles: sql<
          number | null
        >`${listening?.sort ?? sql`null`}`.as('listening_scrobbles'),
        ...(ordinal ? { ordinal: ordinal.as('ordinal') } : {}),
        ...(primary ? { primary: primary.as('primary_value') } : {}),
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
    const total = await readBrowseTotal(
      query,
      sql`${countSource ?? sql``} ${countWhere}`,
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
  const useTrackRanks =
    mediaType === 'track' &&
    !duplicates &&
    (trackRankSortFields.has(sortField.key) ||
      (sortField.key === 'scrobbles' && query.direction === 'asc')) &&
    options.sort?.field.key !== sortField.key

  async function readTrackRanks(
    ranks: number[] | { first: number; last: number },
    firstArtistTagWhere?: SQL,
    rankVisibility = visibleTrack,
  ) {
    const last = Array.isArray(ranks) ? Math.max(...ranks) : ranks.last
    const requested = Array.isArray(ranks)
      ? sql`= any(${sql.param(ranks)}::bigint[])`
      : sql`between ${ranks.first}::bigint and ${last}::bigint`
    const primaryRanks = Array.isArray(ranks)
      ? sql`in (select rank from primary_tracks where ordinal ${requested})`
      : sql`between (select rank from primary_tracks where ordinal = ${ranks.first}::bigint)
          and ${last}::bigint`
    const prefix = base({
      rank: sql<number>`rank() over (order by ${order})`,
      ordinal: sql<number>`row_number() over (order by ${order})`,
    })
      .where(
        firstArtistTagWhere ?? and(itemConditions(listening), rankVisibility),
      )
      .orderBy(order)
    const releaseJoins = firstArtistTagWhere
      ? trackReleaseLookups(sql`p.id`)
      : sql`join ${mediaItem} on ${mediaItem.id} = p.id
        join ${libraryTrack} on ${libraryTrack.mediaItemId} = p.id
        left join ${mediaItem} as ${trackSortAlbum}
          on ${trackSortAlbum.id} = ${libraryTrack.albumMediaItemId}`
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
        ${releaseJoins}
      )
      select id, listening_scrobbles as "listeningScrobbles", rank::int
      from ranked_tracks where rank ${requested} order by rank`)
    return TrackRankRowsSchema.parse(result.rows)
  }

  async function readFirstTrackFieldPage(limit: number) {
    // Bound release-order lookups by the primary page and include every row
    // tied at its boundary before resolving the stable natural order.
    const primaryOrder = (value: SQL) =>
      fieldOrder(value, query.sortBy, query.direction)
    const primary = primaryOrder(sql`primary_value`)
    const artistMatches =
      query.sortBy === 'artist'
        ? base({ releaseColumns: true }).where(pageWhere)
        : undefined
    // Probe credits for a small result. Join them as a set for broad matches.
    const boundedArtistProbes = sql`(select bounded from artist_sort_scope)`
    const prefix = artistMatches
      ? sql`select * from (
          select p.*, ${firstTrackArtist(sql`p.id`)} as primary_value
          from matching_tracks p where ${boundedArtistProbes}
          union all
          select p.*, a.name as primary_value
          from matching_tracks p
          left join (${firstTrackArtistRows(sql`select id as credit_id from matching_tracks`)}) a
            on a.media_item_id = p.id
          where not ${boundedArtistProbes}
        ) artist_matches order by ${primary}`
      : base({ primary: sort, releaseColumns: true })
          .where(pageWhere)
          .orderBy(primary)
    const releaseOrder = trackNaturalOrder(query.sortBy, undefined, {
      id: sql`p.id`,
      title: sql`p.title`,
      releaseDate: sql`p.release_date`,
      albumId: sql`p.album_media_item_id`,
      albumName: sql`p.album_name`,
      spotifyAlbumId: sql`p.spotify_album_id`,
    })
    const ordering = sql.join(
      [primaryOrder(sql`p.primary_value`), ...releaseOrder, sql`p.id`],
      sql`, `,
    )
    const matches = artistMatches
      ? sql`matching_tracks as materialized (${artistMatches}), artist_sort_scope as materialized (
          select count(*) <= ${trackArtistProbeLimit} as bounded
          from (select 1 from matching_tracks limit ${trackArtistProbeLimit + 1}) probe
        ), `
      : sql``
    const result =
      await db.execute(sql`with ${matches}page_tracks as materialized (
        ${prefix} fetch first (${limit}) rows with ties
      )
      select p.id, p.listening_scrobbles as "listeningScrobbles"
      from page_tracks p
      left join ${mediaItem} as ${trackSortAlbum}
        on ${trackSortAlbum.id} = p.album_media_item_id
      order by ${ordering} limit ${limit}`)
    return TrackPageRowsSchema.parse(result.rows)
  }

  async function readPage(limit: number) {
    // Keep positive artist tags as a set of keys. A broad tag must not be
    // nested-loop joined against the date index, and release ordering only
    // needs to resolve the primary date ties at the page boundary.
    const firstArtistTagPage =
      mediaType === 'track' &&
      offset === 0 &&
      query.sortBy === 'dateAdded' &&
      query.direction === 'desc' &&
      useTrackRanks &&
      query.filters.some(
        (chip) => chip.field === 'artistTag' && chip.mode !== 'exclude',
      )
    const firstArtistTagWhere = firstArtistTagPage
      ? and(
          whereWithFilters((chip) =>
            chip.field === 'artistTag' && chip.mode !== 'exclude'
              ? sql`${libraryTrack.mediaItemId} = any(array(
                  ${mediaIdsWithArtistTag(normalizeTagName(chip.value))}
                ))`
              : undefined,
          ),
          listening?.condition(listeningSubject, sql`${mediaItem.id}`),
          addedTrackVisibility,
        )
      : undefined
    // Keep index order and categorical sorts with potentially library-wide
    // ties on the direct limit path.
    const firstFilteredFieldPage =
      mediaType === 'track' &&
      offset === 0 &&
      !duplicates &&
      !creatorTrackScope &&
      options.sort?.field.key !== query.sortBy &&
      (query.q || query.filters.length || query.ranges.length) &&
      boundedTrackPageSortFields.has(query.sortBy)
    const rows =
      useTrackRanks && limit > 0 && (firstArtistTagWhere || offset >= 3 * limit)
        ? await readTrackRanks(
            { first: offset + 1, last: offset + limit },
            firstArtistTagWhere,
            creatorTrackScope ? scopedTrackVisibility : visibleTrack,
          )
        : firstFilteredFieldPage && limit > 0
          ? await readFirstTrackFieldPage(limit)
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
    if (useTrackRanks && deepest >= 4 * ranks.length)
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
    const ranked = base({
      rank: sql<number>`row_number() over (order by ${ordering})`,
    })
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
    refreshStoredOrder: undefined,
    readHistogram: listening?.sort ? readHistogram : undefined,
  }
}

/** Warm only an order that a Browse page has previously requested. */
export async function refreshRecordingBrowseOrderForMaintenance(
  source: RecordingOrderMaintenanceSource = 'scheduled',
) {
  const grouped = await browseQueries(
    'track',
    TrackQuerySchema.parse({ groupRecordings: true, sortBy: 'scrobbles' }),
  )
  return (await grouped.refreshStoredOrder?.(source)) ?? false
}

type BrowseQuery = AlbumQuery | FilmQuery | TrackQuery

function recordBrowseShape(query: BrowseQuery) {
  const hasListeningFilter =
    'listening' in query && query.listening !== undefined
  const hasListeningColumn =
    'listeningSort' in query && query.listeningSort !== undefined
  const playSort =
    query.sortBy === 'scrobbles' || query.sortBy === 'listeningScrobbles'
      ? query.sortBy
      : undefined
  const termCount = browseSearchWords(query).size
  setRequestBrowseProfile({
    searchTerms:
      termCount === 0 ? undefined : termCount === 1 ? 'one' : 'multiple',
    playSort,
    grouped: 'groupRecordings' in query && query.groupRecordings === true,
    depth: query.page === 1 ? 'first' : query.page <= 4 ? 'near' : 'deep',
    listening: hasListeningFilter || hasListeningColumn,
    listeningUse: hasListeningFilter
      ? hasListeningColumn
        ? 'both'
        : 'filter'
      : hasListeningColumn
        ? 'column'
        : undefined,
    filtered: Boolean(
      query.q || query.filters.length || query.ranges.length || query.creatorId,
    ),
    creatorScoped: Boolean(query.creatorId),
    sortField: query.sortBy,
    filterFields: query.filters.map((chip) => chip.field),
    rangeFields: query.ranges.map((range) => range.field),
    sort:
      query.sortBy === 'dateAdded'
        ? 'added'
        : query.sortBy === 'title'
          ? 'title'
          : playSort
            ? 'plays'
            : 'other',
  })
}

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
  recordBrowseShape(query)
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
  recordBrowseShape(query)
  const unfiltered = unfilteredBrowseQuery(query)
  const [{ totalCount }, scope] = await measureRequestPhase('count', () =>
    Promise.all([
      queryBrowseCount(mediaType, { ...query, limitResults: undefined }),
      unfiltered
        ? queryBrowseCount(mediaType, unfiltered, {
            includeLastfmSourceRows:
              mediaType === 'track' && requestsLastfmSource(query),
          })
        : undefined,
    ]),
  )
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

function firstTrackArtistRows(creditIds: SQL) {
  return sql`select distinct on (c.media_item_id) c.media_item_id, lower(a.name) as name
    from (${creditIds}) subjects
    join media_credit c on c.media_item_id = subjects.credit_id and c.role = 'artist'
    join artist a on a.id = c.artist_id
    order by c.media_item_id, c.billing_order, a.name`
}

/** Keep ties in a release together and in their stored playing order. */
function trackNaturalOrder(
  primary: string,
  setKeys?: { artist: SQL; position: SQL },
  columns: Record<
    keyof typeof trackReleaseColumns,
    SQLWrapper
  > = trackReleaseColumns,
) {
  const { id, title, releaseDate, albumId, albumName, spotifyAlbumId } = columns
  const sortedAlbumName = trackAlbumSortName(albumName)
  const artist =
    setKeys?.artist ?? firstTrackArtist(sql`coalesce(${albumId}, ${id})`)
  const albumDate = sql`case when ${albumId} is null then ${releaseDate}
    else ${trackSortAlbum.releaseDate} end`
  const position =
    setKeys?.position ??
    sql`(select min(t.position) from track t
    where t.track_media_item_id = ${id} and t.album_media_item_id = ${albumId})`
  const withinAlbum = [
    albumId,
    sql`case when ${albumId} is null then ${spotifyAlbumId} end`,
    position,
    sql`lower(${title})`,
  ]
  const year = sql`extract(year from ${albumDate})`
  const grouped =
    primary === 'artist'
      ? [year, sortedAlbumName]
      : primary === 'album'
        ? [albumDate]
        : primary === 'releaseDate'
          ? [artist, sortedAlbumName]
          : [artist, year, sortedAlbumName]
  return [...grouped, ...withinAlbum].map((key) => sql`${key} asc nulls last`)
}

/** Search and facets read values before aggregation so PostgreSQL can index them. */
function textRows(
  key: string,
  mediaType: MediaType,
  options: {
    includeArchived?: boolean
    normalizeTags?: boolean
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
    const membership = artistTagMemberships(mediaType)
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
const CachedTrackFacetsSchema = z.object({
  ready: z.boolean(),
  rows: z.array(FacetRowSchema),
})
const musicTagFacetFields = ['genre', 'albumTag', 'artistTag']
const tagFacetFields = [...musicTagFacetFields, 'keyword']

const releaseTagFacetKeys = sql`select t.id as tag_id, ${normalizedTagSql(sql`t.name`)} as value
  from tag t where t.media_type = 'album' and not t.hidden
  union all select tag_id, ancestor_key from (${tagAncestorRows('album')}) ancestors`

function albumTagFacetRows(key: string) {
  const visible = sql`media_item.media_type = 'album'
    and media_item.metadata->>'legacyHidden' is distinct from 'true'`
  const release = sql`select media_item.id, labels.value from media_item
    join media_item_tag mt on mt.media_item_id = media_item.id
    join browse_release_facet_keys labels on labels.tag_id = mt.tag_id
    where ${visible}`
  if (key === 'albumTag') return release
  const artist = sql`select media_item.id, labels.value from media_item
    join media_credit c on c.media_item_id = media_item.id and c.role = 'artist'
    join browse_artist_facet_keys labels on labels.artist_id = c.artist_id
    where ${visible}`
  if (key === 'artistTag') return artist
  return sql`${release} union all ${artist}
    and media_item.id not in (${albumsWithEnoughTags()})`
}

function musicFacetSources(mediaType: 'album' | 'track', matches?: SQL) {
  const condition = matches ? sql`where ${matches}` : sql``
  return [
    sql`browse_artist_facet_keys as materialized (
      select artist_id, value from (${artistTagFacetKeys(mediaType)}) keys ${condition}
    )`,
    sql`browse_release_facet_keys as materialized (
      select tag_id, value from (${releaseTagFacetKeys}) keys ${condition}
    )`,
  ]
}

function trackMusicFacetSources(includeLastfmSourceRows?: boolean) {
  const visibility = includeLastfmSourceRows
    ? sql``
    : sql`and m.id not in (select id from redundant_lastfm_tracks)`
  return [
    // Every track on the same album with the same credited artists contributes
    // the same labels. Expand the labels once and carry the track count.
    sql`browse_track_facet_groups as materialized (
      select row_number() over () as id, album_id, artist_ids, count(*) as weight
      from (
        select m.id, lt.album_media_item_id as album_id,
          array_agg(c.artist_id order by c.artist_id) filter (where c.artist_id is not null) as artist_ids
        from media_item m join library_track lt on lt.media_item_id = m.id
        left join media_credit c on c.media_item_id = m.id and c.role = 'artist'
        where m.media_type = 'track' and m.metadata->>'legacyHidden' is distinct from 'true' ${visibility}
          and (exists (select 1 from browse_artist_facet_keys)
            or exists (select 1 from browse_release_facet_keys))
        group by m.id, lt.album_media_item_id
      ) credited_tracks group by album_id, artist_ids
    )`,
    sql`browse_track_facet_counts as materialized (
      select labels.value,
        sum(g.weight) filter (where labels.release_tag) as album_tag,
        sum(g.weight) filter (where labels.artist_tag) as artist_tag,
        sum(g.weight) filter (where labels.release_tag or dense.media_item_id is null) as genre
      from (
        select id, value, bool_or(is_release) as release_tag, bool_or(not is_release) as artist_tag
        from (
          select g.id, labels.value, true as is_release from browse_track_facet_groups g
          join media_item_tag mt on mt.media_item_id = g.album_id
          join browse_release_facet_keys labels on labels.tag_id = mt.tag_id
          union all
          select g.id, labels.value, false as is_release from browse_track_facet_groups g
          cross join lateral unnest(g.artist_ids) as credit(artist_id)
          join browse_artist_facet_keys labels on labels.artist_id = credit.artist_id
        ) tag_hits group by id, value
      ) labels join browse_track_facet_groups g on g.id = labels.id
      left join (${albumsWithEnoughTags()}) dense on dense.media_item_id = g.album_id
      group by labels.value
    )`,
  ]
}

function trackMusicFacetRows(
  field: BrowseField,
  query: BrowseFacetQuery,
  limit: number | undefined,
) {
  const count =
    field.key === 'albumTag'
      ? sql`album_tag`
      : field.key === 'artistTag'
        ? sql`artist_tag`
        : sql`genre`
  const matches = facetValueMatches(field, query)
  return sql`(select ${field.key}::text as field, value, ${count}::int as count
    from browse_track_facet_counts
    where ${count} is not null and value is not null and value <> ''
      ${matches ? sql`and ${matches}` : sql``}
    ${facetOrder(query, limit)})`
}

const redundantTrackFacetSource = sql`redundant_lastfm_tracks as materialized (${redundantLastfmTrackIds()})`
export async function listBrowseFacets(
  mediaType: MediaType,
  input: Partial<BrowseFacetQuery> = {},
  options: { includeLastfmSourceRows?: boolean; fields?: BrowseField[] } = {},
) {
  const query = BrowseFacetQuerySchema.parse(input)
  const fields = (options.fields ?? (await listBrowseFields(mediaType))).filter(
    (field) => field.type === 'text' && field.filterable,
  )
  const rows = await measureRequestPhase('facets', () =>
    facetCache(JSON.stringify([mediaType, fields, query, options]), () =>
      queryBrowseFacets(mediaType, fields, query, options),
    ),
  )
  return rows
    .map((row) => ({
      ...row,
      // A tag value is its normalized name; the label shows the display name.
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${tagFacetFields.includes(row.field) ? formatTagName(row.value) : row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

function facetValueMatches(field: BrowseField, query: BrowseFacetQuery) {
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const matches = words
    .filter(
      (word) =>
        field.key === 'title' ||
        !`${field.label}:`.toLowerCase().includes(word),
    )
    .map((word) => sql`value ilike ${`%${word.replace(/[\\%_]/g, '\\$&')}%`}`)
  return and(...matches)
}

// Limit each field independently so common values never crowd out other fields.
function facetOrder(query: BrowseFacetQuery, limit: number | undefined) {
  return limit === undefined
    ? sql``
    : sql`order by case when lower(value) = ${query.q?.toLowerCase() ?? ''} then 0 else 1 end,
      count desc, value asc limit ${limit}`
}

export function browseFacetRows(
  field: BrowseField,
  source: SQL,
  query: BrowseFacetQuery,
  limit: number | undefined,
  visibility = sql``,
  counting:
    | 'distinctItems'
    | 'uniqueRows'
    | 'deduplicateRows' = 'distinctItems',
) {
  const search = facetValueMatches(field, query)
  const values = sql`from (${source}) values_for_field
    where value is not null and value <> '' ${search ? sql`and ${search}` : sql``} ${visibility}`
  // Music tag rows can overlap through several source tags or credits. Let
  // PostgreSQL deduplicate those item/value pairs before grouping by value.
  const distinctValues =
    counting === 'deduplicateRows'
      ? sql`from (select distinct value, id ${values}) distinct_items`
      : values
  const count =
    counting === 'distinctItems' ? sql`count(distinct id)` : sql`count(*)`
  return sql`(select ${field.key}::text as field, value, ${count}::int as count
    ${distinctValues}
    group by value
    ${facetOrder(query, limit)})`
}

function browseFacetQuery(
  mediaType: MediaType,
  fields: BrowseField[],
  query: BrowseFacetQuery,
  options: { includeLastfmSourceRows?: boolean },
  completeVocabulary = false,
) {
  const limit = completeVocabulary
    ? undefined
    : facetFieldLimit(query, fields.length)
  const music = mediaType === 'album' || mediaType === 'track'
  const sources: SQL[] = []
  if (mediaType === 'track' && !options.includeLastfmSourceRows)
    sources.push(redundantTrackFacetSource)
  const musicFields = music
    ? fields.filter((field) => musicTagFacetFields.includes(field.key))
    : []
  if (mediaType === 'track' && musicFields.length) {
    // Restrict expansion to labels wanted by any of the requested tag fields.
    const matches = or(
      ...musicFields.map(
        (field) => facetValueMatches(field, query) ?? sql`true`,
      ),
    )
    sources.push(...musicFacetSources(mediaType, matches))
    sources.push(...trackMusicFacetSources(options.includeLastfmSourceRows))
  } else if (mediaType === 'album' && musicFields.length) {
    sources.push(...musicFacetSources(mediaType))
  }
  const queries = fields.map((field) => {
    const musicTagFacet = music && musicTagFacetFields.includes(field.key)
    if (mediaType === 'track' && musicTagFacet)
      return trackMusicFacetRows(field, query, limit)
    const source = musicTagFacet
      ? albumTagFacetRows(field.key)
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
  const withSources = sources.length
    ? sql`with ${sql.join(sources, sql`, `)}`
    : sql``
  return sql`${withSources} ${sql.join(queries, sql` union all `)}`
}

function facetFieldLimit(query: BrowseFacetQuery, fieldCount: number) {
  return Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / fieldCount)),
  )
}

/** Store the exact order as a rank so long labels need no B-tree text key. */
const trackFacetBuildQuery = sql`select field,
  row_number() over (partition by field order by count desc, value asc) as rank, value, count
  from (${browseFacetQuery(
    'track',
    trackBrowseFields.filter(
      (field) => field.type === 'text' && field.filterable,
    ),
    BrowseFacetQuerySchema.parse({}),
    {},
    true,
  )}) facet`
// Only readers with the same database role and counting rules share values.
const trackFacetBuilder = sql`current_user || ':' || ${checksumJson(dialect.sqlToQuery(trackFacetBuildQuery))}::text`

function readTrackFacetQuery(fields: BrowseField[], query: BrowseFacetQuery) {
  const limit = facetFieldLimit(query, fields.length)
  const facets = fields.map((field) => {
    const priority = query.q
      ? sql`case when lower(value) = ${query.q.toLowerCase()} then 0 else 1 end, `
      : sql``
    const matches = facetValueMatches(field, query)
    return sql`(select field, value, count from track_facet_value
      where field = ${field.key} ${matches ? sql`and ${matches}` : sql``}
      order by ${priority}rank limit ${limit})`
  })
  return sql`with ready_track_facet_vocabulary as materialized (
      select exists (
        select 1 from track_facet_state where singleton and ready and builder = ${trackFacetBuilder}
      ) and not exists (select 1 from track_facet_dirty) as ready
    )
    select ready, case when ready
      then coalesce((select jsonb_agg(facet) from (${sql.join(facets, sql` union all `)}) facet), '[]'::jsonb)
      else '[]'::jsonb end as rows
    from ready_track_facet_vocabulary`
}

const foregroundTrackFacetBudget = 5_000
const FacetClaimSchema = z.object({ lease: z.string() })
const FacetRefreshErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
})
const staleTrackFacetState = sql`(not track_facet_state.ready
  or track_facet_state.builder <> ${trackFacetBuilder}
  or exists (select 1 from track_facet_dirty))`

function facetRefreshError(error: unknown) {
  const cause = error instanceof Error ? (error.cause ?? error) : error
  const parsed = FacetRefreshErrorSchema.safeParse(cause)
  if (parsed.success) return parsed.data
}

async function claimTrackFacetRefresh(maintenance: boolean) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '100ms'`)
    const result = await tx.execute(
      maintenance
        ? sql`update track_facet_state
          set retry_after = statement_timestamp() + interval '120 seconds'
          where singleton and retry_after <= statement_timestamp() and ${staleTrackFacetState}
          returning retry_after::text as lease, maintenance_only`
        : sql`insert into track_facet_state (singleton, builder, retry_after)
          select true, ${trackFacetBuilder}, statement_timestamp() + interval '30 seconds'
          where not exists (select 1 from track_facet_state
            where singleton and (maintenance_only or retry_after > statement_timestamp()))
          on conflict (singleton) do update set retry_after = excluded.retry_after
          where not track_facet_state.maintenance_only
            and track_facet_state.retry_after <= statement_timestamp()
            and ${staleTrackFacetState}
          returning retry_after::text as lease`,
    )
    const row = result.rows[0]
    return row ? FacetClaimSchema.parse(row).lease : undefined
  })
}

async function deferTrackFacetRefreshToMaintenance(lease: string) {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '100ms'`)
      await tx.execute(sql`update track_facet_state
        set maintenance_only = true, retry_after = clock_timestamp()
        where singleton and retry_after = ${lease}::timestamptz`)
    })
  } catch (error) {
    if (!canReadDatabaseWithoutCache(error)) throw error
  }
}

async function refreshTrackFacets(maintenance = false): Promise<boolean> {
  const expired = new Error('Track facet refresh exceeded its budget')
  let lease: string | undefined
  try {
    lease = await claimTrackFacetRefresh(maintenance)
    if (!lease) return false
    const claimed = sql`singleton and retry_after = ${lease}::timestamptz`
    const started = performance.now()
    const deadline =
      started + (maintenance ? 60_000 : foregroundTrackFacetBudget)
    return await db.transaction(
      async (tx) => {
        const guard =
          await tx.execute(sql`select set_config('lock_timeout', '100ms', true),
        set_config('jit', 'off', true),
        pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':track_facet_vocabulary', 0))
          and exists (select 1 from track_facet_state where ${claimed}) as ready`)
        if (!z.object({ ready: z.boolean() }).parse(guard.rows[0]).ready)
          return false

        async function executeWithinBudget(statement: SQL) {
          const remaining = Math.floor(deadline - performance.now())
          if (remaining <= 0) throw expired
          await tx.execute(
            sql`select set_config('statement_timeout', ${`${remaining}ms`}, true)`,
          )
          await tx.execute(statement)
        }

        // Claim visible markers before the build so concurrent writers skip them.
        // Later commits still leave their own markers to invalidate this snapshot.
        await executeWithinBudget(sql`delete from track_facet_dirty where transaction_id in (
        select transaction_id from track_facet_dirty for update skip locked)`)
        await executeWithinBudget(sql`delete from track_facet_value`)
        await executeWithinBudget(sql`insert into track_facet_value (field, rank, value, count)
        ${trackFacetBuildQuery}`)
        const tookTooLong =
          performance.now() - started >= foregroundTrackFacetBudget
        await executeWithinBudget(sql`update track_facet_state set ready = true,
        builder = ${trackFacetBuilder}, retry_after = clock_timestamp() + interval '5 seconds',
        maintenance_only = maintenance_only or ${tookTooLong}
        where ${claimed}`)
        return true
      },
      { isolationLevel: 'repeatable read' },
    )
  } catch (error) {
    const failure = facetRefreshError(error)
    if (
      !maintenance &&
      lease &&
      (error === expired ||
        (failure?.code === '57014' &&
          failure.message.includes('statement timeout')))
    )
      await deferTrackFacetRefreshToMaintenance(lease)
    // The optional claim column may be absent during a rolling upgrade.
    if (
      error === expired ||
      (!lease && failure?.code === '42703') ||
      canReadDatabaseWithoutCache(error)
    )
      return false
    throw error
  }
}

/** Refresh an already requested vocabulary outside the foreground latency budget. */
export async function refreshTrackFacetVocabularyForMaintenance(): Promise<boolean> {
  return refreshTrackFacets(true)
}

async function readTrackFacetsFromVocabulary(query: SQL, broad: boolean) {
  const read = async () =>
    CachedTrackFacetsSchema.parse((await db.execute(query)).rows[0])
  try {
    const result = await measureRequestPhase('facetRead', read)
    if (result.ready) return result.rows
    // Selective queries can use indexed live rows until a broad query builds the vocabulary.
    if (
      broad &&
      (await measureRequestPhase('facetBuild', () => refreshTrackFacets()))
    ) {
      const refreshed = await measureRequestPhase('facetRead', read)
      if (refreshed.ready) return refreshed.rows
    }
  } catch (error) {
    if (!canReadDatabaseWithoutCache(error)) throw error
  }
}

async function queryBrowseFacets(
  mediaType: MediaType,
  fields: BrowseField[],
  query: BrowseFacetQuery,
  options: { includeLastfmSourceRows?: boolean; fields?: BrowseField[] },
): Promise<FacetRow[]> {
  if (!fields.length) return []
  const cached =
    mediaType === 'track' && !options.includeLastfmSourceRows && !options.fields
      ? await readTrackFacetsFromVocabulary(
          readTrackFacetQuery(fields, query),
          (query.q ?? '').split(/\s+/).every((word) => word.length < 3),
        )
      : undefined
  const rows: FacetRow[] =
    cached ??
    z
      .array(FacetRowSchema)
      .parse(
        (
          await measureRequestPhase('facetLive', async () =>
            db.execute(browseFacetQuery(mediaType, fields, query, options)),
          )
        ).rows,
      )
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
