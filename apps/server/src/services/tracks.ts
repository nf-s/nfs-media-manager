import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { BrowseFacetQuery } from '@repo/schemas/browse'
import { spotifyIdPattern } from '@repo/schemas/playback'
import {
  PlaylistAlbumSchema,
  PlaylistDetailSchema,
  PlaylistRemovalSchema,
  TrackAlbumLinkStrategySchema,
  TrackDetailSchema,
  TrackListItemSchema,
  TrackScrobbleLinkStrategySchema,
  TrackSourceSchema,
  TrackSpotifyAlternateSchema,
  TrackSpotifyMatchSchema,
  type PlaylistAlbum,
  type PlaylistDetail,
  type PlaylistDetailQuery,
  type PlaylistEntry,
  type PlaylistEntrySort,
  type PlaylistSyncSchedule,
  type TrackDetail,
  type TrackListItem,
  type TrackPositionsQuery,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  albumTrackDurationExpression,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
} from './track-values'
import { playlist } from '@/schemas/db'
import {
  listBrowseFacets,
  queryBrowseIds,
  queryBrowsePageIds,
  queryBrowsePositions,
  queryTrackRecordingVersions,
} from './browse'
import { trackSpotifyAlternate, type RecordingGroup } from './recording-groups'
import { refreshTrackAddedDates } from './spotify-playlists'
import { getLastfmTrackNames } from './lastfm-track-names'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { artistTagsExpression } from './music-tags'
import { getPlaylistSummary, playlistAlbumMembers } from './playlist-directory'
import { setPlaylistSyncSchedule } from './spotify-playlist-sync'

const isoTimestamp = (column: SQL) =>
  sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const TrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artwork_url: z.string().nullable(),
    release_date: z.string().nullable(),
    artists: z.array(z.string()),
    artist_credits: z.array(z.object({ id: z.string(), name: z.string() })),
    artist_tags: z.array(z.string()),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
    album_title: z.string().nullable(),
    album_link_strategy: TrackAlbumLinkStrategySchema.nullable(),
    album_tags: z.array(z.string()),
    playlists: z.array(z.object({ id: z.string(), name: z.string() })),
    sources: z.array(TrackSourceSchema),
    duration_sec: z.number().int().nullable(),
    date_added: z.string().nullable(),
    spotify_track_id: z.string().nullable(),
    spotify_match: TrackSpotifyMatchSchema,
    spotify_url: z.string().nullable(),
    isrc: z.string().nullable(),
    scrobble_count: z.number().int(),
    last_listened_at: z.string().nullable(),
  }),
)

export async function loadTracks(ids: string[]): Promise<TrackListItem[]> {
  if (!ids.length) return []
  const rows = TrackRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title, coalesce(mi.artwork_url, am.artwork_url) as artwork_url,
          ${isoTimestamp(sql`coalesce(mi.release_date, am.release_date)`)} as release_date,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '[]'::jsonb) as artist_credits,
          ${artistTagsExpression(sql`mi.id`)} as artist_tags,
          coalesce(lt.album_name, am.title) as album_name, lt.album_media_item_id as album_id,
          am.title as album_title, lt.album_link_strategy,
          coalesce((
            select array_agg(distinct t.name order by t.name)
            from media_item_tag mt join tag t on t.id = mt.tag_id
            where mt.media_item_id = lt.album_media_item_id
              and t.media_type = 'album' and not t.hidden), '{}') as album_tags,
          coalesce((
            select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
              order by p.name)
            from playlist_item pi join playlist p on p.id = pi.playlist_id
            where pi.media_item_id = mi.id), '[]'::jsonb) as playlists,
          ${trackSourcesExpression(sql`mi.id`, sql`mi.metadata`)} as sources,
          coalesce(lt.duration_sec, ${albumTrackDurationExpression(sql`lt.media_item_id`, sql`lt.album_media_item_id`)}) as duration_sec,
          lt.spotify_track_id,
          ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`mi.source_label`)} as spotify_match,
          ${isoTimestamp(sql`lt.date_added`)} as date_added,
          lt.spotify_url, lt.isrc, lt.scrobble_count,
          ${isoTimestamp(sql`lt.last_listened_at`)} as last_listened_at
        from library_track lt
        join media_item mi on mi.id = lt.media_item_id
        left join media_item am on am.id = lt.album_media_item_id
        where lt.media_item_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    ).rows,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    const spotifyTrackId = row.spotify_track_id
    return [
      TrackListItemSchema.parse({
        id: row.id,
        mediaType: 'track',
        title: row.title,
        artworkUrl: row.artwork_url,
        releaseDate: row.release_date,
        artists: row.artists,
        artistCredits: row.artist_credits,
        artistTags: row.artist_tags,
        albumName: row.album_name,
        album:
          row.album_id && row.album_title !== null
            ? { id: row.album_id, title: row.album_title }
            : null,
        albumLinkStrategy: row.album_link_strategy,
        albumTags: row.album_tags,
        playlists: row.playlists,
        sources: row.sources,
        durationSec: row.duration_sec,
        dateAdded: row.date_added,
        spotifyTrackId,
        spotifyMatch: row.spotify_match,
        spotifyUrl:
          row.spotify_url ??
          (spotifyTrackId
            ? `https://open.spotify.com/track/${spotifyTrackId}`
            : null),
        isrc: row.isrc,
        scrobbles: row.scrobble_count,
        lastListenedAt: row.last_listened_at,
      }),
    ]
  })
}

