import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import { db } from '@/lib/db'
import { artistScrobbles, scopedArtists } from '../artist-browse'
import { anyId, type JsonObject } from './projection'

/**
 * Play times for listening rules, sorts and histograms on the device: each
 * scrobbled name of a published track, each published album and each
 * published artist with a scrobble. Times are whole epoch seconds.
 */

export type PlaysEntity = 'scrobble_name' | 'album_plays' | 'artist_plays'

/**
 * The `scrobble_name` ID of a listener, artist key and track key: the
 * function the feed's triggers mark names with (migration 0079).
 */
export function scrobbleNameId(
  username: SQL,
  artistKey: SQL,
  trackKey: SQL,
): SQL {
  return sql`device_scrobble_name_id(${username}, ${artistKey}, ${trackKey})`
}

const defaultScope: CatalogScopeQuery = {}

const publishedTrackLinks = sql`lastfm_track_link l
  join media_item m on m.id = l.track_media_item_id and m.media_type = 'track' and m.in_library
  join library_track lt on lt.media_item_id = m.id`

const linkedNames = sql`select distinct l.username, l.artist_key, l.track_key,
    ${scrobbleNameId(sql`l.username`, sql`l.artist_key`, sql`l.track_key`)} as id
  from ${publishedTrackLinks}`

const publishedAlbums = sql`select m.id from media_item m
  join album a on a.media_item_id = m.id
  where m.media_type = 'album' and m.in_library
    and exists (select 1 from lastfm_scrobble s where s.album_media_item_id = m.id)`

const publishedArtists = sql`select a.id from artist a
  where ${scopedArtists(defaultScope)} and exists (
    select 1 from (${artistScrobbles(sql`c.artist_id = a.id`)}) plays)`

const publishedIds: Record<PlaysEntity, SQL> = {
  scrobble_name: sql`select id from (${linkedNames}) names`,
  album_plays: publishedAlbums,
  artist_plays: publishedArtists,
}

const IdRowsSchema = z.array(z.object({ id: z.string() }))

export async function listPlaysIds(
  entity: PlaysEntity,
  afterId: string | null,
  limit: number,
) {
  const result =
    await db.execute(sql`select id from (${publishedIds[entity]}) published
    ${afterId === null ? sql`` : sql`where id collate "C" > ${afterId}`}
    order by id collate "C" limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

const epochSeconds = sql`extract(epoch from listened_at)`

function playRows(entity: PlaysEntity, ids: SQL): SQL {
  if (entity === 'scrobble_name')
    return sql`select n.id, coalesce((
        select jsonb_agg(${epochSeconds} order by listened_at) from lastfm_scrobble s
        where s.username = n.username and s.artist_key = n.artist_key and s.track_key = n.track_key
      ), '[]'::jsonb) as plays
      from (${linkedNames}) n where n.id = ${ids}`
  if (entity === 'album_plays')
    return sql`select s.album_media_item_id as id,
        jsonb_agg(${epochSeconds} order by listened_at) as plays
      from lastfm_scrobble s
      where s.album_media_item_id = ${ids}
        and s.album_media_item_id in (${publishedAlbums})
      group by s.album_media_item_id`
  return sql`select artist_id as id, jsonb_agg(${epochSeconds} order by listened_at) as plays
    from (${artistScrobbles(sql`c.artist_id = ${ids}`)}) plays
    where artist_id in (select a.id from artist a where a.id = ${ids} and ${scopedArtists(defaultScope)})
    group by artist_id`
}

const PlayRowsSchema = z.array(
  z.object({ id: z.string(), plays: z.array(z.number()) }),
)

export async function renderPlays(
  entity: PlaysEntity,
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const result = await db.execute(playRows(entity, anyId(ids)))
  const payloads = new Map<string, JsonObject>()
  for (const { id, plays } of PlayRowsSchema.parse(result.rows)) {
    // Last.fm reports whole seconds; a fraction means the data changed.
    if (plays.some((play) => !Number.isInteger(play)))
      throw new Error(`A play time of ${entity} ${id} is not a whole second`)
    payloads.set(id, { plays })
  }
  return payloads
}
