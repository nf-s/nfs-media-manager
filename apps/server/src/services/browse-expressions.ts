import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  albumEditionLabels,
  type BrowseField,
  type TagLevels,
} from '@repo/schemas/browse'
import { trackAlbumLinkLabels, trackSourceLabels } from '@repo/schemas/tracks'
import {
  mediaItem,
  album,
  film,
  libraryTrack,
  mediaOverride,
} from '@/schemas/db'
import { catalogScopeCondition } from './catalog-scope'
import { albumMatchRejectionField } from './album-match-rejections'
import { normalizedTagSql } from './tag-state'
import { tagAncestorRows } from './tag-hierarchy'
import { albumAddedDateExpression } from './album-added-dates'
import {
  firstMusicTagRows,
  albumsWithEnoughTags,
  artistTagMemberships,
  firstArtistTag,
  firstMusicTag,
  releaseTagMemberships,
  type MusicTagScope,
} from './music-tags'
import {
  albumTrackDurationExpression,
  belongsToLibraryAlbum,
  trackProviderRows,
  trackProvidersExpression,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
} from './track-values'
import {
  verifiedTrackBpm,
  verifiedTrackFactOrderRows,
  verifiedTrackKey,
  verifiedTrackKeyPosition,
  verifiedTrackKeyRows,
} from './track-facts'

/**
 * The SQL Browse filters, searches and orders by, shared by the Browse
 * services and the device row projection (docs/requirements/device-store.md)
 * so the two cannot drift. Row expressions read `media_item`, `library_track`,
 * `album`, `film` and `track_sort_album` (the linked album of a track).
 */

export type MediaType = 'album' | 'film' | 'track'

export const trackSortAlbum = alias(mediaItem, 'track_sort_album')
export const trackReleaseColumns = {
  id: mediaItem.id,
  title: mediaItem.title,
  releaseDate: mediaItem.releaseDate,
  albumId: libraryTrack.albumMediaItemId,
  albumName: libraryTrack.albumName,
  spotifyAlbumId: libraryTrack.spotifyAlbumId,
}

export function trackAlbumSortName(albumName: SQLWrapper) {
  return sql`lower(coalesce(nullif(trim(${trackSortAlbum.title}), ''), nullif(trim(${albumName}), '')))`
}

export const trackSortAlbumName = trackAlbumSortName(libraryTrack.albumName)