/** Browse values: a grouped row's totals and the count in a sort period. */
function trackWithRecordingGroup(
  track: TrackListItem,
  group?: RecordingGroup,
  listeningScrobbles?: number,
): TrackListItem {
  const item =
    listeningScrobbles === undefined ? track : { ...track, listeningScrobbles }
  if (!group || group.version_count === 1) return item
  return {
    ...item,
    scrobbles: group.scrobbles,
    lastListenedAt: group.last_listened_at,
    dateAdded: group.date_added,
    recordingGroup: { versionCount: group.version_count },
  }
}

export async function listTracks(query: TrackQuery) {
  const { ids, totalCount, pageCount, recordingGroups, listeningScrobbles } =
    await queryBrowseIds('track', query)
  return {
    items: (await loadTracks(ids)).map((track) =>
      trackWithRecordingGroup(
        track,
        recordingGroups?.get(track.id),
        listeningScrobbles?.get(track.id),
      ),
    ),
    totalCount,
    pageCount,
  }
}

export async function listTrackBrowsePage(query: TrackQuery) {
  const { ids, hasMore, recordingGroups, listeningScrobbles } =
    await queryBrowsePageIds('track', query)
  return {
    items: (await loadTracks(ids)).map((track) =>
      trackWithRecordingGroup(
        track,
        recordingGroups?.get(track.id),
        listeningScrobbles?.get(track.id),
      ),
    ),
    page: query.page,
    size: query.size,
    hasMore,
  }
}

export async function listTrackRecordingVersions(
  id: string,
  query: TrackQuery,
) {
  const { ids, hasMore, listeningScrobbles } =
    await queryTrackRecordingVersions(id, query)
  return {
    items: (await loadTracks(ids)).map((track) =>
      trackWithRecordingGroup(
        track,
        undefined,
        listeningScrobbles?.get(track.id),
      ),
    ),
    page: query.page,
    size: query.size,
    hasMore,
  }
}

/** The tracks at the given positions of the query's order, in one read. */
export async function listTracksAtPositions(query: TrackPositionsQuery) {
  const rows = await queryBrowsePositions('track', query, query.positions)
  const items = new Map(
    (await loadTracks(rows.map((row) => row.id))).map((item) => [
      item.id,
      item,
    ]),
  )
  return {
    items: rows.flatMap(
      ({ id, position, recordingGroup, listeningScrobbles }) => {
        const item = items.get(id)
        return item
          ? [
              {
                position,
                item: trackWithRecordingGroup(
                  item,
                  recordingGroup,
                  listeningScrobbles,
                ),
              },
            ]
          : []
      },
    ),
  }
}

export const listTrackFilterOptions = (query: Partial<BrowseFacetQuery>) =>
  listBrowseFacets('track', query)

const ListeningSummarySchema = z
  .array(
    z.object({
      total: z.coerce.number(),
      first: z.number().nullable(),
      last: z.number().nullable(),
    }),
  )
  .length(1)
const MonthRowsSchema = z.array(
  z.object({ month: z.string(), count: z.coerce.number() }),
)
const SourceRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    count: z.coerce.number(),
    strategy: TrackScrobbleLinkStrategySchema,
  }),
)
const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

