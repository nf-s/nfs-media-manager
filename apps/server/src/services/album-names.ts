import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  AlbumMergeFollow,
  AlbumMergeUnmatched,
  AlbumNameRef,
} from '@repo/schemas/album-merges'
import type { LastfmLinkUpdate } from '@repo/schemas/lastfm'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createAlbumTrackAliasMatcher } from '@/lib/album-track-aliases'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  albumNameEffect,
  captureAlbumNames,
  capturedAlbumIds,
  readAlbumListening,
  refreshAlbumNames,
  type AlbumNameRejection,
} from './album-merge-effects'
import {
  applyAlbumLinks,
  writeAlbumLinks,
  type AlbumNameKey,
} from './lastfm-album-links'
import type {
  ChangeEffectEntry,
  ChangeReader,
  ChangeTransaction,
} from './library-change-effect'
import {
  beginTrackChange,
  readChangeRecords,
  recordChange,
  type TrackChangeDraft,
} from './library-changes'
import { refreshTrackAddedDates } from './spotify-playlists'
import { removeEmptyTracks } from './track-archive'

const NO_SCROBBLES = 'No scrobbles have this artist and album name.'

const unique = (ids: (string | null)[]) => [
  ...new Set(ids.flatMap((id) => (id === null ? [] : [id]))),
]
const nameId = (key: AlbumNameKey) =>
  JSON.stringify([key.artistKey, key.albumKey])
