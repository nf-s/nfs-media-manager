import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { BrowseFacetQuery } from '@repo/schemas/browse'
import {
  PlaylistAlbumSchema,
  PlaylistDetailSchema,
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  TrackAlbumLinkStrategySchema,
  TrackDetailSchema,
  TrackListItemSchema,
  TrackScrobbleLinkStrategySchema,
  TrackSourceSchema,
  type PlaylistAlbum,
  type PlaylistDetail,
  type PlaylistDetailQuery,
  type PlaylistEntry,
  type PlaylistEntrySort,
  type PlaylistSummary,
  type PlaylistSyncSchedule,
  type TrackDetail,
  type TrackListItem,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import {
  linkedTrackFieldExpression,
  trackSourcesExpression,
} from './track-values'
import { playlist } from '@/schemas/db'
import { listBrowseFacets, queryBrowseIds } from './browse'
import { refreshTrackAddedDates, removeOrphanTracks } from './spotify-playlists'
import { latestSpotifyJobs } from './spotify-playlist-state'
import {
  playlistSync,
  setPlaylistSyncSchedule,
  storedGroupKey,
} from './spotify-playlist-sync'

const isoTimestamp = (column: SQL) =>
  sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const TrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artwork_url: z.string().nullable(),
    release_date: z.string().nullable(),
    artists: z.array(z.string()),
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
    album_track_id: z.string().nullable(),
    spotify_url: z.string().nullable(),
    isrc: z.string().nullable(),
    scrobble_count: z.number().int(),
    last_listened_at: z.string().nullable(),
  }),
)

async function loadTracks(ids: string[]): Promise<TrackListItem[]> {
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
          ${trackSourcesExpression(sql`mi.id`)} as sources,
          coalesce(lt.duration_sec, ${linkedTrackFieldExpression('duration_sec', sql`lt.album_media_item_id`, sql`mi.title`)}) as duration_sec,
          ${linkedTrackFieldExpression('external_id', sql`lt.album_media_item_id`, sql`mi.title`)} as album_track_id,
          ${isoTimestamp(sql`lt.date_added`)} as date_added,
          lt.spotify_track_id, lt.spotify_url, lt.isrc, lt.scrobble_count,
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
    const albumTrackId = SpotifyIdSchema.safeParse(row.album_track_id)
    const spotifyTrackId =
      row.spotify_track_id ?? (albumTrackId.success ? albumTrackId.data : null)
    return [
      TrackListItemSchema.parse({
        id: row.id,
        mediaType: 'track',
        title: row.title,
        artworkUrl: row.artwork_url,
        releaseDate: row.release_date,
        artists: row.artists,
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

export async function listTracks(query: TrackQuery) {
  const { ids, totalCount, pageCount } = await queryBrowseIds('track', query)
  return { items: await loadTracks(ids), totalCount, pageCount }
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
    artist_name: z.string(),
    track_name: z.string(),
    count: z.coerce.number(),
    strategy: TrackScrobbleLinkStrategySchema,
  }),
)
const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

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
        select max(s.artist_name) as artist_name,
          max(s.track_name) as track_name, count(*) as count,
          max(l.strategy) as strategy
        ${linked}
        group by l.artist_key, l.track_key
        order by count(*) desc, l.artist_key, l.track_key limit 50`)
    ).rows,
  )
  return TrackDetailSchema.parse({
    ...item,
    listening: {
      total: summary[0]?.total ?? 0,
      firstListenedAt: isoSeconds(summary[0]?.first ?? null),
      lastListenedAt: isoSeconds(summary[0]?.last ?? null),
      months,
      sources: sources.map((row) => ({
        artistName: row.artist_name,
        trackName: row.track_name,
        count: row.count,
        strategy: row.strategy,
      })),
    },
  })
}

const PlaylistRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    source: z.string().nullable(),
    spotify_id: z.string().nullable(),
    owner_name: z.string().nullable(),
    description: z.string().nullable(),
    artwork_url: z.string().nullable(),
    spotify_url: z.string().nullable(),
    imported_at: z.string().nullable(),
    created_at: z.string().nullable(),
    checked_at: z.string().nullable(),
    sync_schedule: z.string(),
    spotify_editable: z.boolean(),
    track_count: z.number().int(),
    linked_track_count: z.number().int(),
    album_count: z.number().int(),
    duration_sec: z.coerce.number().int(),
  }),
)

const optionalDate = (value: string | null) => (value ? new Date(value) : null)

/** Playlists that hold tracks or albums, by name; one playlist with `id`. */
async function loadPlaylists(id?: string): Promise<PlaylistSummary[]> {
  const rows = PlaylistRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, p.name, p.source, p.spotify_id, p.owner_name, p.description,
          p.artwork_url, p.spotify_url,
          ${isoTimestamp(sql`p.imported_at`)} as imported_at,
          ${isoTimestamp(sql`p.created_at`)} as created_at,
          ${isoTimestamp(sql`p.checked_at`)} as checked_at,
          p.sync_schedule, p.spotify_editable,
          coalesce(t.track_count, 0) as track_count,
          coalesce(t.linked_track_count, 0) as linked_track_count,
          coalesce(t.duration_sec, 0) as duration_sec,
          (select count(*)::int from (
            select pi.media_item_id from playlist_item pi
            join album a on a.media_item_id = pi.media_item_id
            where pi.playlist_id = p.id
            union
            select lt.album_media_item_id from playlist_item pi
            join library_track lt on lt.media_item_id = pi.media_item_id
            where pi.playlist_id = p.id and lt.album_media_item_id is not null
          ) albums) as album_count
        from playlist p
        left join (
          select pi.playlist_id, count(*)::int as track_count,
            count(lt.album_media_item_id)::int as linked_track_count,
            coalesce(sum(lt.duration_sec), 0)::int as duration_sec
          from playlist_item pi
          join library_track lt on lt.media_item_id = pi.media_item_id
          group by pi.playlist_id
        ) t on t.playlist_id = p.id
        where p.kind = 'playlist' ${id === undefined ? sql`` : sql`and p.id = ${id}`}
        order by lower(p.name), p.id`)
    ).rows,
  )
  const jobs = await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK)
  return rows
    .filter((row) => row.source !== null || row.album_count > 0)
    .map((row) => {
      const key = storedGroupKey({
        source: row.source,
        spotifyId: row.spotify_id,
      })
      return PlaylistSummarySchema.parse({
        id: row.id,
        name: row.name,
        source: row.source,
        ownerName: row.owner_name,
        description: row.description,
        artworkUrl: row.artwork_url,
        spotifyUrl: row.spotify_url,
        importedAt: row.imported_at,
        createdAt: row.created_at,
        trackCount: row.track_count,
        linkedTrackCount: row.linked_track_count,
        albumCount: row.album_count,
        durationSec: row.duration_sec,
        acceptsAdditions:
          row.source === 'spotify' &&
          row.spotify_id !== null &&
          row.spotify_editable,
        sync: playlistSync(
          {
            source: row.source,
            spotifyId: row.spotify_id,
            syncSchedule: row.sync_schedule,
            checkedAt: optionalDate(row.checked_at),
            importedAt: optionalDate(row.imported_at),
          },
          key ? (jobs.get(key)?.job ?? null) : null,
        ),
      })
    })
}