async function getTrackSpotifyAlternate(id: string) {
  const result = await db.execute(trackSpotifyAlternate(id))
  const [row] = z
    .object({ alternate: TrackSpotifyAlternateSchema })
    .array()
    .parse(result.rows)
  return row?.alternate
}

export async function getTrackDetail(id: string): Promise<TrackDetail | null> {
  const [item] = await loadTracks([id])
  if (!item) return null
  const linked = sql`from lastfm_track_link l
    join lastfm_scrobble s on s.username = l.username
      and s.artist_key = l.artist_key and s.track_key = l.track_key
    where l.track_media_item_id = ${id}`
  const summary = ListeningSummarySchema.parse(
    (
      await db.execute(sql`
        select count(*) as total,
          extract(epoch from min(s.listened_at))::float8 as first,
          extract(epoch from max(s.listened_at))::float8 as last
        ${linked}`)
    ).rows,
  )
  const months = MonthRowsSchema.parse(
    (
      await db.execute(sql`
        select to_char(date_trunc('month', s.listened_at), 'YYYY-MM') as month,
          count(*) as count
        ${linked} group by 1 order by 1`)
    ).rows,
  )
  const sources = SourceRowsSchema.parse(
    (
      await db.execute(sql`
        select l.artist_key, l.track_key, max(s.artist_name) as artist_name,
          max(s.track_name) as track_name, count(*) as count,
          max(l.strategy) as strategy
        ${linked}
        group by l.artist_key, l.track_key
        order by count(*) desc, l.artist_key, l.track_key limit 50`)
    ).rows,
  )
  const [lastfmSources, spotifyAlternate] = await Promise.all([
    getLastfmTrackNames(id),
    item.spotifyTrackId && spotifyIdPattern.test(item.spotifyTrackId)
      ? undefined
      : getTrackSpotifyAlternate(id),
  ])
  return TrackDetailSchema.parse({
    ...item,
    ...(spotifyAlternate ? { spotifyAlternate } : {}),
    lastfmSources,
    listening: {
      total: summary[0]?.total ?? 0,
      firstListenedAt: isoSeconds(summary[0]?.first ?? null),
      lastListenedAt: isoSeconds(summary[0]?.last ?? null),
      months,
      sources: sources.map((row) => ({
        artistKey: row.artist_key,
        trackKey: row.track_key,
        artistName: row.artist_name,
        trackName: row.track_name,
        count: row.count,
        strategy: row.strategy,
      })),
    },
  })
}

const EntryRowsSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(['track', 'album']),
    position: z.number().int(),
    added_at: z.string().nullable(),
  }),
)
const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))
const AlbumEntryRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    artwork_url: z.string().nullable(),
    release_date: z.string().nullable(),
    spotify_url: z.string().nullable(),
  }),
)

async function loadPlaylistAlbums(ids: string[]) {
  if (!ids.length) return new Map<string, PlaylistAlbum>()
  const rows = AlbumEntryRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title, mi.artwork_url,
          to_char(mi.release_date, 'YYYY-MM-DD') as release_date,
          al.spotify_url,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists
        from media_item mi join album al on al.media_item_id = mi.id
        where mi.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    ).rows,
  )
  return new Map(
    rows.map((row) => [
      row.id,
      PlaylistAlbumSchema.parse({
        id: row.id,
        title: row.title,
        artists: row.artists,
        artworkUrl: row.artwork_url,
        releaseDate: row.release_date,
        spotifyUrl: row.spotify_url,
      }),
    ]),
  )
}

const playlistEntryArtistsSort = sql`(select lower(string_agg(artist.name, ', ' order by c.billing_order, artist.name))
  from media_credit c join artist on artist.id = c.artist_id
  where c.media_item_id = mi.id and c.role = 'artist')`

function playlistEntrySearch(pattern: string) {
  return sql`mi.title ilike ${pattern}
    or exists (select 1 from media_credit c join artist on artist.id = c.artist_id
      where c.media_item_id = mi.id and c.role = 'artist' and artist.name ilike ${pattern})`
}