// Playlists an album is in: as a member, or through a linked library track.
export const albumPlaylistIds = sql`(
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

export function albumPlaylistRows(condition = sql`true`): SQL {
  const membership = sql`from playlist p join playlist_item pi on pi.playlist_id = p.id`
  const where = sql`where p.kind = 'playlist' and ${condition}`
  return sql`select pi.media_item_id as id, p.name as value ${membership} ${where}
    union all select lt.album_media_item_id, p.name ${membership}
      join library_track lt on lt.media_item_id = pi.media_item_id ${where}
    union all select t.album_media_item_id, p.name ${membership}
      join track t on t.track_media_item_id = pi.media_item_id ${where}`
}

export function trackValueExpression(key: string): SQL | null {
  switch (key) {
    case 'source':
      return trackSourcesExpression(
        sql`${mediaItem.id}`,
        sql`${mediaItem.metadata}`,
        true,
      )
    case 'spotifyMatch':
      return sql`to_jsonb(${trackSpotifyMatchExpression(sql`${libraryTrack.spotifyTrackId}`, sql`${mediaItem.sourceLabel}`, true)})`
    case 'provider':
      return trackProvidersExpression(
        sql`${mediaItem.id}`,
        sql`${libraryTrack.spotifyTrackId}`,
      )
    case 'album':
      return sql`to_jsonb(coalesce(${libraryTrack.albumName}, (select am.title from media_item am where am.id = ${libraryTrack.albumMediaItemId})))`
    case 'albumLink':
      return sql`to_jsonb(case when ${libraryTrack.albumMediaItemId} is null then ${trackAlbumLinkLabels.unlinked}::text else ${trackAlbumLinkLabels.linked}::text end)`
    case 'hasTrackTags':
      return sql`to_jsonb(case when ${libraryTrack.hasOwnTags} then 'Yes'::text else 'No'::text end)`
    case 'bpm':
      return sql`to_jsonb(${verifiedTrackBpm(sql`${mediaItem.id}`)})`
    case 'musicalKey':
      return sql`to_jsonb(${verifiedTrackKey(sql`${mediaItem.id}`)})`
    case 'albumTag':
      return sql`(select jsonb_agg(distinct t.name order by t.name) from media_item_tag mt join tag t on t.id = mt.tag_id where mt.media_item_id = ${libraryTrack.albumMediaItemId} and t.media_type = 'album' and not t.hidden)`
    case 'trackTag':
      return sql`(select jsonb_agg(t.name order by t.name) from track_tag tt join tag t on t.id = tt.tag_id where tt.media_item_id = ${libraryTrack.mediaItemId} and tt.in_browse and not t.hidden)`
    default:
      return null
  }
}

// Albums Edition: the album points at the first album of its record.
export const albumIsEdition = sql`exists (select 1 from album e
  where e.media_item_id = ${mediaItem.id} and e.edition_of_id is not null)`

export function rejectedAlbumMetacriticIds() {
  return sql`select ${mediaOverride.mediaItemId} from ${mediaOverride}
  where ${mediaOverride.field} = ${albumMatchRejectionField}
    and ${mediaOverride.value}->>'provider' = 'google-custom-search'
    and ${mediaOverride.value}->>'referenceType' = 'metacritic-url'`
}

export function storedBrowseField(
  key: string,
  mediaType: MediaType,
  fields = sql`${mediaItem.metadata}->'browse'`,
  metacriticAccepted?: SQL,
): SQL {
  const value = sql`(${fields}->${key}::text)`
  if (
    mediaType !== 'album' ||
    (key !== 'ratingMetacriticValue' && key !== 'ratingMetacriticVotes')
  )
    return value
  const accepted =
    metacriticAccepted ??
    sql`not exists (
    select 1 from (${rejectedAlbumMetacriticIds()}) rejected where rejected.media_item_id = ${mediaItem.id})`
  return sql`(case when ${accepted} then ${value} end)`
}

export function valueExpression(key: string, mediaType: MediaType): SQL {
  const trackValue = mediaType === 'track' ? trackValueExpression(key) : null
  if (trackValue) return trackValue
  if (mediaType === 'album' && key === 'edition')
    return sql`to_jsonb(case when ${albumIsEdition} then ${albumEditionLabels.edition}::text else ${albumEditionLabels.notEdition}::text end)`
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
    default:
      return storedBrowseField(key, mediaType)
  }
}

/** A JSON value's first text: an array's first element, otherwise the value. */
export function firstText(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'array' then ${value}->>0 else ${value} #>> '{}' end`
}

/** A JSON value's texts as rows: each element of an array, otherwise the value. */
export function textElements(value: SQL): SQL {
  return sql`jsonb_array_elements_text(case when jsonb_typeof(${value}) = 'array' then ${value} else jsonb_build_array(${value}) end)`
}

export function textExpression(key: string, mediaType: MediaType): SQL {
  if (key === 'title') return sql`${mediaItem.title}`
  if (key === 'summary') return sql`${mediaItem.summary}`
  return firstText(valueExpression(key, mediaType))
}

export function jsonNumber(value: SQL): SQL {
  return sql`case when jsonb_typeof(${value}) = 'number' then (${value} #>> '{}')::numeric else null end`
}

export function storedBrowseNumber(
  key: string,
  mediaType: MediaType,
  fields?: SQL,
  metacriticAccepted?: SQL,
): SQL {
  return jsonNumber(
    storedBrowseField(key, mediaType, fields, metacriticAccepted),
  )
}

export function numericExpression(key: string, mediaType: MediaType): SQL {
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
    case 'bpm':
      if (mediaType === 'track') return verifiedTrackBpm(sql`${mediaItem.id}`)
      break
    case 'lastListenedAt':
      if (mediaType === 'track')
        return sql`extract(epoch from ${libraryTrack.lastListenedAt}) * 1000`
      break
  }
  return jsonNumber(valueExpression(key, mediaType))
}

/** Multi-valued fields sort by their first displayed label. Read memberships once. */
// Order rows whose name is a number rather than text.
export const numericOrderRowFields = new Set(['bpm', 'musicalKey'])

