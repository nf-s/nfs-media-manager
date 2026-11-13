import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAlbumMatcher } from '@/lib/lastfm-album-matching'

const INSERT_BATCH = 1000

const AlbumRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    tracks: z.array(z.string()),
  }),
)
const GroupRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    album_key: z.string(),
    artist_name: z.string(),
    album_name: z.string(),
    tracks: z.array(z.string()),
  }),
)

type Executor = Pick<typeof db, 'execute'>

/** Copies the link table onto the account's scrobbles. */
async function applyAlbumLinks(database: Executor, account: string) {
  await database.execute(sql`
    update lastfm_scrobble s set album_media_item_id = l.album_media_item_id
    from lastfm_album_link l
    where s.username = ${account} and l.username = s.username
      and l.artist_key = s.artist_key and l.album_key = s.album_key
      and s.album_media_item_id is distinct from l.album_media_item_id`)
  await database.execute(sql`
    update lastfm_scrobble s set album_media_item_id = null
    where s.username = ${account} and s.album_media_item_id is not null
      and not exists (
        select 1 from lastfm_album_link l
        where l.username = s.username and l.artist_key = s.artist_key
          and l.album_key = s.album_key)`)
}

/**
 * Recomputes every automatic link for the account from the library's titles,
 * credited artists and track titles. Manual links and exclusions are kept.
 */
export async function linkScrobblesToAlbums(account: string) {
  const albums = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title,
          coalesce((
            select array_agg(a.name order by c.billing_order)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          coalesce((
            select array_agg(t.title) from track t
            where t.album_media_item_id = mi.id), '{}') as tracks
        from media_item mi where mi.media_type = 'album'`)
    ).rows,
  )
  const groups = GroupRowsSchema.parse(
    (
      await db.execute(sql`
        select s.artist_key, s.album_key, max(s.artist_name) as artist_name,
          max(s.album_name) as album_name,
          array_agg(distinct s.track_key) as tracks
        from lastfm_scrobble s
        where s.username = ${account} and s.album_key is not null
          and not exists (
            select 1 from lastfm_album_link l
            where l.username = s.username and l.artist_key = s.artist_key
              and l.album_key = s.album_key and l.source = 'manual')
        group by s.artist_key, s.album_key`)
    ).rows,
  )
  const match = createAlbumMatcher(albums)
  const rows = groups.flatMap((group) => {
    const result = match({
      artistName: group.artist_name,
      albumName: group.album_name,
      tracks: group.tracks,
    })
    if (result.albumId === null && !result.candidates.length) return []
    return [
      {
        artist_key: group.artist_key,
        album_key: group.album_key,
        album_id: result.albumId,
        strategy: result.albumId === null ? null : result.strategy,
        candidates: result.albumId === null ? result.candidates : [],
      },
    ]
  })
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from lastfm_album_link
      where username = ${account} and source = 'auto'`)
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      // An album deleted since it was read is skipped, not a failed relink.
      await tx.execute(sql`
        insert into lastfm_album_link (username, artist_key, album_key,
          album_media_item_id, source, strategy, candidate_ids)
        select ${account}, r.artist_key, r.album_key, r.album_id, 'auto',
          r.strategy, r.candidates
        from jsonb_to_recordset(${JSON.stringify(
          rows.slice(start, start + INSERT_BATCH),
        )}::jsonb) as r(artist_key text, album_key text, album_id text,
          strategy text, candidates jsonb)
        where r.album_id is null or exists (
          select 1 from album a where a.media_item_id = r.album_id)
        on conflict do nothing`)
    }
    await applyAlbumLinks(tx, account)
  })
}
