import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import {
  artist,
  lastfmTrackSource,
  libraryTrack,
  mediaItem,
} from '@/schemas/db'
import { refreshTrackAddedDates, removeOrphanTracks } from './spotify-playlists'

const WRITE_BATCH = 500
const ScrobbledRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_names: z.array(z.string()),
    album_ids: z.array(z.string()),
    has_unlinked_album: z.boolean(),
  }),
)
const CandidateRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
  }),
)

/** Imports stored history only; uncertain recording identities remain separate. */
export async function importLastfmLibraryTracks(account: string) {
  await db.transaction(async (tx) => {
    // Share the playlist writer's lock so cleanup cannot remove new memberships.
    await tx.execute(sql`select pg_advisory_xact_lock(614105)`)
    const groups = ScrobbledRowsSchema.parse(
      (
        await tx.execute(sql`
      select artist_key, track_key, max(artist_name) as artist_name,
        max(track_name) as track_name,
        coalesce(array_agg(distinct album_name order by album_name)
          filter (where nullif(trim(album_name), '') is not null), '{}') as album_names,
        bool_or(nullif(trim(album_name), '') is not null and album_media_item_id is null) as has_unlinked_album,
        coalesce(array_agg(distinct album_media_item_id)
          filter (where album_media_item_id is not null), '{}') as album_ids
      from lastfm_scrobble where username = ${account}
      group by artist_key, track_key`)
      ).rows,
    )
    const candidates = CandidateRowsSchema.parse(
      (
        await tx.execute(sql`
      select lt.media_item_id as id, mi.title, lt.album_name,
        lt.album_media_item_id as album_id,
        coalesce((select array_agg(a.name) from media_credit c
          join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists
      from library_track lt join media_item mi on mi.id = lt.media_item_id
      where lt.spotify_track_id is not null`)
      ).rows,
    )
    const byName = new Map<string, typeof candidates>()
    const key = (artistName: string, title: string) =>
      JSON.stringify([albumNameKey(artistName), albumNameKey(title)])
    for (const candidate of candidates) {
      for (const name of new Set(candidate.artists.map(albumNameKey))) {
        const identity = key(name, candidate.title)
        byName.set(identity, [...(byName.get(identity) ?? []), candidate])
      }
    }
    const records = groups.map((group) => {
      const matches = (
        byName.get(key(group.artist_name, group.track_name)) ?? []
      ).filter(
        (candidate) =>
          group.album_names.length === 0 ||
          (!group.has_unlinked_album &&
            group.album_ids.length === 1 &&
            group.album_ids[0] === candidate.album_id) ||
          group.album_names.every(
            (name) =>
              candidate.album_name !== null &&
              albumNameKey(name) === albumNameKey(candidate.album_name),
          ),
      )
      const matched = matches.length === 1 ? matches[0] : undefined
      return {
        group,
        albumId:
          !group.has_unlinked_album && group.album_ids.length === 1
            ? group.album_ids[0]
            : null,
        matched: matched !== undefined,
        id:
          matched?.id ??
          createStableId(
            'library-track',
            JSON.stringify([
              'lastfm',
              account,
              group.artist_key,
              group.track_key,
            ]),
          ),
      }
    })
    for (let start = 0; start < records.length; start += WRITE_BATCH) {
      const batch = records.slice(start, start + WRITE_BATCH)
      const standalone = batch.filter((record) => !record.matched)
      if (standalone.length) {
        const items: Array<typeof mediaItem.$inferInsert> = standalone.map(
          ({ id, group }) => ({
            id,
            mediaType: 'track',
            slug: slugifyParts(group.track_name, id),
            title: group.track_name,
            sourceLabel: 'lastfm',
          }),
        )
        await tx
          .insert(mediaItem)
          .values(items)
          .onConflictDoUpdate({
            target: mediaItem.id,
            set: { title: sql`excluded.title` },
          })
        await tx
          .insert(libraryTrack)
          .values(
            standalone.map(({ id, group, albumId }) => ({
              mediaItemId: id,
              albumName:
                group.album_names.length === 1 ? group.album_names[0] : null,
              albumMediaItemId: albumId,
              albumLinkStrategy: albumId ? 'lastfm' : null,
            })),
          )
          .onConflictDoUpdate({
            target: libraryTrack.mediaItemId,
            set: {
              albumName: sql`excluded.album_name`,
              albumMediaItemId: sql`excluded.album_media_item_id`,
              albumLinkStrategy: sql`excluded.album_link_strategy`,
            },
          })
        const artists = new Map(
          standalone.map(({ group }) => [
            createStableId('artist', group.artist_name.toLowerCase()),
            group.artist_name,
          ]),
        )
        await tx
          .insert(artist)
          .values(
            [...artists].map(([id, name]) => ({ id, name, sortName: name })),
          )
          .onConflictDoNothing()
        await tx.execute(
          sql`delete from media_credit where role = 'artist' and media_item_id in (${sql.join(
            standalone.map(({ id }) => sql`${id}`),
            sql`, `,
          )})`,
        )
        // Legacy imports can have another artist ID for the same unique name.
        await tx.execute(sql`insert into media_credit (media_item_id, artist_id, role, billing_order)
          select r.id, a.id, 'artist', 0
          from jsonb_to_recordset(${JSON.stringify(
            standalone.map(({ id, group }) => ({
              id,
              artist_id: createStableId(
                'artist',
                group.artist_name.toLowerCase(),
              ),
              artist_name: group.artist_name,
            })),
          )}::jsonb) as r(id text, artist_id text, artist_name text)
          join lateral (select id from artist where id = r.artist_id or name = r.artist_name
            order by case when name = r.artist_name then 0 else 1 end limit 1) a on true
          on conflict do nothing`)
      }
      await tx
        .insert(lastfmTrackSource)
        .values(
          batch.map(({ id, group }) => ({
            username: account,
            artistKey: group.artist_key,
            trackKey: group.track_key,
            trackMediaItemId: id,
          })),
        )
        .onConflictDoUpdate({
          target: [
            lastfmTrackSource.username,
            lastfmTrackSource.artistKey,
            lastfmTrackSource.trackKey,
          ],
          set: { trackMediaItemId: sql`excluded.track_media_item_id` },
        })
    }
    await tx.execute(sql`delete from lastfm_track_source l where l.username = ${account}
      and not exists (select 1 from lastfm_scrobble s where s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key)`)
    await removeOrphanTracks(tx)
    await refreshTrackAddedDates(tx)
  })
}