// A track's own tags in Browse, by name.
export const ownTrackTagRows = sql`select tt.media_item_id, t.name
  from track_tag tt join tag t on t.id = tt.tag_id
  where tt.in_browse and not t.hidden`
export const firstOwnTrackTags = sql`select media_item_id, min(name) as name
  from (${ownTrackTagRows}) own_tags group by media_item_id`

/**
 * Order rows limited to the rows of some items: `tracks` limits the library
 * tracks (alias `lt`) of the Tracks Auto location; the rest as MusicTagScope.
 * Library-wide when empty, as Browse reads them.
 */
export type BrowseOrderScope = MusicTagScope & { tracks?: SQL }

/**
 * TTAG-28: the first tag at a location. Auto takes a track's own first tag,
 * and the first tag it inherits only when it has none (`has_own_tags`);
 * levels take the first tag on any of them. Each level contributes at most
 * one row per item, read once for the statement.
 */
export function tagLocationOrderRows(
  mediaType: 'album' | 'track',
  levels: TagLevels | undefined,
  scope: BrowseOrderScope = {},
): SQL {
  if (!levels && mediaType === 'album')
    return firstMusicTagRows(mediaType, undefined, scope)
  if (!levels)
    return sql`${firstOwnTrackTags} union all
      select media_item_id, name from (${firstMusicTagRows(
        'track',
        scope.tracks
          ? sql`not lt.has_own_tags and ${scope.tracks}`
          : sql`not lt.has_own_tags`,
        scope,
      )}) inherited`
  const firstReleaseTags = sql`select media_item_id, min(name) as name
    from (${releaseTagMemberships(scope.albums)}) r group by media_item_id`
  const rows: SQL[] = []
  if (levels.includes('track'))
    rows.push(
      mediaType === 'track'
        ? firstOwnTrackTags
        : sql`select lt.album_media_item_id as media_item_id, min(own_tags.name) as name
            from (${ownTrackTagRows}) own_tags
            join library_track lt on lt.media_item_id = own_tags.media_item_id
            where lt.album_media_item_id is not null group by lt.album_media_item_id`,
    )
  if (levels.includes('album'))
    rows.push(
      mediaType === 'track'
        ? sql`select lt.media_item_id, r.name from (${firstReleaseTags}) r
            join library_track lt on lt.album_media_item_id = r.media_item_id`
        : firstReleaseTags,
    )
  if (levels.includes('artist'))
    rows.push(sql`select media_item_id, min(name) as name
      from (${artistTagMemberships(mediaType, scope.artistTags)}) a group by media_item_id`)
  return sql`select media_item_id, min(name) as name
    from (${sql.join(rows, sql` union all `)}) tags group by media_item_id`
}

export function browseOrderRows(
  mediaType: MediaType,
  key: string,
  tagLevels?: TagLevels,
  scope: BrowseOrderScope = {},
): SQL | undefined {
  if (mediaType === 'track' && (key === 'bpm' || key === 'musicalKey'))
    return verifiedTrackFactOrderRows(key)
  if (mediaType !== 'film' && key === 'genre')
    return tagLocationOrderRows(mediaType, tagLevels, scope)
  if (mediaType !== 'film' && key === 'artistTag')
    return sql`select media_item_id, min(name) as name
      from (${artistTagMemberships(mediaType, scope.artistTags)}) tags group by media_item_id`
  if (mediaType === 'track' && key === 'trackTag')
    return sql`select tt.media_item_id, min(t.name) as name
      from track_tag tt join tag t on t.id = tt.tag_id
      where tt.in_browse and not t.hidden group by tt.media_item_id`
  if (
    key === 'playlist' ||
    key === 'collection' ||
    key === 'albumTag' ||
    (mediaType === 'film' && (key === 'genre' || key === 'keyword')) ||
    (mediaType === 'track' && (key === 'source' || key === 'provider'))
  )
    return sql`select id as media_item_id, min(value) as name from (
      ${textRows(key, mediaType, { includeArchived: true })}
    ) memberships group by id`
}