function playlistEntrySortExpression(key: PlaylistEntrySort): SQL {
  switch (key) {
    case 'position':
      return sql`pi.position`
    case 'title':
      return sql`lower(mi.title)`
    case 'artists':
      return playlistEntryArtistsSort
    case 'album':
      return sql`lower(coalesce(lt.album_name, am.title))`
    case 'duration':
      return sql`coalesce(lt.duration_sec, ${albumTrackDurationExpression(sql`lt.media_item_id`, sql`lt.album_media_item_id`)})`
    case 'added':
      return sql`pi.added_at`
    case 'releaseDate':
      return sql`coalesce(mi.release_date, am.release_date)`
    case 'scrobbles':
      return sql`lt.scrobble_count`
    case 'lastListened':
      return sql`lt.last_listened_at`
    case 'source':
      return sql`case when lt.media_item_id is not null then ${trackSourcesExpression(sql`mi.id`, sql`mi.metadata`, true)} end`
    case 'spotifyMatch':
      return sql`case when lt.media_item_id is not null then ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`mi.source_label`, true)} end`
    case 'kind':
      return sql`case when lt.media_item_id is null then 'album' else 'track' end`
  }
}

function playlistEntriesQuery(
  id: string,
  query: PlaylistDetailQuery,
  pattern: string,
  direction: SQL,
  albumIds: SQL | null,
) {
  const restrict = albumIds
    ? sql`and (a.media_item_id = any(${albumIds})
        or lt.album_media_item_id = any(${albumIds})
        or exists (select 1 from track t
          where t.track_media_item_id = lt.media_item_id
            and t.album_media_item_id = any(${albumIds})))`
    : sql``
  const kinds = query.kinds ?? (query.kind ? [query.kind] : [])
  const kindFilter =
    kinds.length === 1 && kinds.includes('track')
      ? sql`and lt.media_item_id is not null`
      : kinds.length === 1 && kinds.includes('album')
        ? sql`and lt.media_item_id is null and a.media_item_id is not null`
        : sql``
  const searchFilter = query.q
    ? sql`and (${playlistEntrySearch(pattern)} or coalesce(lt.album_name, am.title) ilike ${pattern})`
    : sql``
  const members = sql`from playlist_item pi
    join media_item mi on mi.id = pi.media_item_id
    left join library_track lt on lt.media_item_id = pi.media_item_id
    left join album a on a.media_item_id = pi.media_item_id
    left join media_item am on am.id = lt.album_media_item_id
    where pi.playlist_id = ${id}
      and (lt.media_item_id is not null or a.media_item_id is not null)
      ${kindFilter} ${searchFilter} ${restrict}`
  const sort = playlistEntrySortExpression(query.sortBy)
  const entryOrder =
    query.sortBy === 'position'
      ? sql`lt.media_item_id is null, ${sort} ${direction}`
      : sql`${sort} ${direction} nulls last`
  return {
    members,
    columns: sql`pi.media_item_id as id, pi.position,
      case when lt.media_item_id is null then 'album' else 'track' end as kind,
      ${isoTimestamp(sql`pi.added_at`)} as added_at`,
    order: sql`${entryOrder}, lt.media_item_id is null, pi.position, pi.media_item_id`,
  }
}

function groupedPlaylistAlbumSort(key: PlaylistEntrySort): SQL {
  switch (key) {
    case 'album':
    case 'title':
      return sql`lower(mi.title)`
    case 'artists':
      return playlistEntryArtistsSort
    case 'added':
      return sql`pi.added_at`
    case 'releaseDate':
      return sql`mi.release_date`
    default:
      return sql`pi.position`
  }
}

function groupedPlaylistAlbumsQuery(
  id: string,
  query: PlaylistDetailQuery,
  pattern: string,
  direction: SQL,
  albumIds: SQL | null,
) {
  const searchFilter = query.q
    ? sql`and (${playlistEntrySearch(pattern)})`
    : sql``
  const sort = groupedPlaylistAlbumSort(query.sortBy)
  const kinds = query.kinds ?? (query.kind ? [query.kind] : [])
  const includeAlbums = kinds.length === 0 || kinds.includes('album')
  const restrict = albumIds ? sql`and mi.id = any(${albumIds})` : sql``
  return {
    members: sql`from (
      select distinct on (album_id) album_id, position, added_at
      from playlist p
      cross join lateral (${playlistAlbumMembers}) members
      where p.id = ${id}
      order by album_id, position, added_at nulls last
    ) pi
    join media_item mi on mi.id = pi.album_id
    where ${includeAlbums} ${searchFilter} ${restrict}`,
    columns: sql`mi.id, pi.position, 'album' as kind,
      ${isoTimestamp(sql`pi.added_at`)} as added_at`,
    order: sql`${sort} ${direction} nulls last, pi.position, mi.id`,
  }
}

