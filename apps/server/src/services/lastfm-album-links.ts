import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAlbumMatcher } from '@/lib/lastfm-album-matching'
import { lockLibraryTrackWrites } from './album-library-tracks'

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
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A scrobbled artist and album name of one Last.fm account. */
export type AlbumNameKey = { artistKey: string; albumKey: string }

const keysInput = (keys: AlbumNameKey[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    keys.map(({ artistKey, albumKey }) => ({ artistKey, albumKey })),
  )}::jsonb) as k("artistKey" text, "albumKey" text)`

/** Only rows of the given names, as a condition on `alias`. */
function keysFilter(alias: string, keys?: AlbumNameKey[]): SQL {
  if (!keys) return sql``
  const table = sql.identifier(alias)
  return sql`and exists (select 1 from ${keysInput(keys)}
    where k."artistKey" = ${table}.artist_key
      and k."albumKey" = ${table}.album_key)`
}

/** Copies the link table onto the account's scrobbles, or those of some names. */
export async function applyAlbumLinks(
  database: Executor,
  account: string,
  keys?: AlbumNameKey[],
) {
  if (keys?.length === 0) return
  await database.execute(sql`
    update lastfm_scrobble s set album_media_item_id = l.album_media_item_id
    from lastfm_album_link l
    where s.username = ${account} and l.username = s.username
      and l.artist_key = s.artist_key and l.album_key = s.album_key
      and s.album_media_item_id is distinct from l.album_media_item_id
      ${keysFilter('s', keys)}`)
  await database.execute(sql`
    update lastfm_scrobble s set album_media_item_id = null
    where s.username = ${account} and s.album_media_item_id is not null
      ${keysFilter('s', keys)}
      and not exists (
        select 1 from lastfm_album_link l
        where l.username = s.username and l.artist_key = s.artist_key
          and l.album_key = s.album_key)`)
}

/**
 * Recomputes the automatic links of the account, or of some names, from the
 * library's titles, credited artists and track titles, and copies them onto
 * the scrobbles. Manual links and exclusions are kept. Call it under the
 * library writer lock.
 */
export async function writeAlbumLinks(
  tx: Transaction,
  account: string,
  keys?: AlbumNameKey[],
) {
  if (keys?.length === 0) return
  const albums = AlbumRowsSchema.parse(
    (
      await tx.execute(sql`
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
      await tx.execute(sql`
        select s.artist_key, s.album_key, max(s.artist_name) as artist_name,
          max(s.album_name) as album_name,
          array_agg(distinct s.track_key) as tracks
        from lastfm_scrobble s
        where s.username = ${account} and s.album_key is not null
          ${keysFilter('s', keys)}
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
  await tx.execute(sql`
    delete from lastfm_album_link l
    where l.username = ${account} and l.source = 'auto' ${keysFilter('l', keys)}`)
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
  await applyAlbumLinks(tx, account, keys)
}

/**
 * Recomputes every automatic link for the account from the library's titles,
 * credited artists and track titles. Manual links and exclusions are kept.
 */
export async function linkScrobblesToAlbums(account: string) {
  await db.transaction(async (tx) => {
    // A relink must not overwrite an album name moved since it read the links.
    await lockLibraryTrackWrites(tx)
    await writeAlbumLinks(tx, account)
  })
}

/**
 * Recomputes the scrobble-derived album browse values, including the rolling
 * windows, for every album or for the given albums and the records they
 * belong to. A first album counts the scrobbles of all its editions; an
 * edition counts its own.
 */
export async function refreshAlbumListening(
  database: Executor,
  albumIds?: string[],
) {
  if (albumIds?.length === 0) return
  const scope = albumIds
    ? sql`in (
        select a.media_item_id from album a
        where a.media_item_id in (${idList(albumIds)})
        union select a.edition_of_id from album a
        where a.media_item_id in (${idList(albumIds)})
          and a.edition_of_id is not null)`
    : null
  // Each scrobble counts for its album and for that album's first album.
  const counted = sql`
    select s.album_media_item_id as id, s.listened_at
    from lastfm_scrobble s where s.album_media_item_id is not null
      ${scope ? sql`and s.album_media_item_id ${scope}` : sql``}
    union all
    select a.edition_of_id as id, s.listened_at
    from album a join lastfm_scrobble s on s.album_media_item_id = a.media_item_id
    where a.edition_of_id is not null
      ${scope ? sql`and a.edition_of_id ${scope}` : sql``}`
  await database.execute(sql`
    update media_item m set metadata = jsonb_set(
      coalesce(m.metadata, '{}'::jsonb), '{browse}',
      coalesce(m.metadata->'browse', '{}'::jsonb) || s.stats)
    from (
      select c.id, jsonb_build_object(
        'scrobbles', count(*),
        'lastListenedAt', floor(extract(epoch from max(c.listened_at)) * 1000),
        'scrobblesLast1y', count(*) filter (where c.listened_at >= (now() at time zone 'utc') - interval '1 year'),
        'scrobblesLast5y', count(*) filter (where c.listened_at >= (now() at time zone 'utc') - interval '5 years')
      ) as stats
      from (${counted}) c
      group by c.id
    ) s
    where m.id = s.id
      and not (coalesce(m.metadata->'browse', '{}'::jsonb) @> s.stats)`)
  await database.execute(sql`
    update media_item m set metadata = jsonb_set(
      m.metadata, '{browse}',
      (m.metadata->'browse') - 'lastListenedAt' - 'scrobblesLast1y' - 'scrobblesLast5y')
    where m.media_type = 'album'
      ${scope ? sql`and m.id ${scope}` : sql``}
      and m.metadata->'browse' ? 'lastListenedAt'
      and not exists (
        select 1 from lastfm_scrobble s where s.album_media_item_id = m.id)
      and not exists (
        select 1 from album a join lastfm_scrobble s
          on s.album_media_item_id = a.media_item_id
        where a.edition_of_id = m.id)`)
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