export function directSortExpression(
  key: string,
  mediaType: MediaType,
  tagLevels?: TagLevels,
): SQL | null {
  if (mediaType === 'album' && key === 'dateAdded')
    return albumAddedDateExpression
  if (mediaType === 'track') {
    const id = sql`${mediaItem.id}`
    if (key === 'genre') {
      // A track's own first tag; the album's and artists' as tagLocationOrderRows.
      const albumId = sql`${libraryTrack.albumMediaItemId}`
      const own = sql`(select min(own_tags.name) from (${ownTrackTagRows}) own_tags
        where own_tags.media_item_id = ${id})`
      if (!tagLevels)
        return sql`lower(coalesce(${own}, ${firstMusicTag(id, albumId)}))`
      const firsts = [
        ...(tagLevels.includes('track') ? [own] : []),
        ...(tagLevels.includes('album')
          ? [
              sql`(select min(r.name) from (${releaseTagMemberships(albumId)}) r)`,
            ]
          : []),
        ...(tagLevels.includes('artist') ? [firstArtistTag(id)] : []),
      ]
      return sql`lower(least(${sql.join(firsts, sql`, `)}))`
    }
    if (key === 'artistTag') return sql`lower(${firstArtistTag(id)})`
    if (key === 'artist') return firstTrackArtist(id)
    if (key === 'album') return trackSortAlbumName
    if (key === 'releaseDate')
      return sql`coalesce(${trackSortAlbum.releaseDate}, ${mediaItem.releaseDate})`
    if (key === 'dateAdded') return sql`${libraryTrack.dateAdded}`
    if (key === 'scrobbles') return sql`${libraryTrack.scrobbleCount}`
    if (key === 'lastListenedAt') return sql`${libraryTrack.lastListenedAt}`
    if (key === 'bpm') return verifiedTrackBpm(id)
    if (key === 'musicalKey') return verifiedTrackKeyPosition(id)
  }
  if (key === 'releaseDate' && mediaType !== 'track')
    return sql`${mediaItem.releaseDate}`
  return null
}

export function browseSortExpression(
  field: BrowseField,
  mediaType: MediaType,
  tagLevels?: TagLevels,
) {
  return (
    directSortExpression(field.key, mediaType, tagLevels) ??
    (field.type === 'text'
      ? sql`lower(${textExpression(field.key, mediaType)})`
      : numericExpression(field.key, mediaType))
  )
}

export function firstTrackArtist(mediaItemId: SQL) {
  return sql`(select lower(a.name)
    from media_credit c join artist a on a.id = c.artist_id
    where c.media_item_id = ${mediaItemId} and c.role = 'artist'
    order by c.billing_order, a.name limit 1)`
}

export function firstTrackArtistRows(creditIds: SQL) {
  return sql`select distinct on (c.media_item_id) c.media_item_id, lower(a.name) as name
    from (${creditIds}) subjects
    join media_credit c on c.media_item_id = subjects.credit_id and c.role = 'artist'
    join artist a on a.id = c.artist_id
    order by c.media_item_id, c.billing_order, a.name`
}

/** The values of the natural track order, over `columns` and `track_sort_album`. */
export function trackNaturalOrderValues(
  setKeys?: { artist: SQL; position: SQL },
  columns: Record<
    keyof typeof trackReleaseColumns,
    SQLWrapper
  > = trackReleaseColumns,
) {
  const { id, title, releaseDate, albumId, albumName, spotifyAlbumId } = columns
  const albumDate = sql`case when ${albumId} is null then ${releaseDate}
    else ${trackSortAlbum.releaseDate} end`
  return {
    sortedAlbumName: trackAlbumSortName(albumName),
    artist:
      setKeys?.artist ?? firstTrackArtist(sql`coalesce(${albumId}, ${id})`),
    albumDate,
    year: sql`extract(year from ${albumDate})`,
    albumId: sql`${albumId}`,
    spotifyAlbumId: sql`case when ${albumId} is null then ${spotifyAlbumId} end`,
    position:
      setKeys?.position ??
      sql`(select min(t.position) from track t
    where t.track_media_item_id = ${id} and t.album_media_item_id = ${albumId})`,
    title: sql`lower(${title})`,
  }
}