/**
 * One playlist with sync state and a page of entries. The default order is
 * tracks in playlist order, then legacy album entries. Album grouping lists
 * each library album once at its first playlist position. Coverage can limit
 * either view to entries associated with a specific set of library albums.
 */
export async function getPlaylistDetail(
  id: string,
  query: PlaylistDetailQuery,
  restrictToAlbumIds?: string[],
): Promise<PlaylistDetail> {
  const summary = await getPlaylistSummary(id)
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const albumIds = restrictToAlbumIds
    ? sql`${sql.param(restrictToAlbumIds)}::text[]`
    : null
  const { members, columns, order } =
    query.groupBy === 'album'
      ? groupedPlaylistAlbumsQuery(id, query, pattern, direction, albumIds)
      : playlistEntriesQuery(id, query, pattern, direction, albumIds)
  const [count] = CountRowsSchema.parse(
    (await db.execute(sql`select count(*) as count ${members}`)).rows,
  )
  const totalCount = count?.count ?? 0
  const entries = EntryRowsSchema.parse(
    (
      await db.execute(sql`
        select ${columns} ${members}
        order by ${order}
        limit ${query.size} offset ${(query.page - 1) * query.size}`)
    ).rows,
  )
  const tracks = new Map(
    (
      await loadTracks(
        entries.filter((row) => row.kind === 'track').map((row) => row.id),
      )
    ).map((item) => [item.id, item]),
  )
  const albums = await loadPlaylistAlbums(
    entries.filter((row) => row.kind === 'album').map((row) => row.id),
  )
  return PlaylistDetailSchema.parse({
    ...summary,
    items: {
      page: query.page,
      size: query.size,
      totalCount,
      pageCount: Math.ceil(totalCount / query.size),
      items: entries.flatMap((row): PlaylistEntry[] => {
        const base = { position: row.position, addedAt: row.added_at }
        if (row.kind === 'album') {
          const album = albums.get(row.id)
          return album ? [{ kind: 'album', ...base, album }] : []
        }
        const track = tracks.get(row.id)
        return track ? [{ kind: 'track', ...base, track }] : []
      }),
    },
  })
}

/** Sets a playlist's sync schedule and returns the playlist. */
export async function updatePlaylistSyncSchedule(
  id: string,
  schedule: PlaylistSyncSchedule,
  userId: string,
) {
  await setPlaylistSyncSchedule(id, schedule, userId)
  return getPlaylistSummary(id)
}

/**
 * Removes an imported playlist and tracks with no remaining source.
 * A playlist that also holds albums from the legacy library keeps those.
 */
export async function removeImportedPlaylist(id: string) {
  return db.transaction(async (tx) => {
    // The same lock as imports, which also delete tracks with no remaining source.
    await lockLibraryTrackWrites(tx)
    const [stored] = await tx
      .select({ source: playlist.source })
      .from(playlist)
      .where(eq(playlist.id, id))
      .for('update')
    if (!stored?.source)
      throw new ServerError({
        statusCode: 404,
        message: 'Imported playlist not found',
      })
    await tx.execute(sql`
      delete from playlist_item pi using library_track lt
      where pi.playlist_id = ${id} and lt.media_item_id = pi.media_item_id`)
    const kept = await tx.execute(
      sql`select 1 from playlist_item where playlist_id = ${id} limit 1`,
    )
    if (kept.rows.length)
      await tx
        .update(playlist)
        .set({
          source: null,
          spotifyId: null,
          ownerName: null,
          description: null,
          artworkUrl: null,
          spotifyUrl: null,
          snapshotId: null,
          importedAt: null,
        })
        .where(eq(playlist.id, id))
    else await tx.delete(playlist).where(eq(playlist.id, id))
    const removedTracks = await removeOrphanTracks(tx)
    await refreshTrackAddedDates(tx)
    return PlaylistRemovalSchema.parse({ removedTracks })
  })
}
