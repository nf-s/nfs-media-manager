import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { BrowseFacetQuery } from '@repo/schemas/browse'
import {
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
  TrackAlbumLinkStrategySchema,
  TrackDetailSchema,
  TrackListItemSchema,
  TrackScrobbleLinkStrategySchema,
  type PlaylistSummary,
  type TrackDetail,
  type TrackListItem,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { playlist } from '@/schemas/db'
import { listBrowseFacets, queryBrowseIds } from './browse'
import { refreshTrackAddedDates, removeOrphanTracks } from './spotify-playlists'

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
    duration_sec: z.number().int().nullable(),
    date_added: z.string().nullable(),
    spotify_track_id: z.string(),
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
        select mi.id, mi.title, mi.artwork_url,
          ${isoTimestamp(sql`mi.release_date`)} as release_date,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          lt.album_name, lt.album_media_item_id as album_id,
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
          lt.duration_sec, ${isoTimestamp(sql`lt.date_added`)} as date_added,
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
        durationSec: row.duration_sec,
        dateAdded: row.date_added,
        spotifyTrackId: row.spotify_track_id,
        spotifyUrl: row.spotify_url,
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
    owner_name: z.string().nullable(),
    description: z.string().nullable(),
    artwork_url: z.string().nullable(),
    spotify_url: z.string().nullable(),
    imported_at: z.string().nullable(),
    track_count: z.number().int(),
    linked_track_count: z.number().int(),
    album_count: z.number().int(),
    duration_sec: z.coerce.number().int(),
  }),
)

/** Playlists that hold tracks or albums, by name. */
export async function listPlaylists(): Promise<PlaylistSummary[]> {
  const rows = PlaylistRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, p.name, p.source, p.owner_name, p.description,
          p.artwork_url, p.spotify_url,
          ${isoTimestamp(sql`p.imported_at`)} as imported_at,
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
        where p.kind = 'playlist'
        order by lower(p.name), p.id`)
    ).rows,
  )
  return rows
    .filter((row) => row.source !== null || row.album_count > 0)
    .map((row) =>
      PlaylistSummarySchema.parse({
        id: row.id,
        name: row.name,
        source: row.source,
        ownerName: row.owner_name,
        description: row.description,
        artworkUrl: row.artwork_url,
        spotifyUrl: row.spotify_url,
        importedAt: row.imported_at,
        trackCount: row.track_count,
        linkedTrackCount: row.linked_track_count,
        albumCount: row.album_count,
        durationSec: row.duration_sec,
      }),
    )
}

/**
 * Removes an imported playlist and the tracks that are in no other playlist.
 * A playlist that also holds albums from the legacy library keeps those.
 */
export async function removeImportedPlaylist(id: string) {
  return db.transaction(async (tx) => {
    // The same lock as an import, which also deletes tracks left in no playlist.
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