/** Keep ties in a release together and in their stored playing order. */
export function trackNaturalOrder(
  primary: string,
  setKeys?: { artist: SQL; position: SQL },
  columns: Record<
    keyof typeof trackReleaseColumns,
    SQLWrapper
  > = trackReleaseColumns,
) {
  const {
    sortedAlbumName,
    artist,
    albumDate,
    year,
    albumId,
    spotifyAlbumId,
    position,
    title,
  } = trackNaturalOrderValues(setKeys, columns)
  const withinAlbum = [albumId, spotifyAlbumId, position, title]
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
export function textRows(
  key: string,
  mediaType: MediaType,
  options: {
    includeArchived?: boolean
    normalizeTags?: boolean
    scope?: CatalogScopeQuery
    // Facets also list each tag's parents, counted over all their subtags.
    rollUpTags?: boolean
  } = {},
): SQL {
  const visible = sql`media_item.media_type = ${mediaType}
    ${options.includeArchived ? sql`` : sql`and media_item.metadata->>'legacyHidden' is distinct from 'true'`}
    ${options.scope ? sql`and ${catalogScopeCondition(sql`media_item.id`, sql`media_item.in_library`, options.scope, mediaType === 'track' ? 'track' : undefined)}` : sql``}`
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
      select media_item.id, ${trackSourceLabels.album}::text as value from media_item where ${visible} and ${belongsToLibraryAlbum(mediaItem.id)}
      union all
      select media_item.id, ${trackSourceLabels.lastfm}::text as value from media_item join lastfm_track_source s on s.track_media_item_id = media_item.id where ${visible}
      union all
      select media_item.id, ${trackSourceLabels['spotify-search']}::text as value from media_item where ${visible} and media_item.metadata ? 'spotifyTrackSearch'`
  if (mediaType === 'track' && key === 'albumLink')
    return sql`select media_item.id, ${trackAlbumLinkLabels.linked}::text as value from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.album_media_item_id is not null
      union all
      select media_item.id, ${trackAlbumLinkLabels.unlinked}::text as value from media_item left join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.album_media_item_id is null`
  if (mediaType === 'album' && key === 'edition')
    return sql`select media_item.id, ${albumEditionLabels.edition}::text as value from media_item join album a on a.media_item_id = media_item.id where ${visible} and a.edition_of_id is not null
      union all
      select media_item.id, ${albumEditionLabels.notEdition}::text as value from media_item left join album a on a.media_item_id = media_item.id where ${visible} and a.edition_of_id is null`
  // Literal labels let PostgreSQL drop a branch whose label cannot match.
  if (mediaType === 'track' && key === 'hasTrackTags')
    return sql`select media_item.id, 'Yes'::text as value from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.has_own_tags
      union all
      select media_item.id, 'No'::text as value from media_item left join library_track lt on lt.media_item_id = media_item.id where ${visible} and lt.has_own_tags is not true`
  if (mediaType === 'track' && key === 'musicalKey')
    return verifiedTrackKeyRows(visible)
  if (mediaType === 'track' && key === 'provider')
    return trackProviderRows(visible)
  if (mediaType === 'track' && key === 'spotifyMatch')
    return sql`select media_item.id,
      ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`media_item.source_label`, true)} as value
      from media_item join library_track lt on lt.media_item_id = media_item.id where ${visible}`
  const tagName = options.normalizeTags
    ? normalizedTagSql(sql`t.name`)
    : sql`t.name`
  if (mediaType === 'track' && key === 'trackTag') {
    const membership = sql`join track_tag tt on tt.media_item_id = media_item.id and tt.in_browse`
    const direct = sql`select media_item.id, ${tagName} as value from media_item ${membership}
      join tag t on t.id = tt.tag_id where ${visible} and not t.hidden`
    if (!options.rollUpTags) return direct
    return sql`${direct}
      union all select media_item.id, ancestor.ancestor_key as value from media_item ${membership}
        join (${tagAncestorRows('album')}) ancestor on ancestor.tag_id = tt.tag_id
        where ${visible}`
  }
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
  const present =
    mediaType === 'album' && key === 'country'
      ? sql`and media_item.metadata->'browse' ? 'country'`
      : sql``
  return sql`select media_item.id, v.value from media_item left join film on film.media_item_id = media_item.id ${trackColumns}
    cross join lateral ${textElements(value)} v(value)
    where ${visible} ${present}`
}
