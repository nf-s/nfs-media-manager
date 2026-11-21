import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { LastfmLinkUpdate } from '@repo/schemas/lastfm'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
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
import {
  readAlbumNames,
  type AlbumNameState,
  type FollowPlan,
} from './merge-follows'
import { refreshTrackAddedDates } from './spotify-playlists'
import { removeEmptyTracks } from './track-archive'

export {
  albumNameKeys,
  readAlbumNames,
  readFollowPlan,
  type AlbumNameState,
  type FollowedName,
  type FollowPlan,
} from './merge-follows'

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