/** Playlists that hold tracks or albums, by name. */
export const listPlaylists = () => loadPlaylists()

async function getPlaylistSummary(id: string) {
  const [summary] = await loadPlaylists(id)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Playlist not found' })
  return summary
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

function playlistEntrySortExpression(key: PlaylistEntrySort): SQL {
  switch (key) {
    case 'position':
      return sql`pi.position`
    case 'title':
      return sql`lower(mi.title)`
    case 'artists':
      return sql`(select lower(string_agg(artist.name, ', ' order by c.billing_order, artist.name))
      from media_credit c join artist on artist.id = c.artist_id
      where c.media_item_id = mi.id and c.role = 'artist')`
    case 'album':
      return sql`lower(coalesce(lt.album_name, am.title))`
    case 'duration':
      return sql`coalesce(lt.duration_sec, ${linkedTrackFieldExpression('duration_sec', sql`lt.album_media_item_id`, sql`mi.title`)})`
    case 'added':
      return sql`pi.added_at`
    case 'releaseDate':
      return sql`coalesce(mi.release_date, am.release_date)`
    case 'scrobbles':
      return sql`lt.scrobble_count`
    case 'lastListened':
      return sql`lt.last_listened_at`
    case 'kind':
      return sql`case when lt.media_item_id is null then 'album' else 'track' end`
  }
}

/**
 * One playlist with its sync state and a page of its entries: tracks in
 * playlist order, then album members from the legacy import.
 */
export async function getPlaylistDetail(
  id: string,
  query: PlaylistDetailQuery,
): Promise<PlaylistDetail> {
  const summary = await getPlaylistSummary(id)
  const members = sql`from playlist_item pi
    join media_item mi on mi.id = pi.media_item_id
    left join library_track lt on lt.media_item_id = pi.media_item_id
    left join album a on a.media_item_id = pi.media_item_id
    left join media_item am on am.id = lt.album_media_item_id
    where pi.playlist_id = ${id}
      and (lt.media_item_id is not null or a.media_item_id is not null)`
  const [count] = CountRowsSchema.parse(
    (await db.execute(sql`select count(*) as count ${members}`)).rows,
  )
  const totalCount = count?.count ?? 0
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const sort = playlistEntrySortExpression(query.sortBy)
  const entryOrder =
    query.sortBy === 'position'
      ? sql`lt.media_item_id is null, ${sort} ${direction}`
      : sql`${sort} ${direction} nulls last`
  const entries = EntryRowsSchema.parse(
    (
      await db.execute(sql`
        select pi.media_item_id as id, pi.position,
          case when lt.media_item_id is null then 'album' else 'track' end as kind,
          ${isoTimestamp(sql`pi.added_at`)} as added_at
        ${members}
        order by ${entryOrder}, lt.media_item_id is null, pi.position, pi.media_item_id
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
    await tx.execute(sql`select pg_advisory_xact_lock(614105)`)
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