const keysInput = (keys: AlbumNameKey[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    keys.map(({ artistKey, albumKey }) => ({ artistKey, albumKey })),
  )}::jsonb) as k("artistKey" text, "albumKey" text)`

/** The keys a scrobbled artist and album name is stored under. */
export const albumNameKeys = (name: AlbumNameRef): AlbumNameKey => ({
  artistKey: albumNameKey(name.artistName),
  albumKey: albumNameKey(name.albumName),
})

const NameRowsSchema = z.array(
  z.object({
    artistKey: z.string(),
    albumKey: z.string(),
    artistName: z.string(),
    albumName: z.string(),
    scrobbles: z.number().int().nonnegative(),
    albumId: z.string().nullable(),
  }),
)
/** A scrobbled album name of the account, with the album it is linked to. */
export type AlbumNameState = z.infer<typeof NameRowsSchema>[number]

/**
 * The given scrobbled album names of the account, in the given order, with
 * their scrobbles and linked album. A name without scrobbles is not found.
 */
export async function readAlbumNames(
  reader: ChangeReader,
  account: string,
  names: AlbumNameRef[],
): Promise<AlbumNameState[]> {
  if (!names.length) return []
  const keys = names.map(albumNameKeys)
  const rows = new Map(
    NameRowsSchema.parse(
      (
        await reader.execute(sql`
          select s.artist_key as "artistKey", s.album_key as "albumKey",
            max(s.artist_name) as "artistName", max(s.album_name) as "albumName",
            count(*)::int as scrobbles,
            (select l.album_media_item_id from lastfm_album_link l
              where l.username = s.username and l.artist_key = s.artist_key
                and l.album_key = s.album_key) as "albumId"
          from lastfm_scrobble s join ${keysInput(keys)}
            on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
          where s.username = ${account}
          group by s.username, s.artist_key, s.album_key`)
      ).rows,
    ).map((row) => [nameId(row), row]),
  )
  return [...new Set(keys.map(nameId))].map((id) => {
    const row = rows.get(id)
    if (!row) throw new ServerError({ statusCode: 404, message: NO_SCROBBLES })
    return row
  })
}

const FollowRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    scrobbles: z.number().int().nonnegative(),
    owner_id: z.string(),
    manual: z.boolean(),
    owner_albums: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
)
const RecordingRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    positions: z.array(
      z.object({
        albumId: z.string(),
        title: z.string(),
        position: z.number().int(),
      }),
    ),
  }),
)

/** A track name that follows its album name, with its stored keys. */
export type FollowedName = AlbumMergeFollow & {
  artistKey: string
  trackKey: string
}

/** What following the album names onto an album's tracks would move. */
export type FollowPlan = {
  also: FollowedName[]
  unmatched: AlbumMergeUnmatched[]
  /** Followed names now on a track of an album outside the record. */
  elsewhere: { artistName: string; trackName: string; albumTitle: string }[]
}

/**
 * The track names scrobbled under the album names, matched to the album's
 * track list with the album track alias matcher. A name already on its
 * matching track neither follows nor stays. `recordIds` are the albums of
 * the record once the change is made.
 */
export async function readFollowPlan(
  reader: ChangeReader,
  account: string,
  keys: AlbumNameKey[],
  albumId: string,
  recordIds: string[],
): Promise<FollowPlan> {
  if (!keys.length) return { also: [], unmatched: [], elsewhere: [] }
  const names = FollowRowsSchema.parse(
    (
      await reader.execute(sql`
        with named as (
          select distinct s.artist_key, s.track_key
          from lastfm_scrobble s join ${keysInput(keys)}
            on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
          where s.username = ${account})
        select n.artist_key, n.track_key, max(e.artist_name) as artist_name,
          max(e.track_name) as track_name, count(*)::int as scrobbles,
          o.track_media_item_id as owner_id, o.manually_matched as manual,
          coalesce((
            select jsonb_agg(distinct jsonb_build_object('id', t.album_media_item_id,
              'title', am.title))
            from track t join media_item am on am.id = t.album_media_item_id
            where t.track_media_item_id = o.track_media_item_id), '[]'::jsonb)
            as owner_albums
        from named n
        join lastfm_track_source o on o.username = ${account}
          and o.artist_key = n.artist_key and o.track_key = n.track_key
        join lastfm_scrobble e on e.username = o.username
          and e.artist_key = n.artist_key and e.track_key = n.track_key
        group by n.artist_key, n.track_key, o.track_media_item_id,
          o.manually_matched
        order by count(*) desc, max(e.track_name), max(e.artist_name)`)
    ).rows,
  )
  const recordings = RecordingRowsSchema.parse(
    (
      await reader.execute(sql`
        select lt.media_item_id as id, mi.title,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = lt.media_item_id and c.role = 'artist'),
            '{}') as artists,
          jsonb_agg(jsonb_build_object('albumId', t.album_media_item_id,
            'title', t.title, 'position', t.position)) as positions
        from track t
        join library_track lt on lt.media_item_id = t.track_media_item_id
        join media_item mi on mi.id = lt.media_item_id
        where t.album_media_item_id = ${albumId}
        group by lt.media_item_id, mi.title`)
    ).rows,
  )
  const scrobbled = names.map((name) => ({
    artist_key: name.artist_key,
    track_key: name.track_key,
    album_ids: [albumId],
    has_unlinked_album: false,
  }))
  const match = createAlbumTrackAliasMatcher(
    recordings,
    scrobbled,
    new Map(
      names
        .filter((name) => name.manual)
        .map((name) => [JSON.stringify([name.artist_key, name.track_key]), '']),
    ),
  )
  const record = new Set(recordIds)
  const plan: FollowPlan = { also: [], unmatched: [], elsewhere: [] }
  names.forEach((name, index) => {
    const scrobbledName = scrobbled[index]
    const target = scrobbledName ? match(scrobbledName) : undefined
    const shown = {
      artistName: name.artist_name,
      trackName: name.track_name,
      scrobbles: name.scrobbles,
    }
    if (!target) {
      plan.unmatched.push({ ...shown, trackId: name.owner_id })
      return
    }
    if (target.id === name.owner_id) return
    plan.also.push({
      ...shown,
      artistKey: name.artist_key,
      trackKey: name.track_key,
      fromTrackId: name.owner_id,
      toTrackId: target.id,
      toTitle: target.title,
    })
    const other = name.owner_albums.find((album) => !record.has(album.id))
    if (other)
      plan.elsewhere.push({
        artistName: name.artist_name,
        trackName: name.track_name,
        albumTitle: other.title,
      })
  })
  return plan
}

export type AlbumNameMove = {
  draft: TrackChangeDraft
  effects: ChangeEffectEntry[]
  /** Album names linked to another album than before. */
  albumNames: number
  /** Track names that followed. */
  titles: number
}

/**
 * Links the album names to the album by hand, points their scrobbles at it
 * and moves the track names that follow. Call it under the library writer
 * lock, then record the change with the returned draft and effects.
 */
export async function moveAlbumNames(
  tx: ChangeTransaction,
  account: string,
  names: AlbumNameState[],
  albumId: string,
  follow: FollowPlan | null,
): Promise<AlbumNameMove> {
  const keys = names.map(({ artistKey, albumKey }) => ({ artistKey, albumKey }))
  const captured = await captureAlbumNames(tx, account, keys)
  const albumIds = unique([...capturedAlbumIds(captured), albumId])
  const listening = await readAlbumListening(tx, albumIds)
  const also = follow?.also ?? []
  const draft = await beginTrackChange(tx, {
    names: also.map((name) => ({
      username: account,
      artist_key: name.artistKey,
      track_key: name.trackKey,
    })),
  })
  if (keys.length) {
    await tx.execute(sql`
      insert into lastfm_album_link (username, artist_key, album_key,
        album_media_item_id, source, strategy, candidate_ids)
      select ${account}, k."artistKey", k."albumKey", ${albumId}, 'manual',
        null, '[]'::jsonb
      from ${keysInput(keys)}
      on conflict (username, artist_key, album_key) do update set
        album_media_item_id = excluded.album_media_item_id, source = 'manual',
        strategy = null, candidate_ids = '[]'::jsonb, updated_at = now()`)
    await applyAlbumLinks(tx, account, keys)
  }
  if (also.length)
    await tx.execute(sql`
      update lastfm_track_source s
      set track_media_item_id = r."toTrackId", manually_matched = true
      from jsonb_to_recordset(${JSON.stringify(
        also.map(({ artistKey, trackKey, toTrackId }) => ({
          artistKey,
          trackKey,
          toTrackId,
        })),
      )}::jsonb) as r("artistKey" text, "trackKey" text, "toTrackId" text)
      where s.username = ${account} and s.artist_key = r."artistKey"
        and s.track_key = r."trackKey"`)
  const effect = await albumNameEffect(tx, captured, { listening })
  await refreshAlbumNames(tx, account, captured.trackKeys, albumIds)
  const fromIds = unique(also.map((name) => name.fromTrackId))
  await removeEmptyTracks(tx, fromIds)
  if (also.length)
    await refreshTrackAddedDates(
      tx,
      unique([...fromIds, ...also.map((name) => name.toTrackId)]),
    )
  return {
    draft,
    effects: effect ? [effect] : [],
    albumNames: names.filter((name) => name.albumId !== albumId).length,
    titles: also.length,
  }
}

const AlbumRowsSchema = z.array(z.object({ id: z.string() }))

async function requireAlbum(reader: ChangeReader, albumId: string) {
  const [found] = AlbumRowsSchema.parse(
    (
      await reader.execute(sql`
        select media_item_id as id from album where media_item_id = ${albumId}`)
    ).rows,
  )
  if (!found)
    throw new ServerError({ statusCode: 404, message: 'Album not found' })
}

const RejectionRowsSchema = z.array(z.object({ id: z.string() }))

/**
 * Links one scrobbled artist and album name to an album, keeps it unlinked,
 * or returns it to automatic matching, and records the change. Track names
 * do not follow. Returns the change's ID, or null when nothing changed.
 */
export async function changeAlbumNameLink(
  account: string,
  input: LastfmLinkUpdate,
  userId: string | null,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const [name] = await readAlbumNames(tx, account, [input])
    if (!name) throw new ServerError({ statusCode: 404, message: NO_SCROBBLES })
    const key = { artistKey: name.artistKey, albumKey: name.albumKey }
    const label = { labels: [name.albumName] }
    if (input.action === 'link') {
      await requireAlbum(tx, input.albumId)
      const moved = await moveAlbumNames(
        tx,
        account,
        [name],
        input.albumId,
        null,
      )
      const [target] = await readChangeRecords(tx, 'album', [input.albumId])
      return recordChange(
        tx,
        {
          kind: 'album',
          action: 'move',
          target: target ?? null,
          sources: await readChangeRecords(
            tx,
            'album',
            unique([name.albumId]).filter((id) => id !== input.albumId),
          ),
          details: { counts: { 'album-name': 1 }, ...label },
        },
        { draft: moved.draft, effects: moved.effects },
      )
    }

    const captured = await captureAlbumNames(tx, account, [key])
    const previous = captured.before.get(nameId(key)) ?? null
    const rejections: AlbumNameRejection[] = []
    if (input.action === 'unlink') {
      if (
        input.expectedAlbumId &&
        previous?.albumId !== input.expectedAlbumId
      ) {
        if (previous?.source === 'manual' && previous.albumId === null) {
          const recorded = RejectionRowsSchema.parse(
            (
              await tx.execute(sql`
                select id from media_override
                where media_item_id = ${input.expectedAlbumId}
                  and field = 'albumListeningLinkRejection'
                  and value->>'artistKey' = ${key.artistKey}
                  and value->>'albumKey' = ${key.albumKey}
                limit 1`)
            ).rows,
          )
          if (recorded.length) return null
        }
        throw new ServerError({
          statusCode: 409,
          message:
            'The listening group is no longer linked to the reviewed album.',
        })
      }
      if (previous?.albumId)
        rejections.push({
          id: randomUUID(),
          mediaItemId: previous.albumId,
          value: {
            artistKey: key.artistKey,
            albumKey: key.albumKey,
            artistName: input.artistName,
            albumName: input.albumName,
          },
          note: `${input.artistName} – ${input.albumName}`,
          createdByUserId: userId,
        })
      for (const rejection of rejections)
        await tx.execute(sql`
          insert into media_override (id, media_item_id, field, value, note,
            created_by_user_id)
          values (${rejection.id}, ${rejection.mediaItemId},
            'albumListeningLinkRejection',
            ${JSON.stringify(rejection.value)}::jsonb, ${rejection.note},
            ${rejection.createdByUserId})`)
      await tx.execute(sql`
        insert into lastfm_album_link (username, artist_key, album_key,
          album_media_item_id, source, strategy, candidate_ids)
        values (${account}, ${key.artistKey}, ${key.albumKey}, null, 'manual',
          null, '[]'::jsonb)
        on conflict (username, artist_key, album_key) do update set
          album_media_item_id = null, source = 'manual', strategy = null,
          candidate_ids = '[]'::jsonb, updated_at = now()`)
      await applyAlbumLinks(tx, account, [key])
    } else {
      await tx.execute(sql`
        delete from lastfm_album_link
        where username = ${account} and artist_key = ${key.artistKey}
          and album_key = ${key.albumKey}`)
      await writeAlbumLinks(tx, account, [key])
    }
    const [now] = await readAlbumNames(tx, account, [input])
    const albumIds = unique([
      ...capturedAlbumIds(captured),
      now?.albumId ?? null,
    ])
    const effect = await albumNameEffect(tx, captured, {
      listening: await readAlbumListening(tx, albumIds),
      rejections,
    })
    await refreshAlbumNames(tx, account, captured.trackKeys, albumIds)
    const [target] = now?.albumId
      ? await readChangeRecords(tx, 'album', [now.albumId])
      : []
    return recordChange(
      tx,
      {
        kind: 'album',
        action: input.action === 'unlink' ? 'separate' : 'rematch',
        target: target ?? null,
        sources: await readChangeRecords(
          tx,
          'album',
          unique([previous?.albumId ?? null]).filter(
            (id) => id !== now?.albumId,
          ),
        ),
        details: { counts: { 'album-name': 1 }, ...label },
      },
      { effects: effect ? [effect] : [] },
    )
  })
}
